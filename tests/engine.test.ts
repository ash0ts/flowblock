import { describe, expect, it } from "vitest";
import {
  AgentActionSchema,
  GearSchema,
  IntentSchema,
  OverridesSchema,
  SceneSchema,
  compilePlan,
  defaultGear,
  defaultIntent,
  defaultScene,
  deriveFov,
  MAX_APPROXIMATION_ERROR,
  planShots,
  recipes,
  samplePlan,
  targetAtTime,
  validatePlan,
  validateScene,
  type Box,
  type Intent,
  type Scene,
} from "../src/domain";
import {
  boxCorners,
  distance,
  pointInPolygon,
  pointSegmentDistance,
  polygonProblems,
  segmentBoundaryDistance,
  segmentDistance,
  segmentPolygonDistance,
} from "../src/domain/geometry";

const clone = <T>(value: T): T => structuredClone(value);
const makeBox = (
  x: number,
  z: number,
  width = 0.1,
  depth = 0.1,
  yawDeg = 0,
): Box => ({
  id: "test-obstacle",
  name: "Test obstacle",
  center: { x, z },
  width,
  depth,
  height: 2,
  baseHeight: 0,
  yawDeg,
});
const openScene = (): Scene => ({
  ...clone(defaultScene),
  obstacles: [],
  boundary: [
    { x: -20, z: -20 },
    { x: 20, z: -20 },
    { x: 20, z: 20 },
    { x: -20, z: 20 },
  ],
});
const coverageIntent: Intent = {
  ...defaultIntent,
  framingTargets: { start: [0.01, 1], end: [0.01, 1] },
};
function assertFiniteTree(value: unknown) {
  if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
  else if (Array.isArray(value)) value.forEach(assertFiniteTree);
  else if (value && typeof value === "object")
    Object.values(value).forEach(assertFiniteTree);
}

describe("108 deterministic recipe, framing and duration scenarios", () => {
  for (const recipe of recipes)
    for (const framing of ["wide", "medium", "close"] as const)
      for (const durationSeconds of [2, 8, 60]) {
        it(`${recipe.id}, ${framing}, ${durationSeconds}s`, () => {
          const intent = { ...defaultIntent, framing, durationSeconds };
          const input = JSON.stringify({
            scene: defaultScene,
            gear: defaultGear,
            intent,
          });
          const plan = compilePlan(
            defaultScene,
            defaultGear,
            intent,
            recipe.id,
          );
          const repeated = compilePlan(
            defaultScene,
            defaultGear,
            intent,
            recipe.id,
          );
          expect(plan).toEqual(repeated);
          expect(
            JSON.stringify({ scene: defaultScene, gear: defaultGear, intent }),
          ).toBe(input);
          expect(Object.isFrozen(plan.scene.subject.center)).toBe(true);
          expect(plan.durationSeconds).toBe(durationSeconds);
          expect(plan.keyframes).toHaveLength(41);
          expect(plan.validation.approximationError).toBeLessThanOrEqual(
            MAX_APPROXIMATION_ERROR + 1e-12,
          );
          assertFiniteTree(plan);
          for (const t of [0, 0.13, 0.5, 0.91, 1]) {
            const sample = samplePlan(plan, t);
            expect(sample.timeSeconds).toBeCloseTo(t * durationSeconds);
            expect(distance(sample.position, sample.operator)).toBeCloseTo(
              defaultGear.operatorOffset,
            );
            expect(sample.position.y).toBe(plan.cameraHeight);
            assertFiniteTree(sample);
          }
          expect(samplePlan(plan, 0).position.x).toBeCloseTo(plan.path.start.x);
          expect(samplePlan(plan, 1).position.z).toBeCloseTo(plan.path.end.z);
          expect(validatePlan(plan)).toEqual(plan.validation);
        });
      }
});

