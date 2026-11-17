import { describe, expect, it, vi } from "vitest";
import {
  compilePlan,
  defaultGear,
  defaultIntent,
  defaultScene,
} from "../src/domain";
import {
  runPlanner,
  systemPrompt,
  type ChatResult,
  type PlannerMessage,
  type PlanningInput,
} from "../src/server/planner";
import {
  orbitDirectionContext,
  searchBearingRepairs,
} from "../src/server/planner-feedback";

const input = { scene: defaultScene, gear: defaultGear, intent: defaultIntent };
const reply = (action: unknown): ChatResult => ({
  content: JSON.stringify(action),
  usage: { inputTokens: 2, outputTokens: 1 },
});
const compile = { action: "compile_candidate", recipeId: "hero-hold" };
const hold = compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold");
const finish = {
  action: "finish",
  candidateIds: [hold.id],
  explanation: "A stationary hero shot.",
};
const empty = {
  action: "finish",
  candidateIds: [],
  explanation: "The checked move does not fit.",
};

// Geometry and rejected actions from Agent Lens case 20135b7e-725f-4cfe-9971-b84eba2a2d4e.
// The historical research result remains unchanged; this is a live-coordinator regression.
const recordedOrbit: PlanningInput = {
  scene: {
    id: "recorded-narrow-orbit",
    name: "Recorded narrow-room regression",
    boundary: [
      { x: -1.763, z: -2.365 },
      { x: 1.763, z: -2.365 },
      { x: 1.763, z: 3.121 },
      { x: -1.763, z: 3.121 },
    ],
    subject: {
      ...defaultScene.subject,
      width: 0.233,
      depth: 0.262,
      height: 0.373,
      baseHeight: 0.946,
      yawDeg: 8.613,
    },
    obstacles: [
      {
        id: "table",
        name: "Product table",
        center: { x: 0, z: 0 },
        width: 0.559,
        depth: 0.526,
        height: 0.946,
        baseHeight: 0,
        yawDeg: -3.719,
      },
      {
        id: "stand-0",
        name: "Fixed stand",
        center: { x: -0.465, z: 1.992 },
        width: 0.202,
        depth: 0.407,
        height: 2,
        baseHeight: 0,
        yawDeg: 7.875,
      },
    ],
    lights: [],
    measurementUncertainty: 0.023,
  },
  gear: {
    ...defaultGear,
    aspectRatio: "square",
    operatorRadius: 0.303,
    operatorOffset: 0.362,
    uncertaintyMargin: 0.036,
  },
  intent: {
    ...defaultIntent,
    brief:
      "Orbit right by at least 20 degrees while preserving camera height and duration.",
    durationSeconds: 10,
    cameraHeight: 1.237,
    motion: "dynamic",
    framingTargets: { start: [0.2, 0.6], end: [0.2, 0.6] },
  },
};

const blockedFrontOrbit: PlanningInput = {
  scene: {
    ...defaultScene,
    id: "blocked-front-orbit-regression",
    obstacles: [
      ...defaultScene.obstacles,
      {
        id: "equipment-case",
        name: "Fixed equipment case",
        center: { x: 0, z: 2.8 },
        width: 0.45,
        depth: 0.45,
        height: 0.6,
        baseHeight: 0,
        yawDeg: 0,
      },
    ],
  },
  gear: { ...defaultGear, lens: { kind: "equivalent", focalLengthMm: 24 } },
  intent: {
    ...defaultIntent,
    framing: "wide",
    durationSeconds: 5,
    brief:
      "Check the default quarter-orbit, preserving its 45-degree rightward movement; a different viewing side is permitted.",
  },
};

