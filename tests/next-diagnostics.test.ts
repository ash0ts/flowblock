import { describe, expect, it } from "vitest";
import {
  compilePlan,
  defaultGear,
  defaultIntent,
  defaultScene,
} from "../src/domain";
import type { PlanningResult } from "../src/server/planner";
import type { Fixture } from "../training/fixtures";
import { diagnoseRecordedAttempt } from "../training/experiments/next/diagnostics";
import { search } from "../training/experiments/next/search";

function fixture(): Fixture {
  return {
    id: "diagnostic",
    sceneGroup: "diagnostic-scene",
    split: "dev",
    geometryHash: "test-only",
    expectedFamily: "hold",
    input: {
      scene: structuredClone(defaultScene),
      gear: structuredClone(defaultGear),
      intent: structuredClone(defaultIntent),
    },
    oracle: { searchVersion: "test-only", feasible: true },
  };
}
function result(events: PlanningResult["events"] = []): PlanningResult {
  return {
    plans: [],
    source: "forge",
    message: "",
    events,
    usage: { inputTokens: 0, outputTokens: 0 },
    inputHash: "test",
    plannerVersion: "test",
    latencyMs: 0,
  };
}

describe("raw reply development diagnostics", () => {
  it("keeps unavailable, malformed, invalid, and unrecorded attempts distinct", async () => {
    const f = fixture();
    const action = {
      action: "compile_candidate",
      recipeId: "hero-hold",
      overrides: { distance: 0.1 },
    };
    const plan = compilePlan(
      f.input.scene,
      f.input.gear,
      f.input.intent,
      "hero-hold",
      { distance: 0.1 },
    );
    expect(plan.validation.valid).toBe(false);
    const event = {
      action,
      observation: { validation: plan.validation },
      elapsedMs: 0,
    };
    const grade = { compileCount: 2, preserved: true };
    const record = {
      calls: [
        { response: { content: JSON.stringify(action) } },
        { response: { content: JSON.stringify(action) } },
        { response: { content: JSON.stringify(action) } },
        {
          response: {
            content: JSON.stringify({ ...action, overrides: { distance: 0 } }),
          },
        },
        { response: { content: "{} {}" } },
        {},
      ],
      result: result([event, event]),
      entry: { arm: "baseline", grade },
    };
    const before = structuredClone(record);
    const diagnosed = await diagnoseRecordedAttempt(f, record, "product");
    expect(diagnosed.counts).toMatchObject({
      rawCalls: 6,
      noResponse: 1,
      invalidJson: 1,
      invalidActions: 1,
      validActions: 3,
      rawCompileReplies: 4,
      schemaValidCompileReplies: 3,
      recordedCompileEvents: 2,
      compileRepliesWithoutRecordedEvent: 1,
      recomputedInvalidCompiles: 3,
      unmatchedRecordedEvents: 0,
    });
    expect(diagnosed.replies[2]).toMatchObject({
      recordedExecution: "not-recorded",
      recomputedCompile: { provenance: "offline-recomputation", valid: false },
    });
    expect(diagnosed.recordedGrade).toEqual(grade);
    expect(diagnosed.recomputedLegacyGrade?.provenance).toBe(
      "offline-recomputation",
    );
    expect(record).toEqual(before);
  });
  it("matches reordered JSON keys without counting a duplicate event twice", async () => {
    const action = {
      action: "finish",
      candidateIds: [],
      explanation: "No witness checked.",
    };
    const diagnosed = await diagnoseRecordedAttempt(
      fixture(),
      {
        calls: [
          {
            response: {
              content:
                '{"explanation":"No witness checked.","candidateIds":[],"action":"finish"}',
            },
          },
          { response: { content: JSON.stringify(action) } },
        ],
        result: result([
          { action, observation: { accepted: [] }, elapsedMs: 0 },
        ]),
      },
      "frozen-v1",
    );
    expect(diagnosed.counts.emptyFinishReplies).toBe(2);
    expect(diagnosed.replies[0].recordedExecution).toBe("event-recorded");
    expect(diagnosed.replies[1].recordedExecution).toBe("not-recorded");
    expect(diagnosed.runtime.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects a mismatched fixture instead of recompiling another scene", async () => {
    await expect(
      diagnoseRecordedAttempt(fixture(), { fixtureId: "wrong", calls: [] }),
    ).rejects.toThrow(/do not match/);
  });
});

describe("family-constrained bounded witness search", () => {
  it("keeps family and source facts, returns only revalidated witnesses, and is deterministic", () => {
    const f = fixture();
    const before = structuredClone(f.input);
    const first = search(f.input, { family: "hold" });
    expect(first.plans.length).toBeGreaterThan(0);
    expect(
      first.plans.every(
        (plan) => plan.family === "hold" && plan.validation.valid,
      ),
    ).toBe(true);
    expect(
      first.plans.every(
        (plan) =>
          compilePlan(
            plan.scene,
            plan.gear,
            plan.intent,
            plan.recipeId,
            plan.overrides,
          ).validation.valid,
      ),
    ).toBe(true);
    expect(first.budgetReached).toBe(false);
    expect(search(f.input, { family: "hold" })).toEqual(first);
    expect(f.input).toEqual(before);
  });
  it("exposes budget exhaustion without claiming impossibility", () => {
    const f = fixture();
    f.input.gear.stabilizer = "tripod";
    const found = search(f.input, { family: "orbit", maxCandidates: 1 });
    expect(found.sampledCandidates).toBe(1);
    expect(found.budgetReached).toBe(true);
    expect(found.plans).toEqual([]);
    expect(found.disclosure).toContain("does not prove");
    expect(() =>
      search(f.input, { family: "orbit", maxCandidates: 0 }),
    ).toThrow(/budget/);
  });
  it("never introduces zero-length movement merely to obtain a valid family label", () => {
    const found = search(fixture().input, { family: "push-in" });
    expect(found.sampledCandidates).toBeGreaterThan(1);
    expect(
      found.plans.every(
        (plan) => plan.arcLength > 0 && plan.family === "push-in",
      ),
    ).toBe(true);
  });
});