describe("schema boundaries", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    it(`rejects ${String(bad)} in scene, gear, intent and overrides`, () => {
      expect(
        SceneSchema.safeParse({ ...defaultScene, measurementUncertainty: bad })
          .success,
      ).toBe(false);
      expect(
        GearSchema.safeParse({ ...defaultGear, operatorOffset: bad }).success,
      ).toBe(false);
      expect(
        IntentSchema.safeParse({ ...defaultIntent, durationSeconds: bad })
          .success,
      ).toBe(false);
      expect(OverridesSchema.safeParse({ distance: bad }).success).toBe(false);
    });
  }
  for (const t of [-0.00001, 1.00001, NaN, Infinity])
    it(`rejects playback outside its domain: ${String(t)}`, () =>
      expect(() =>
        samplePlan(
          compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold"),
          t,
        ),
      ).toThrow());
  it("does not clamp negative dimensions, duration, or travel", () => {
    expect(() =>
      compilePlan(
        defaultScene,
        defaultGear,
        { ...defaultIntent, durationSeconds: 1 },
        "hero-hold",
      ),
    ).toThrow();
    expect(() =>
      compilePlan(defaultScene, defaultGear, defaultIntent, "gentle-push", {
        travel: -1,
      }),
    ).toThrow();
    expect(() =>
      compilePlan(
        { ...defaultScene, subject: { ...defaultScene.subject, width: -1 } },
        defaultGear,
        defaultIntent,
        "hero-hold",
      ),
    ).toThrow();
  });
  it("rejects unknown recipe IDs and unknown input keys", () => {
    expect(() =>
      compilePlan(
        defaultScene,
        defaultGear,
        defaultIntent,
        "teleport" as never,
      ),
    ).toThrow();
    expect(
      OverridesSchema.safeParse({ distance: 1, secretlyMoveObstacle: true })
        .success,
    ).toBe(false);
    expect(SceneSchema.safeParse({ ...defaultScene, camera: {} }).success).toBe(
      false,
    );
  });
  it("rejects inverted framing bands and gear height ranges", () => {
    expect(
      IntentSchema.safeParse({
        ...defaultIntent,
        framingTargets: { start: [0.8, 0.2], end: [0.4, 0.6] },
      }).success,
    ).toBe(false);
    expect(
      GearSchema.safeParse({ ...defaultGear, minHeight: 2, maxHeight: 1 })
        .success,
    ).toBe(false);
  });
  it("only accepts the agent tool allowlist", () => {
    for (const action of ["set_gear", "move_obstacle", "execute", "eval"])
      expect(
        AgentActionSchema.safeParse({ action, code: "noop" }).success,
      ).toBe(false);
    expect(
      AgentActionSchema.safeParse({
        action: "compile_candidate",
        recipeId: "gentle-push",
        overrides: { durationSeconds: 10 },
      }).success,
    ).toBe(true);
    expect(
      AgentActionSchema.safeParse({
        action: "propose_revision",
        overrides: { distance: 2 },
        reason: "Framing correction",
        findingIds: [],
      }).success,
    ).toBe(false);
  });
});

