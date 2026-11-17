import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  compilePlan,
  defaultGear,
  defaultIntent,
  defaultScene,
  type Family,
  type PlanVersion,
  type Point,
} from "../../../src/domain";
import { PlanningInputSchema } from "../../../src/server/planner";
import { gradePlan, provenUnsupported, type Task } from "../next/grade";
import { search } from "../next/search";

export const validationDatasetVersion = "flowblock-controlled-transfer-v1";
export const validationSeed = 2026102907;
export const validationConditions = [
  "original",
  "paraphrase",
  "geometry-perturbation",
  "unsupported",
] as const;
export type ValidationCondition = (typeof validationConditions)[number];
const families: Family[] = [
  "hold",
  "push-in",
  "pull-out",
  "lateral",
  "orbit",
  "reveal",
];
const topologies = ["u-shaped", "trapezoid", "offset-alcove"] as const;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const round = (value: number) => Math.round(value * 1000) / 1000;

function pointAt(plan: PlanVersion, t: number): Point {
  const p = plan.path;
  if (p.kind === "arc") {
    const angle = p.startAngle + t * p.sweepAngle;
    return {
      x: p.center.x + p.radius * Math.sin(angle),
      z: p.center.z + p.radius * Math.cos(angle),
    };
  }
  return {
    x: p.start.x + t * (p.end.x - p.start.x),
    z: p.start.z + t * (p.end.z - p.start.z),
  };
}
function segmentDistance(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x,
    dz = b.z - a.z,
    length2 = dx * dx + dz * dz;
  const t = length2
    ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2))
    : 0;
  return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
}
function inside(p: Point, polygon: Point[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.z > p.z !== b.z > p.z &&
      p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x
    )
      result = !result;
  }
  return result;
}

/** Independent sampled diagnostic; it is not a continuous collision proof. */
export function independentlyCheckPlan(task: Task, plan: PlanVersion) {
  const { scene, gear, intent } = task.input;
  const checks: Record<string, boolean> = {
    source:
      isDeepStrictEqual(plan.scene, scene) &&
      isDeepStrictEqual(plan.gear, gear) &&
      isDeepStrictEqual(plan.intent, intent),
    family: plan.family === task.briefSpec.family,
    duration: Math.abs(plan.durationSeconds - intent.durationSeconds) < 0.001,
    height:
      Math.abs(plan.cameraHeight - intent.cameraHeight) < 0.01 &&
      plan.cameraHeight >= gear.minHeight &&
      plan.cameraHeight <= gear.maxHeight,
    endpoints: [0, 1].every((t) => {
      const point = pointAt(plan, t),
        declared = t === 0 ? plan.path.start : plan.path.end;
      return Math.hypot(point.x - declared.x, point.z - declared.z) < 1e-6;
    }),
    camera_boundary: true,
    operator_boundary: true,
    camera_obstacles: true,
    operator_obstacles: true,
    motion: true,
    direction: true,
    equipment: true,
  };
  const margin = scene.measurementUncertainty + gear.uncertaintyMargin;
  const boxes = [...scene.obstacles, scene.subject];
  let sampledLength = 0,
    previous = pointAt(plan, 0);
  for (let i = 0; i <= 200; i++) {
    const camera = pointAt(plan, i / 200);
    sampledLength += Math.hypot(camera.x - previous.x, camera.z - previous.z);
    previous = camera;
    const dx = camera.x - scene.subject.center.x,
      dz = camera.z - scene.subject.center.z,
      distance = Math.hypot(dx, dz);
    const operator = {
      x: camera.x + (gear.operatorOffset * dx) / distance,
      z: camera.z + (gear.operatorOffset * dz) / distance,
    };
    for (const [name, point, radius] of [
      ["camera", camera, gear.cameraRadius + margin],
      ["operator", operator, gear.operatorRadius + margin],
    ] as const) {
      checks[`${name}_boundary`] &&=
        Number.isFinite(point.x) &&
        Number.isFinite(point.z) &&
        inside(point, scene.boundary) &&
        scene.boundary.every(
          (a, index) =>
            segmentDistance(
              point,
              a,
              scene.boundary[(index + 1) % scene.boundary.length],
            ) > radius,
        );
      checks[`${name}_obstacles`] &&= boxes.every((box) => {
        const angle = (box.yawDeg * Math.PI) / 180,
          dx = point.x - box.center.x,
          dz = point.z - box.center.z;
        const localX = dx * Math.cos(angle) + dz * Math.sin(angle),
          localZ = -dx * Math.sin(angle) + dz * Math.cos(angle);
        return (
          Math.hypot(
            Math.max(0, Math.abs(localX) - box.width / 2),
            Math.max(0, Math.abs(localZ) - box.depth / 2),
          ) > radius
        );
      });
    }
  }
  const start = pointAt(plan, 0),
    end = pointAt(plan, 1),
    middle = pointAt(plan, 0.5),
    subject = scene.subject.center;
  const radial = (p: Point) => Math.hypot(p.x - subject.x, p.z - subject.z);
  const family = task.briefSpec.family;
  checks.motion =
    family === "hold"
      ? sampledLength < 0.001
      : sampledLength >= task.briefSpec.minimumTravel - 1e-5;
  if (family === "push-in")
    checks.direction =
      radial(start) - radial(end) >= task.briefSpec.minimumTravel - 1e-6;
  if (family === "pull-out")
    checks.direction =
      radial(end) - radial(start) >= task.briefSpec.minimumTravel - 1e-6;
  if (family === "orbit")
    checks.motion &&=
      plan.path.kind === "arc" &&
      (Math.abs(plan.path.sweepAngle) * 180) / Math.PI >=
        task.briefSpec.minimumOrbitDegrees - 1e-6;
  if (task.briefSpec.direction !== "either") {
    const bearing = Math.atan2(middle.x - subject.x, middle.z - subject.z);
    const tangent =
      (end.x - start.x) * Math.cos(bearing) -
      (end.z - start.z) * Math.sin(bearing);
    checks.direction =
      task.briefSpec.direction === "right" ? tangent > 0.01 : tangent < -0.01;
  }
  checks.equipment = gear.stabilizer !== "tripod" || sampledLength < 0.001;
  return {
    valid: Object.values(checks).every(Boolean),
    checks,
    sampledPositions: 201,
    sampledLength,
    limitations:
      "Independent arithmetic and polygon checks at 201 poses; no optics check or guarantee between poses.",
  };
}