describe("bounded bearing repair handoff", () => {
  it("bounds requested compiles and internal repair work across one invocation", async () => {
    const compiler = vi.spyOn(await import("../src/domain"), "compilePlan");
    let calls = 0;
    try {
      const result = await runPlanner(input, {
        trace: false,
        chat: async () => {
          calls++;
          return reply(
            calls <= 3
              ? compile
              : {
                  action: "compile_candidate",
                  recipeId: "quarter-orbit",
                  overrides: { distance: 0.1, bearingDeg: calls - 4 },
                },
          );
        },
      });
      expect(calls).toBe(6);
      expect(result.outcome).toBe("partial");
      expect(result.stopReason).toBe("repair_budget");
      expect(result.events).toHaveLength(6);
      const internal = result.events.reduce(
        (count, event) =>
          count +
          ((event.observation as { repairSearch?: { compileChecks: number } })
            .repairSearch?.compileChecks ?? 0),
        0,
      );
      expect(internal).toBe(36);
      expect(compiler).toHaveBeenCalledTimes(42);
      expect(result.plans.map((plan) => plan.id)).toEqual([hold.id]);
    } finally {
      compiler.mockRestore();
    }
  });

  it("finds checked alternatives for the actual blocked-front demo while preserving source facts and motion", () => {
    const before = JSON.stringify(blockedFrontOrbit);
    const initial = compilePlan(
      blockedFrontOrbit.scene,
      blockedFrontOrbit.gear,
      blockedFrontOrbit.intent,
      "quarter-orbit",
    );
    expect(initial.validation.violations).toContainEqual(
      expect.objectContaining({
        code: "operator_obstacle",
        obstacleId: "equipment-case",
      }),
    );
    const search = searchBearingRepairs(initial)!;
    expect(search.options).toHaveLength(3);
    expect(search.stopReason).toBe("three_valid_options");
    expect(search.compileChecks).toBe(search.trials.length);
    expect(search.compileChecks).toBeLessThanOrEqual(12);
    expect(
      search.trials.filter((trial) => !trial.valid).length,
    ).toBeGreaterThan(0);
    expect(
      new Set(search.trials.map((trial) => trial.overrides.bearingDeg)).size,
    ).toBe(search.compileChecks);
    expect(JSON.stringify(search)).not.toContain("candidateId");
    expect(JSON.stringify(search)).not.toContain("plan-");
    for (const option of search.options) {
      const p = compilePlan(
        initial.scene,
        initial.gear,
        initial.intent,
        option.recipeId,
        option.overrides,
      );
      expect(p.validation.valid).toBe(true);
      expect(p.recipeId).toBe(initial.recipeId);
      expect(p.family).toBe(initial.family);
      expect(p.scene).toEqual(initial.scene);
      expect(p.gear).toEqual(initial.gear);
      expect(p.intent).toEqual(initial.intent);
      expect(p.path.sweepAngle).toBe(initial.path.sweepAngle);
      expect(p.cameraHeight).toBe(initial.cameraHeight);
      expect(p.durationSeconds).toBe(initial.durationSeconds);
      expect(option.radiusMeters).toBe(p.path.radius);
      expect(option.framing).toEqual(p.framing);
      expect(option.overrides).toEqual({
        bearingDeg: option.overrides.bearingDeg,
      });
      expect(option.tradeoff).toContain("viewing side");
    }
    expect(JSON.stringify(blockedFrontOrbit)).toBe(before);
  });

  it.each([
    ["quarter-orbit", false, "camera-right", 45],
    ["quarter-orbit", true, "camera-left", -45],
    ["reverse-orbit", false, "camera-left", -45],
    ["reverse-orbit", true, "camera-right", 45],
  ] as const)(
    "reports actual %s traversal with reverse=%s separately from negative viewing bearings",
    (recipeId, reverse, direction, sweep) => {
      const initial = compilePlan(
        blockedFrontOrbit.scene,
        blockedFrontOrbit.gear,
        blockedFrontOrbit.intent,
        recipeId,
        { reverse },
      );
      const search = searchBearingRepairs(initial)!;
      expect(search.referenceOrbit).toMatchObject({
        direction,
        signedSweepDegrees: sweep,
      });
      expect(search.options.length).toBeGreaterThan(0);
      for (const option of search.options) {
        expect(option.overrides.bearingDeg).toBeLessThan(0);
        expect(option.overrides.reverse).toBe(reverse);
        expect(option.motion.orbit).toMatchObject({
          direction,
          signedSweepDegrees: sweep,
          referenceSweepDegrees: sweep,
          preservesSweep: true,
        });
        const compiled = compilePlan(
          initial.scene,
          initial.gear,
          initial.intent,
          recipeId,
          option.overrides,
        );
        const [start, next] = compiled.keyframes;
        const cameraRight = {
          x: start.position.z - compiled.path.center.z,
          z: -(start.position.x - compiled.path.center.x),
        };
        const sidewaysStep =
          (next.position.x - start.position.x) * cameraRight.x +
          (next.position.z - start.position.z) * cameraRight.z;
        expect(Math.sign(sidewaysStep)).toBe(
          direction === "camera-right" ? 1 : -1,
        );
        expect(
          option.motion.orbit!.endBearingDeg -
            option.motion.orbit!.startBearingDeg,
        ).toBeCloseTo(sweep, 10);
      }
    },
  );

  it("does not report a reversed sweep as preserved, or label a line as an orbit", () => {
    const original = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "quarter-orbit",
      { bearingDeg: -60 },
    );
    const reversed = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "quarter-orbit",
      { bearingDeg: -60, reverse: true },
    );
    expect(orbitDirectionContext(reversed, original)).toMatchObject({
      direction: "camera-left",
      signedSweepDegrees: -45,
      referenceSweepDegrees: 45,
      preservesSweep: false,
    });
    expect(orbitDirectionContext(hold)).toBeUndefined();
    expect(
      orbitDirectionContext(
        compilePlan(defaultScene, defaultGear, defaultIntent, "left-slide"),
      ),
    ).toBeUndefined();
  });

  it("allows a qualified abstention when the brief forbids the suggested viewing-side change", async () => {
    let calls = 0;
    const result = await runPlanner(
      {
        ...blockedFrontOrbit,
        intent: {
          ...blockedFrontOrbit.intent,
          brief:
            "Keep the front-centered orbit. A different viewing side is not permitted.",
        },
      },
      {
        trace: false,
        chat: async () =>
          reply(
            calls++ === 0
              ? { action: "compile_candidate", recipeId: "quarter-orbit" }
              : {
                  action: "finish",
                  candidateIds: [],
                  explanation:
                    "The checked front-centered path intersects the case. Search suggestions preserve the sweep but change the viewing side, which this brief forbids.",
                },
          ),
      },
    );
    expect(result.source).toBe("forge");
    expect(result.outcome).toBe("checked_abstention");
    expect(result.plans).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.message).toContain(
      "These checks do not prove all possible moves infeasible",
    );
  });

  it("requires the model to compile its chosen suggestion before finishing", async () => {
    let calls = 0;
    let selectedId: string | undefined;
    const result = await runPlanner(blockedFrontOrbit, {
      trace: false,
      chat: async (messages) => {
        calls++;
        if (calls === 1) {
          expect(messages[0].content).toContain(
            "Its sign does not reverse an orbit",
          );
          expect(messages[0].content).toContain(
            "When the brief explicitly permits changing the viewing side",
          );
          return reply({
            action: "compile_candidate",
            recipeId: "quarter-orbit",
          });
        }
        const observation = JSON.parse(messages.at(-1)!.content).observation;
        if (calls === 2) {
          expect(observation.motion.orbit).toMatchObject({
            direction: "camera-right",
            signedSweepDegrees: 45,
          });
          const option = observation.repairSearch.options[1];
          expect(option).not.toHaveProperty("candidateId");
          expect(option.overrides.bearingDeg).toBeLessThan(0);
          expect(option.motion.orbit).toMatchObject({
            direction: "camera-right",
            signedSweepDegrees: 45,
            preservesSweep: true,
          });
          return reply({
            action: "compile_candidate",
            recipeId: option.recipeId,
            overrides: option.overrides,
          });
        }
        selectedId = observation.candidateId;
        return reply({
          action: "finish",
          candidateIds: [selectedId],
          explanation:
            "The checked alternative keeps the orbit and changes the viewing side.",
        });
      },
    });
    expect(result.outcome).toBe("completed");
    expect(
      result.events.map((event) => (event.action as { action: string }).action),
    ).toEqual(["compile_candidate", "compile_candidate", "finish"]);
    expect(result.events[2].observation).toMatchObject({ compileChecks: 2 });
    expect(result.plans.map((plan) => plan.id)).toEqual([selectedId]);
    expect(result.events[0].observation).toMatchObject({
      repairSearch: { maxCompileChecks: 12 },
    });
  });

  it("does not turn unchosen suggestions into partial model plans", async () => {
    let calls = 0;
    const result = await runPlanner(blockedFrontOrbit, {
      trace: false,
      chat: async () =>
        reply(
          calls++ === 0
            ? { action: "compile_candidate", recipeId: "quarter-orbit" }
            : { action: "list_recipes" },
        ),
    });
    expect(result.events[0].observation).toMatchObject({
      repairSearch: {
        options: expect.arrayContaining([
          expect.objectContaining({ recipeId: "quarter-orbit" }),
        ]),
      },
    });
    expect(result.source).toBe("library");
    expect(result.outcome).toBe("fallback");
    expect(result.stopReason).toBe("action_budget");
  });

  it("stops after twelve checks in a room that cannot contain the requested orbit", () => {
    const cramped = {
      ...blockedFrontOrbit.scene,
      boundary: [
        { x: -1, z: -1 },
        { x: 1, z: -1 },
        { x: 1, z: 1 },
        { x: -1, z: 1 },
      ],
    };
    const p = compilePlan(
      cramped,
      blockedFrontOrbit.gear,
      blockedFrontOrbit.intent,
      "quarter-orbit",
    );
    const search = searchBearingRepairs(p)!;
    expect(search.compileChecks).toBe(12);
    expect(search.options).toEqual([]);
    expect(search.stopReason).toBe("search_budget");
    expect(
      search.trials.every((trial) => trial.rejectionCodes.length > 0),
    ).toBe(true);
  });

  it("does not search away a changed height or a pure framing failure", () => {
    const heightChange = compilePlan(
      blockedFrontOrbit.scene,
      blockedFrontOrbit.gear,
      blockedFrontOrbit.intent,
      "quarter-orbit",
      { height: 1.4 },
    );
    expect(searchBearingRepairs(heightChange)).toBeUndefined();
    const framingFailure = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "hero-hold",
      { distance: 3.5 },
    );
    expect(
      framingFailure.validation.violations.some(
        (item) => item.severity === "error",
      ),
    ).toBe(true);
    expect(searchBearingRepairs(framingFailure)).toBeUndefined();
  });
});