describe("lens projection and playback", () => {
  it("derives physical FOV and equivalent lens FOV consistently", () => {
    const equivalent = deriveFov(defaultGear);
    const physical = deriveFov({
      ...defaultGear,
      lens: {
        kind: "physical",
        focalLengthMm: 50,
        sensorWidthMm: 36,
        sensorHeightMm: 24,
      },
    });
    expect(physical).toEqual(equivalent);
    expect(equivalent.horizontalDeg).toBeCloseTo(
      (2 * Math.atan(36 / 100) * 180) / Math.PI,
    );
  });
  it("rotates portrait and crops square FOV without stretching", () => {
    const landscape = deriveFov(defaultGear),
      portrait = deriveFov({ ...defaultGear, aspectRatio: "portrait" }),
      square = deriveFov({ ...defaultGear, aspectRatio: "square" });
    expect(portrait.horizontalDeg).toBeCloseTo(landscape.verticalDeg);
    expect(portrait.verticalDeg).toBeCloseTo(landscape.horizontalDeg);
    expect(square.horizontalDeg).toBe(square.verticalDeg);
  });
  it("reduces FOV when focal length increases", () => {
    expect(
      deriveFov({
        ...defaultGear,
        lens: { kind: "equivalent", focalLengthMm: 85 },
      }).horizontalDeg,
    ).toBeLessThan(deriveFov(defaultGear).horizontalDeg);
  });
  it("solves the projected product dimensions for requested framing", () => {
    const plan = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "hero-hold",
    );
    expect(plan.framing.startCoverage).toBeCloseTo(0.425, 7);
    expect(plan.validation.valid).toBe(true);
    const large = compilePlan(
      { ...defaultScene, subject: { ...defaultScene.subject, height: 0.7 } },
      defaultGear,
      defaultIntent,
      "hero-hold",
    );
    expect(large.path.radius).toBeGreaterThan(plan.path.radius);
  });
  it("accounts for product rotation in projected width", () => {
    const scene = openScene();
    scene.subject.width = 0.8;
    scene.subject.depth = 0.1;
    const a = compilePlan(scene, defaultGear, coverageIntent, "hero-hold", {
      distance: 2,
    });
    scene.subject.yawDeg = 90;
    const b = compilePlan(scene, defaultGear, coverageIntent, "hero-hold", {
      distance: 2,
    });
    expect(samplePlan(a, 0).framingBox.width).toBeGreaterThan(
      samplePlan(b, 0).framingBox.width,
    );
  });
  for (const recipeId of [
    "gentle-push",
    "left-slide",
    "quarter-orbit",
  ] as const)
    it(`uses equal arc-length playback steps for ${recipeId}`, () => {
      const plan = compilePlan(
        defaultScene,
        defaultGear,
        defaultIntent,
        recipeId,
      );
      const lengths = Array.from({ length: 10 }, (_, i) =>
        distance(
          samplePlan(plan, i / 10).position,
          samplePlan(plan, (i + 1) / 10).position,
        ),
      );
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(1e-12);
      if (plan.path.kind === "arc")
        expect(plan.arcLength).toBeCloseTo(
          Math.abs(plan.path.radius * plan.path.sweepAngle),
        );
      else
        expect(plan.arcLength).toBeCloseTo(
          distance(plan.path.start, plan.path.end),
        );
    });
  it("reverses geometry without mutating the original plan", () => {
    const a = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "quarter-orbit",
    );
    const b = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "quarter-orbit",
      { reverse: true },
    );
    for (const t of [0, 0.2, 0.7, 1]) {
      expect(samplePlan(a, t).position.x).toBeCloseTo(
        samplePlan(b, 1 - t).position.x,
      );
      expect(samplePlan(a, t).position.z).toBeCloseTo(
        samplePlan(b, 1 - t).position.z,
      );
    }
    expect(a.id).not.toBe(b.id);
  });
  it("interpolates temporal target bands and rejects out-of-range times", () => {
    const plan = compilePlan(
      defaultScene,
      defaultGear,
      {
        ...defaultIntent,
        framingTargets: { start: [0.2, 0.4], end: [0.5, 0.7] },
      },
      "gentle-push",
    );
    expect(targetAtTime(plan, 4).coverageBand[0]).toBeCloseTo(0.35);
    expect(targetAtTime(plan, 4).coverageBand[1]).toBeCloseTo(0.55);
    expect(() => targetAtTime(plan, 8.001)).toThrow();
  });
  it("makes detached immutable source snapshots", () => {
    const scene = clone(defaultScene),
      gear = clone(defaultGear),
      intent = clone(defaultIntent);
    const plan = compilePlan(scene, gear, intent, "hero-hold");
    scene.subject.center.x = 8;
    gear.operatorRadius = 0.8;
    intent.durationSeconds = 20;
    expect(plan.scene.subject.center.x).toBe(0);
    expect(plan.gear.operatorRadius).toBe(0.28);
    expect(plan.durationSeconds).toBe(8);
  });
});