function brief(
  family: Family,
  direction: "left" | "right",
  paraphrase: boolean,
) {
  const movement: Record<Family, [string, string]> = {
    hold: [
      "Keep the camera stationary for a product hero shot.",
      "Film a locked-off view of the product. The camera must not move.",
    ],
    "push-in": [
      "Push toward the product, increasing its apparent size.",
      "Finish nearer the product than you started so it looks larger. Move straight toward it.",
    ],
    "pull-out": [
      "Pull away from the product, decreasing its apparent size.",
      "Start near the product and retreat in a straight line so it looks smaller at the end.",
    ],
    lateral: [
      `Move ${direction} as you face the product in a straight lateral slide.`,
      `Track sideways to your ${direction} while facing the product, on a straight path.`,
    ],
    orbit: [
      `Orbit ${direction} around the product by at least 20 degrees.`,
      `Travel on a circular arc to your ${direction} around the product, covering 20 degrees or more.`,
    ],
    reveal: [
      `Make an angled ${direction} slide into the hero view. No foreground hiding is requested.`,
      `Enter the hero composition on a diagonal slide to your ${direction}. Keep the product visible throughout; do not use a foreground occluder.`,
    ],
  };
  return `${movement[family][Number(paraphrase)]} ${family === "hold" ? "" : "Travel at least 0.10 m. "}Preserve the declared camera height, duration, gear, room and framing bands. Keep the full product in frame. If the setup cannot perform the move, explain the constraint without substituting another move.`;
}

