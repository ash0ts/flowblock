import { describe, it, expect } from "vitest";
import {
  defaultScene,
  defaultGear,
  defaultIntent,
  compilePlan,
} from "../src/domain";
import {
  proposeRevision,
  validateRevision,
} from "../src/server/revision-planner";
import { plan, analysis } from "./fixtures/revision";
import { PlanVersionSchema, TakeAnalysisSchema } from "../src/domain";
import { loadEvaluationRuntime } from "../training/runtime";
const ids = ["duration:whole:0"];
describe("evidence-linked revisions", () => {
  it("keeps legacy plans readable but changes identity when recompiling under a new engine", async () => {
    const frozen = await loadEvaluationRuntime("frozen-v1");
    const legacy = frozen.domain.compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "hero-hold",
    );
    expect(PlanVersionSchema.safeParse(legacy).success).toBe(true);
    expect(plan.engineVersion).toBe("flowblock-engine-v1.1");
    expect(plan.id).not.toBe(legacy.id);
    expect(() =>
      validateRevision(
        plan,
        { ...analysis, planId: legacy.id },
        { durationSeconds: 5 },
        ["duration:whole:0"],
      ),
    ).toThrow("another plan");
  });
  it("accepts both archived and corrected worker measurement rule versions", () => {
    for (const rulesVersion of ["framing-v1", "framing-v1.1"])
      expect(
        TakeAnalysisSchema.safeParse({
          ...analysis,
          provenance: { ...analysis.provenance, rulesVersion },
        }).success,
      ).toBe(true);
    expect(
      TakeAnalysisSchema.safeParse({
        ...analysis,
        provenance: { ...analysis.provenance, rulesVersion: "unknown" },
      }).success,
    ).toBe(false);
  });
  const offline = async () => {
    throw new Error("Offline regression fixture");
  };
  it("keeps the direction of an already-reversed orbit when reducing its sweep", async () => {
    const orbit = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "quarter-orbit",
      { reverse: true },
    );
    const findings = [
      {
        ...analysis.findings[0],
        kind: "framing" as const,
        title: "Framing drift",
      },
    ];
    const result = await proposeRevision(
      orbit,
      { ...analysis, planId: orbit.id, findings },
      { trace: false, chat: offline },
    );
    expect(result.source).toBe("library");
    expect(result.plan.path.sweepAngle).toBeCloseTo(
      orbit.path.sweepAngle * 0.8,
    );
    expect(result.plan.overrides.reverse).toBe(true);
  });
  it("does not offer a duration change as a correction for spatial framing", async () => {
    const findings = [
      {
        ...analysis.findings[0],
        kind: "framing" as const,
        title: "Framing drift",
      },
    ];
    await expect(
      proposeRevision(
        plan,
        { ...analysis, findings },
        { trace: false, chat: offline },
      ),
    ).rejects.toThrow("No single feasible parameter change");
  });
  it("rejects another plan before invoking a model", async () => {
    let invoked = false;
    await expect(
      proposeRevision(
        plan,
        { ...analysis, planId: "another-plan" },
        {
          trace: false,
          chat: async () => {
            invoked = true;
            return offline();
          },
        },
      ),
    ).rejects.toThrow("another plan");
    expect(invoked).toBe(false);
  });
  it("requires a citation to this take and exactly one changed parameter", () => {
    expect(() =>
      validateRevision(plan, analysis, { durationSeconds: 5 }, ["invented"]),
    ).toThrow("Cite one");
    expect(() =>
      validateRevision(
        plan,
        analysis,
        { durationSeconds: 5, distance: 3 },
        ids,
      ),
    ).toThrow("exactly one");
    expect(() =>
      validateRevision(plan, analysis, { durationSeconds: 8 }, ids),
    ).toThrow("does not change");
    expect(() =>
      validateRevision(
        plan,
        { ...analysis, planId: "another-plan" },
        { durationSeconds: 5 },
        ids,
      ),
    ).toThrow("another plan");
  });
  it("abstains on uncertain tracking", async () => {
    await expect(
      proposeRevision(
        plan,
        { ...analysis, coverage: { ...analysis.coverage, needsReview: true } },
        { trace: false },
      ),
    ).rejects.toThrow("Reliable");
  });
  it("executes only a grounded model proposal and keeps immutable source facts", async () => {
    let count = 0;
    const result = await proposeRevision(plan, analysis, {
      trace: false,
      chat: async () => ({
        content: JSON.stringify(
          count++ === 0
            ? { action: "read_take_findings" }
            : {
                action: "propose_revision",
                overrides: { durationSeconds: 5 },
                findingIds: ids,
                reason: "Match measured timing.",
              },
        ),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });
    expect(result.source).toBe("forge");
    expect(result.plan.durationSeconds).toBe(5);
    expect(plan.durationSeconds).toBe(8);
    expect(result.plan.scene).toEqual(plan.scene);
    expect(result.plan.intent).toEqual(plan.intent);
    expect(result.findingIds).toEqual(ids);
    expect(result.reason).toContain("proposed experiment");
  });
  it("cannot bypass validation even with a real finding", () => {
    expect(() =>
      validateRevision(plan, analysis, { distance: 30 }, ids),
    ).toThrow("does not fit");
  });
  it("bounds malformed actions and exposes deterministic fallback", async () => {
    let count = 0;
    const result = await proposeRevision(plan, analysis, {
      trace: false,
      chat: async () => {
        count++;
        return {
          content: '{"action":"move_wall"}',
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    expect(count).toBe(3);
    expect(result.source).toBe("library");
    expect(result.plan.validation.valid).toBe(true);
  });
});