describe("conservative continuous swept envelopes", () => {
  it("detects a narrow obstacle between valid start and end positions", () => {
    const scene = openScene();
    scene.obstacles = [makeBox(0, 2, 0.01, 0.01)];
    const gear = {
      ...defaultGear,
      cameraRadius: 0.01,
      operatorRadius: 0.01,
      uncertaintyMargin: 0,
    };
    scene.measurementUncertainty = 0;
    const plan = compilePlan(scene, gear, coverageIntent, "left-slide", {
      distance: 2,
      travel: 2,
    });
    expect(
      segmentPolygonDistance(
        plan.path.start,
        plan.path.start,
        boxCorners(scene.obstacles[0]),
      ),
    ).toBeGreaterThan(0.9);
    expect(
      segmentPolygonDistance(
        plan.path.end,
        plan.path.end,
        boxCorners(scene.obstacles[0]),
      ),
    ).toBeGreaterThan(0.9);
    expect(
      plan.validation.violations.some((v) => v.code === "camera_obstacle"),
    ).toBe(true);
  });
  it("detects the operator behind a camera that clears the obstacle", () => {
    const scene = openScene();
    scene.obstacles = [makeBox(0, 2.45, 0.1, 0.1)];
    const plan = compilePlan(scene, defaultGear, coverageIntent, "hero-hold", {
      distance: 2,
    });
    expect(
      plan.validation.violations.some((v) => v.code === "operator_obstacle"),
    ).toBe(true);
    expect(
      plan.validation.violations.some(
        (v) => v.code === "camera_obstacle" && v.obstacleId === "test-obstacle",
      ),
    ).toBe(false);
  });
  it("includes measurement and handling uncertainty additively", () => {
    const scene = openScene();
    scene.obstacles = [makeBox(0.3, 2, 0.1, 0.1)];
    scene.measurementUncertainty = 0;
    const gear = {
      ...defaultGear,
      operatorOffset: 0,
      operatorRadius: 0.01,
      cameraRadius: 0.1,
      uncertaintyMargin: 0,
    };
    expect(
      compilePlan(scene, gear, coverageIntent, "hero-hold", { distance: 2 })
        .validation.valid,
    ).toBe(true);
    scene.measurementUncertainty = 0.1;
    gear.uncertaintyMargin = 0.06;
    expect(
      compilePlan(scene, gear, coverageIntent, "hero-hold", { distance: 2 })
        .validation.valid,
    ).toBe(false);
  });
  it("rejects tangent contact instead of treating touching as clearance", () => {
    const scene = openScene();
    scene.measurementUncertainty = 0;
    scene.obstacles = [makeBox(0.2, 2, 0.2, 0.2)];
    const plan = compilePlan(
      scene,
      {
        ...defaultGear,
        cameraRadius: 0.1,
        uncertaintyMargin: 0,
        operatorRadius: 0,
        operatorOffset: 0,
      },
      coverageIntent,
      "hero-hold",
      { distance: 2 },
    );
    expect(
      plan.validation.violations.some((v) => v.code === "camera_obstacle"),
    ).toBe(true);
  });
  it("respects rotated obstacle corners", () => {
    const scene = openScene();
    scene.obstacles = [makeBox(0.25, 2, 0.5, 0.02, 45)];
    const plan = compilePlan(scene, defaultGear, coverageIntent, "hero-hold", {
      distance: 2,
    });
    expect(plan.validation.valid).toBe(false);
  });
  it("rejects an arc that exits the boundary between valid endpoints", () => {
    const scene = openScene();
    scene.boundary = [
      { x: -5, z: -5 },
      { x: 5, z: -5 },
      { x: 5, z: 1.8 },
      { x: -5, z: 1.8 },
    ];
    const gear = {
      ...defaultGear,
      cameraRadius: 0.01,
      operatorRadius: 0.01,
      operatorOffset: 0,
      uncertaintyMargin: 0,
    };
    scene.measurementUncertainty = 0;
    const plan = compilePlan(scene, gear, coverageIntent, "quarter-orbit", {
      distance: 2,
      orbitDegrees: 120,
    });
    expect(pointInPolygon(plan.path.start, scene.boundary)).toBe(true);
    expect(pointInPolygon(plan.path.end, scene.boundary)).toBe(true);
    expect(
      plan.validation.violations.some((v) => v.code === "camera_boundary"),
    ).toBe(true);
  });
  it("rejects a straight path through a concave boundary notch", () => {
    const scene = openScene();
    scene.boundary = [
      { x: -4, z: -4 },
      { x: 4, z: -4 },
      { x: 4, z: 4 },
      { x: 0.1, z: 4 },
      { x: 0.1, z: 1.8 },
      { x: -0.1, z: 1.8 },
      { x: -0.1, z: 4 },
      { x: -4, z: 4 },
    ];
    const plan = compilePlan(scene, defaultGear, coverageIntent, "left-slide", {
      distance: 2,
      travel: 3,
    });
    expect(
      plan.validation.violations.some((v) => v.code === "camera_boundary"),
    ).toBe(true);
  });
  it("rejects invalid polygons and duplicate object IDs", () => {
    const scene = openScene();
    scene.boundary = [
      { x: 0, z: 0 },
      { x: 2, z: 2 },
      { x: 0, z: 2 },
      { x: 2, z: 0 },
    ];
    expect(
      validateScene(scene).some((v) => v.code === "invalid_boundary"),
    ).toBe(true);
    expect(
      polygonProblems([
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: 1, z: 0 },
        { x: 0, z: 1 },
      ]).length,
    ).toBeGreaterThan(0);
    scene.obstacles = [{ ...scene.subject }];
    expect(
      validateScene(scene).some((v) => v.code === "duplicate_object_id"),
    ).toBe(true);
  });
  it("rejects paths through the subject center and never emits NaN", () => {
    const plan = compilePlan(
      openScene(),
      defaultGear,
      coverageIntent,
      "gentle-push",
      { distance: 1, travel: 4 },
    );
    expect(plan.validation.valid).toBe(false);
    expect(
      plan.validation.violations.some(
        (v) => v.code === "undefined_view_direction",
      ),
    ).toBe(true);
    assertFiniteTree(plan);
  });
  for (const recipe of ["left-slide", "quarter-orbit"] as const)
    it(`bounds camera and operator chord approximation for ${recipe}`, () => {
      const plan = compilePlan(
        openScene(),
        defaultGear,
        coverageIntent,
        recipe,
        { distance: 1.5 },
      );
      const n = plan.validation.checkedSegments;
      for (let i = 0; i < n; i++) {
        const a = samplePlan(plan, i / n),
          b = samplePlan(plan, (i + 1) / n);
        for (let j = 0; j <= 20; j++) {
          const point = samplePlan(plan, (i + j / 20) / n);
          expect(
            pointSegmentDistance(point.position, a.position, b.position),
          ).toBeLessThanOrEqual(plan.validation.approximationError + 1e-10);
          expect(
            pointSegmentDistance(point.operator, a.operator, b.operator),
          ).toBeLessThanOrEqual(plan.validation.approximationError + 1e-10);
        }
      }
    });
});