export function buildValidationSuite() {
  let state = validationSeed >>> 0;
  const uniform = (low: number, high: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return round(low + ((high - low) * state) / 4294967296);
  };
  const tasks: Task[] = [];
  const conditions: Record<string, ValidationCondition> = {};
  const witnesses: Record<string, PlanVersion> = {};
  const construction: Array<Record<string, unknown>> = [];
  for (let group = 0; group < 12; group++) {
    const sceneGroup = `validation-${String(group).padStart(2, "0")}`,
      family = families[Math.floor(group / 2)],
      topology = topologies[group % topologies.length],
      direction = group % 2 === 0 ? "left" : "right";
    let accepted = false;
    for (let attempt = 0; attempt < 30 && !accepted; attempt++) {
      const scene = structuredClone(defaultScene),
        gear = structuredClone(defaultGear),
        w = uniform(3.1, 4.1),
        back = uniform(2.7, 3.7),
        front = uniform(3.2, 4.4);
      scene.id = sceneGroup;
      scene.name = `Synthetic ${topology} ${sceneGroup}`;
      scene.boundary =
        topology === "trapezoid"
          ? [
              { x: -w, z: -back },
              { x: w * 0.7, z: -back },
              { x: w, z: front },
              { x: -w * 0.75, z: front },
            ]
          : topology === "u-shaped"
            ? [
                { x: -w, z: -back },
                { x: w, z: -back },
                { x: w, z: front },
                { x: 0.8, z: front },
                { x: 0.8, z: 1.7 },
                { x: -0.8, z: 1.7 },
                { x: -0.8, z: front },
                { x: -w, z: front },
              ]
            : [
                { x: -w, z: -back },
                { x: w, z: -back },
                { x: w, z: 0.5 },
                { x: w + 1.2, z: 0.5 },
                { x: w + 1.2, z: 2.4 },
                { x: w, z: 2.4 },
                { x: w, z: front },
                { x: -w, z: front },
              ];
      scene.subject.width = uniform(0.18, 0.32);
      scene.subject.depth = uniform(0.14, 0.25);
      scene.subject.height = uniform(0.28, 0.43);
      scene.subject.yawDeg = uniform(-45, 45);
      scene.subject.name = "Synthetic product box";
      scene.measurementUncertainty = uniform(0.015, 0.035);
      scene.obstacles = [
        {
          ...scene.obstacles[0],
          width: 0.65,
          depth: 0.5,
          yawDeg: uniform(-20, 20),
        },
      ];
      scene.lights = [];
      gear.lens = {
        kind: "equivalent",
        focalLengthMm: [35, 50, 65][group % 3],
      };
      gear.aspectRatio = group % 2 ? "portrait" : "landscape";
      gear.operatorOffset = uniform(0.3, 0.45);
      const intent = {
        ...defaultIntent,
        durationSeconds: [6, 8, 10][group % 3],
        cameraHeight: round(
          scene.subject.baseHeight + scene.subject.height / 2 + 0.15,
        ),
        brief: brief(family, direction, false),
        framingTargets: {
          start: [0.2, 0.6] as [number, number],
          end: [0.2, 0.6] as [number, number],
        },
      };
      const original: Task = {
        id: `${sceneGroup}-original`,
        sceneGroup,
        split: "confirmation",
        topology,
        geometryHash: hash({ ...scene, id: "", name: "" }),
        input: PlanningInputSchema.parse({
          scene,
          gear,
          intent,
          prompt: intent.brief,
        }),
        briefSpec: {
          family,
          direction: ["lateral", "orbit", "reveal"].includes(family)
            ? direction
            : "either",
          minimumTravel: family === "hold" ? 0 : 0.1,
          minimumOrbitDegrees: family === "orbit" ? 20 : 0,
          requiresForegroundOcclusion: false,
        },
        provenance: { kind: "authored-synthetic", seed: validationSeed },
      };
      const found = search(original.input, { family, maxCandidates: 128 });
      const witness = found.plans.find(
        (plan) =>
          gradePlan(original, plan).productive &&
          independentlyCheckPlan(original, plan).valid,
      );
      if (!witness) {
        construction.push({
          sceneGroup,
          attempt,
          accepted: false,
          reason: "no-original-witness",
          sampledCandidates: found.sampledCandidates,
          task: original,
        });
        continue;
      }
      const changed = structuredClone(original);
      changed.id = `${sceneGroup}-geometry-perturbation`;
      const midpoint = pointAt(witness, 0.5),
        radial = Math.hypot(
          midpoint.x - scene.subject.center.x,
          midpoint.z - scene.subject.center.z,
        );
      changed.input.scene.obstacles.push({
        id: "counterfactual-stand",
        name: "Fixed equipment stand",
        center: {
          x:
            midpoint.x +
            (gear.operatorOffset * (midpoint.x - scene.subject.center.x)) /
              radial,
          z:
            midpoint.z +
            (gear.operatorOffset * (midpoint.z - scene.subject.center.z)) /
              radial,
        },
        width: 0.4,
        depth: 0.4,
        height: 2,
        baseHeight: 0,
        yawDeg: 25,
      });
      changed.geometryHash = hash({ ...changed.input.scene, id: "", name: "" });
      const invalidated = compilePlan(
        changed.input.scene,
        changed.input.gear,
        changed.input.intent,
        witness.recipeId,
        witness.overrides,
      );
      const alternate = search(changed.input, { family, maxCandidates: 128 });
      const alternative = alternate.plans.find(
        (plan) =>
          gradePlan(changed, plan).productive &&
          independentlyCheckPlan(changed, plan).valid,
      );
      if (invalidated.validation.valid || !alternative) {
        construction.push({
          sceneGroup,
          attempt,
          accepted: false,
          reason: "no-alternative-witness",
          originalInvalidated: !invalidated.validation.valid,
          sampledCandidates: alternate.sampledCandidates,
          task: original,
          perturbation: changed,
        });
        continue;
      }
      const paraphrase = structuredClone(original);
      paraphrase.id = `${sceneGroup}-paraphrase`;
      paraphrase.input.intent.brief = paraphrase.input.prompt = brief(
        family,
        direction,
        true,
      );
      const paraphraseWitness = compilePlan(
        paraphrase.input.scene,
        paraphrase.input.gear,
        paraphrase.input.intent,
        witness.recipeId,
        witness.overrides,
      );
      const unsupported = structuredClone(original);
      unsupported.id = `${sceneGroup}-unsupported`;
      if (family === "hold")
        unsupported.input.gear.maxHeight = round(intent.cameraHeight - 0.2);
      else unsupported.input.gear.stabilizer = "tripod";
      if (!provenUnsupported(unsupported))
        throw new Error(
          "Unsupported fixture lacks a proven equipment limitation.",
        );
      for (const [condition, task, plan] of [
        ["original", original, witness],
        ["paraphrase", paraphrase, paraphraseWitness],
        ["geometry-perturbation", changed, alternative],
        ["unsupported", unsupported, undefined],
      ] as const) {
        PlanningInputSchema.parse(task.input);
        if (
          plan &&
          (!gradePlan(task, plan).productive ||
            !independentlyCheckPlan(task, plan).valid)
        )
          throw new Error(`Witness failed for ${task.id}.`);
        tasks.push(task);
        conditions[task.id] = condition;
        if (plan) witnesses[task.id] = plan;
      }
      construction.push({
        sceneGroup,
        attempt,
        accepted: true,
        topology,
        family,
        originalCandidates: found.sampledCandidates,
        perturbedCandidates: alternate.sampledCandidates,
        originalWitnessInvalidated: true,
        unsupportedReason: provenUnsupported(unsupported),
        witnessIds: [witness.id, paraphraseWitness.id, alternative.id],
      });
      accepted = true;
    }
    if (!accepted)
      throw new Error(
        `No witnessed construction for ${sceneGroup}; do not run the incomplete suite.`,
      );
  }
  return {
    datasetVersion: validationDatasetVersion,
    seed: validationSeed,
    tasks,
    conditions,
    witnesses,
    construction,
    metadata: {
      groups: 12,
      tasks: 48,
      supportedTasks: 36,
      unsupportedTasks: 12,
      topologies,
      selection:
        "Controlled solver-selected positive cases with matched paraphrases, path-blocking perturbations and explicit equipment limitations. No model output is used in construction.",
      limitations: [
        "Authored synthetic rooms and briefs, not real-world prevalence or creator benefit.",
        "The three topology templates are new to this campaign; their geometry still comes from the same application schema.",
        "The primary checker shares the application compiler. The independent check samples geometry and movement only; it does not validate optics or certify continuous clearance.",
        "Twelve scene groups provide limited precision. Conditions and repeated generations within a group are dependent.",
      ],
    },
  };
}