describe("evidence-directed planning repairs", () => {
  it.each([
    {
      field: "cameraHeight",
      override: "height",
      value: 1.4,
      requested: defaultIntent.cameraHeight,
    },
    {
      field: "durationSeconds",
      override: "durationSeconds",
      value: 9,
      requested: defaultIntent.durationSeconds,
    },
  ])(
    "rejects a geometry-valid $field change and accepts an explicit correction",
    async ({ field, override, value, requested }) => {
      const rejected = compilePlan(
        defaultScene,
        defaultGear,
        defaultIntent,
        "hero-hold",
        { [override]: value },
      );
      expect(rejected.validation.valid).toBe(true);
      const corrected = compilePlan(
        defaultScene,
        defaultGear,
        defaultIntent,
        "hero-hold",
        { [override]: requested },
      );
      const actions = [
        { ...compile, overrides: { [override]: value } },
        { ...finish, candidateIds: [rejected.id] },
        { ...compile, overrides: { [override]: requested } },
        { ...finish, candidateIds: [corrected.id] },
      ];
      const result = await runPlanner(input, {
        trace: false,
        chat: async () => reply(actions.shift()),
      });
      expect(result.outcome).toBe("completed");
      expect(result.plans.map((plan) => plan.id)).toEqual([corrected.id]);
      expect(result.events[0].observation).toMatchObject({
        error: "intent_mismatch",
        validation: { valid: true },
        fields: [
          expect.objectContaining({
            field,
            override,
            actual: value,
            requested,
          }),
        ],
        requiredOverrides: { [override]: requested },
      });
      expect(result.events[1].observation).toMatchObject({
        error: "invalid_finish_reference",
        candidateIds: [rejected.id],
      });
    },
  );

  it("requires an explicit height correction for a recipe default offset", async () => {
    const elevated = { action: "compile_candidate", recipeId: "elevated-hold" };
    const corrected = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "elevated-hold",
      { height: defaultIntent.cameraHeight },
    );
    expect(corrected.validation.valid).toBe(true);
    const actions = [
      elevated,
      { ...elevated, overrides: { height: defaultIntent.cameraHeight } },
      { ...finish, candidateIds: [corrected.id] },
    ];
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => reply(actions.shift()),
    });
    expect(result.events[0].observation).toMatchObject({
      error: "intent_mismatch",
      fields: [
        expect.objectContaining({
          field: "cameraHeight",
          requested: 1.3,
          actual: 1.5,
        }),
      ],
    });
    expect(result.outcome).toBe("completed");
    expect(result.plans[0].cameraHeight).toBe(defaultIntent.cameraHeight);
  });

  it("excludes geometry-valid intent mismatches from validation success and partial results", async () => {
    const rejected = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "hero-hold",
      { height: 1.4 },
    );
    const actions = [
      { ...compile, overrides: { height: 1.4 } },
      { action: "validate_candidate", candidateId: rejected.id },
      compile,
      ...Array.from({ length: 3 }, () => ({ action: "list_recipes" })),
    ];
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => reply(actions.shift()),
    });
    expect(result.events[1].observation).toMatchObject({
      error: "candidate_not_valid",
      rejection: { error: "intent_mismatch" },
    });
    expect(result.outcome).toBe("partial");
    expect(result.stopReason).toBe("action_budget");
    expect(result.plans.map((plan) => plan.id)).toEqual([hold.id]);
  });

  it("allows numerical roundoff in explicit height and duration", async () => {
    const overrides = {
      height: defaultIntent.cameraHeight + 1e-8,
      durationSeconds: defaultIntent.durationSeconds + 1e-8,
    };
    const candidate = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "hero-hold",
      overrides,
    );
    const actions = [
      { ...compile, overrides },
      { ...finish, candidateIds: [candidate.id] },
    ];
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => reply(actions.shift()),
    });
    expect(result.outcome).toBe("completed");
    expect(result.events[0].observation).not.toHaveProperty("rejected");
  });

  it("provides recipe defaults and applicable parameter units before asking for an action", async () => {
    const requests: PlannerMessage[][] = [];
    await runPlanner(input, {
      trace: false,
      chat: async (messages) => {
        requests.push(messages);
        return reply(requests.length === 1 ? compile : finish);
      },
    });
    const context = JSON.parse(requests[0][1].content);
    const orbit = context.recipes.find(
      (recipe: { id: string }) => recipe.id === "quarter-orbit",
    );
    expect(orbit.defaults).toMatchObject({
      orbitDegrees: 45,
      height: defaultIntent.cameraHeight,
      durationSeconds: defaultIntent.durationSeconds,
    });
    expect(orbit.allowedOverrides).toContain("orbitDegrees");
    expect(orbit.allowedOverrides).not.toContain("travel");
    expect(context.parameterUnits.travel).toContain("meters");
    expect(systemPrompt).not.toContain("read_take_findings");
    expect(systemPrompt).not.toContain("propose_revision");
    expect(requests.map((messages) => messages.length)).toEqual([2, 4]);
  });

  it("gives field-specific feedback for unused overrides and accepts a corrected action", async () => {
    const seen: PlannerMessage[][] = [];
    const actions = [
      { ...compile, overrides: { orbitDegrees: 0, travel: 0 } },
      compile,
      finish,
    ];
    const result = await runPlanner(input, {
      trace: false,
      chat: async (messages) => {
        seen.push(messages);
        return reply(actions.shift());
      },
    });
    expect(result.outcome).toBe("completed");
    expect(result.plans[0].id).toBe(hold.id);
    expect(result.events[0].observation).toMatchObject({
      error: "irrelevant_override",
      fields: expect.arrayContaining([
        expect.objectContaining({ path: ["overrides", "orbitDegrees"] }),
        expect.objectContaining({ path: ["overrides", "travel"] }),
      ]),
      repairBudget: { remaining: 2 },
    });
    expect(JSON.parse(seen[1].at(-1)!.content).observation).toEqual(
      result.events[0].observation,
    );
  });

  it("recognizes the recorded repeated orbit rejection and retains the final widened-arc evidence", async () => {
    const unchanged = {
      action: "compile_candidate",
      recipeId: "quarter-orbit",
      overrides: { bearingDeg: 35, orbitDegrees: 21.9375, height: 1.237 },
    };
    const actions = [
      unchanged,
      {
        ...unchanged,
        overrides: { height: 1.237, orbitDegrees: 21.9375, bearingDeg: 35 },
      },
      {
        ...unchanged,
        overrides: { ...unchanged.overrides, orbitDegrees: 31.5 },
      },
    ];
    const before = JSON.stringify(recordedOrbit);
    const result = await runPlanner(recordedOrbit, {
      trace: false,
      chat: async () => reply(actions.shift()),
    });
    expect(result.stopReason).toBe("repair_budget");
    expect(result.events).toHaveLength(3);
    expect(result.events[0].observation).toMatchObject({
      error: "validation_rejected",
      family: "orbit",
      cameraHeight: 1.237,
      durationSeconds: 10,
      validation: {
        valid: false,
        violations: expect.arrayContaining([
          expect.objectContaining({ code: "operator_boundary" }),
        ]),
      },
      motion: { sweepDegrees: 21.9375 },
    });
    expect(result.events[1].observation).toMatchObject({
      error: "no_progress",
      previousRejection: { error: "validation_rejected" },
    });
    expect(result.events[2].observation).toMatchObject({
      error: "validation_rejected",
      validation: {
        violations: expect.arrayContaining([
          expect.objectContaining({ code: "camera_boundary" }),
        ]),
      },
      repairBudget: { exhausted: true },
    });
    expect(JSON.stringify(recordedOrbit)).toBe(before);
  });

  it("does not present invalid JSON or revision actions as successful planning", async () => {
    const responses = [
      { content: "not JSON", usage: { inputTokens: 2, outputTokens: 1 } },
      reply({ action: "read_take_findings" }),
      reply({ ...compile, overrides: { distance: -1 } }),
    ];
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => responses.shift()!,
    });
    expect(result.source).toBe("library");
    expect(result.stopReason).toBe("repair_budget");
    expect(result.events).toHaveLength(3);
    expect(result.events[0].action).toEqual({ rawResponse: "not JSON" });
    expect(result.events[2].observation).toMatchObject({
      error: "invalid_action",
      issues: expect.arrayContaining([
        expect.objectContaining({ path: ["overrides", "distance"] }),
      ]),
      repairBudget: { exhausted: true },
    });
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 3 });
  });

  it.each(["validate_candidate", "finish"])(
    "charges unknown %s references to the same bounded repair budget",
    async (action) => {
      let calls = 0;
      const result = await runPlanner(input, {
        trace: false,
        chat: async () => {
          calls++;
          return reply(
            action === "finish"
              ? { ...finish, candidateIds: ["invented"] }
              : { action, candidateId: "invented" },
          );
        },
      });
      expect(calls).toBe(3);
      expect(result.events).toHaveLength(3);
      expect(result.stopReason).toBe("repair_budget");
    },
  );

  it("rejects unchecked abstention and continues to a compiled plan", async () => {
    const actions = [empty, compile, finish];
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => reply(actions.shift()),
    });
    expect(result.events[0].observation).toMatchObject({
      error: "unchecked_abstention",
      compileChecks: 0,
    });
    expect(result.outcome).toBe("completed");
    expect(result.plans[0].id).toBe(hold.id);
  });

  it("qualifies an empty result by the actual checks instead of claiming impossibility", async () => {
    const actions = [{ ...compile, overrides: { distance: 0.1 } }, empty];
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => reply(actions.shift()),
    });
    expect(result.outcome).toBe("checked_abstention");
    expect(result.plans).toEqual([]);
    expect(result.message).toContain("after 1 compile checks");
    expect(result.message).toContain("do not prove");
  });

  it("keeps earlier valid work when later failed repairs exhaust the budget", async () => {
    const actions = [
      compile,
      ...[0.1, 0.11, 0.12].map((distance) => ({
        ...compile,
        overrides: { distance },
      })),
    ];
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => reply(actions.shift()),
    });
    expect(result.source).toBe("forge");
    expect(result.outcome).toBe("partial");
    expect(result.stopReason).toBe("repair_budget");
    expect(result.plans.map((plan) => plan.id)).toEqual([hold.id]);
    expect(result.events).toHaveLength(4);
    expect(result.events[3].observation).toMatchObject({
      validation: { valid: false },
      repairBudget: { exhausted: true },
    });
    expect(result.message).toContain("Planning is incomplete");
  });

  it("allows the agent to discard a geometry-valid hold that does not preserve an orbit brief", async () => {
    let calls = 0;
    const result = await runPlanner(
      { ...input, prompt: "Orbit right around the product." },
      {
        trace: false,
        chat: async () =>
          reply(
            calls++ === 0
              ? compile
              : {
                  ...empty,
                  explanation:
                    "The checked hold fits geometrically but does not perform the requested orbit.",
                },
          ),
      },
    );
    expect(result.outcome).toBe("checked_abstention");
    expect(result.plans).toEqual([]);
    expect(result.events[0].observation).toMatchObject({
      validation: { valid: true },
      family: "hold",
    });
    expect(result.message).toContain("does not perform the requested orbit");
  });

  it("distinguishes provider failure from an expected validation rejection", async () => {
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => {
        throw new Error("Provider failure fixture");
      },
    });
    expect(result.stopReason).toBe("provider_error");
    expect(result.outcome).toBe("fallback");
    expect(result.events).toEqual([]);
  });
});