describe("equipment and candidate ranking", () => {
  it("provides viable default candidates and all six families", () => {
    const plans = planShots(defaultScene, defaultGear, defaultIntent);
    expect(plans).toHaveLength(12);
    expect(new Set(plans.map((p) => p.family)).size).toBe(6);
    expect(
      plans.filter((p) => p.validation.valid).length,
    ).toBeGreaterThanOrEqual(6);
    const firstInvalid = plans.findIndex((p) => !p.validation.valid);
    if (firstInvalid !== -1)
      expect(plans.slice(firstInvalid).every((p) => !p.validation.valid)).toBe(
        true,
      );
  });
  it("reports unsupported tripod and slider movement", () => {
    expect(
      compilePlan(
        defaultScene,
        { ...defaultGear, stabilizer: "tripod" },
        defaultIntent,
        "gentle-push",
      ).validation.violations.some((v) => v.code === "tripod_translation"),
    ).toBe(true);
    expect(
      compilePlan(
        defaultScene,
        { ...defaultGear, stabilizer: "slider" },
        defaultIntent,
        "quarter-orbit",
      ).validation.violations.some((v) => v.code === "slider_arc"),
    ).toBe(true);
  });
  it("checks height and speed without changing requested values", () => {
    const plan = compilePlan(
      openScene(),
      defaultGear,
      { ...coverageIntent, durationSeconds: 2 },
      "left-slide",
      { travel: 4, distance: 2, height: 3 },
    );
    expect(plan.cameraHeight).toBe(3);
    expect(plan.arcLength).toBe(4);
    expect(plan.durationSeconds).toBe(2);
    expect(plan.validation.violations.map((v) => v.code)).toEqual(
      expect.arrayContaining(["camera_height", "camera_speed"]),
    );
  });
  it("rejects irrelevant overrides rather than silently ignoring them", () => {
    expect(
      compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold", {
        travel: 1,
      }).validation.violations.some((v) => v.code === "unused_travel"),
    ).toBe(true);
    expect(
      compilePlan(defaultScene, defaultGear, defaultIntent, "gentle-push", {
        orbitDegrees: 40,
      }).validation.violations.some((v) => v.code === "unused_orbit"),
    ).toBe(true);
  });
  it("revalidates source config instead of trusting a forged cached result", () => {
    const plan = clone(
      compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold"),
    );
    plan.scene.obstacles.push(makeBox(plan.path.start.x, plan.path.start.z));
    plan.validation.valid = true;
    expect(validatePlan(plan).valid).toBe(false);
  });
});

describe("60 deterministic rotated-obstacle differential scenarios", () => {
  let seed = 57293;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const cases = Array.from({ length: 60 }, (_, index) => ({
    index,
    x: rand() * 4 - 2,
    z: rand() * 3 + 0.5,
    width: rand() * 0.5 + 0.02,
    depth: rand() * 0.5 + 0.02,
    yaw: rand() * 180,
    radius: 1 + rand() * 2,
    sweep: rand() * 160 - 80,
  }));
  for (const c of cases)
    it(`swept validity never misses a dense sampled collision ${c.index}`, () => {
      const scene = openScene();
      scene.obstacles = [makeBox(c.x, c.z, c.width, c.depth, c.yaw)];
      const plan = compilePlan(
        scene,
        defaultGear,
        coverageIntent,
        c.index % 2 ? "quarter-orbit" : "left-slide",
        c.index % 2
          ? { distance: c.radius, orbitDegrees: c.sweep }
          : { distance: c.radius, travel: 2 },
      );
      const obstacle = boxCorners(scene.obstacles[0]);
      const uncertainty =
        scene.measurementUncertainty + defaultGear.uncertaintyMargin;
      let collision = false;
      for (let i = 0; i <= 300; i++) {
        const sample = samplePlan(plan, i / 300);
        if (
          segmentPolygonDistance(sample.position, sample.position, obstacle) <=
            defaultGear.cameraRadius + uncertainty ||
          segmentPolygonDistance(sample.operator, sample.operator, obstacle) <=
            defaultGear.operatorRadius + uncertainty
        )
          collision = true;
      }
      if (collision)
        expect(
          plan.validation.violations.some(
            (v) => v.obstacleId === "test-obstacle",
          ),
        ).toBe(true);
      expect(plan.validation.approximationError).toBeLessThanOrEqual(0.01);
    });
});

describe("geometry primitives", () => {
  it("handles parallel, degenerate and intersecting segments", () => {
    expect(
      segmentDistance(
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: 0, z: 1 },
        { x: 1, z: 1 },
      ),
    ).toBe(1);
    expect(
      segmentDistance(
        { x: 0, z: 0 },
        { x: 0, z: 0 },
        { x: 0, z: -1 },
        { x: 0, z: 1 },
      ),
    ).toBe(0);
    expect(
      segmentDistance(
        { x: -1, z: 0 },
        { x: 1, z: 0 },
        { x: 0, z: -1 },
        { x: 0, z: 1 },
      ),
    ).toBe(0);
  });
  it("supports either winding and rejects zero-area boundaries", () => {
    const polygon = openScene().boundary;
    expect(pointInPolygon({ x: 0, z: 0 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 0, z: 0 }, [...polygon].reverse())).toBe(true);
    expect(
      segmentBoundaryDistance({ x: 0, z: 0 }, { x: 0, z: 0 }, polygon),
    ).toBe(20);
    expect(
      polygonProblems([
        { x: 0, z: 0 },
        { x: 1, z: 0 },
        { x: 2, z: 0 },
      ]).length,
    ).toBeGreaterThan(0);
  });
});
