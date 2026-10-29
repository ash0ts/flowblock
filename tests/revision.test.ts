import { describe, it, expect } from "vitest";
import {
  defaultScene,
  defaultGear,
  defaultIntent,
  compilePlan,
  type TakeAnalysis,
} from "../src/domain";
import {
  proposeRevision,
  validateRevision,
} from "../src/server/revision-planner";
const plan = compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold");
const analysis: TakeAnalysis = {
  schemaVersion: "1.0",
  analysisSpace: "upright-normalized-image",
  jobId: "synthetic-unit-job",
  takeId: "synthetic-unit-take",
  planId: plan.id,
  planVersion: "1.0",
  summary: "Synthetic rule fixture, not an actual inference result.",
  provenance: {
    model: "SAM 2.1 Small",
    repositoryCommit: "fixture",
    checkpointSha256: "fixture",
    device: "cpu",
    realInference: true,
    rulesVersion: "framing-v1",
    generatedAt: "2026-10-29T00:00:00Z",
  },
  video: {
    durationSeconds: 5,
    sourceWidth: 640,
    sourceHeight: 360,
    rotationDegrees: 0,
    width: 640,
    height: 360,
    codec: "h264",
    fps: 15,
    sampledFrames: 75,
    sourceStartPtsSeconds: 0,
    timestampMapping: "nearest-source-presentation-timestamp",
    timeMap: [],
  },
  tracks: [],
  coverage: {
    expectedFrames: 75,
    measuredFrames: 75,
    missingFrames: 0,
    uncertainFrames: 0,
    intentionallyHiddenFrames: 0,
    measuredFraction: 1,
    needsReview: false,
  },
  findings: [
    {
      kind: "duration",
      phase: "whole",
      title: "Timing differs",
      detail: "The clip is 5 seconds; the plan is 8 seconds.",
      evidenceTimestamps: [4.9],
      affectedFrames: 75,
      measuredPhaseFrames: 75,
      suggestion: "Try the measured duration.",
    },
  ],
  artifacts: {
    proxyObjectKey: "fixture/proxy",
    timestampsObjectKey: "fixture/timestamps",
    analysisObjectKey: "fixture/analysis",
  },
  limitations: ["Unit-test evidence only."],
};
const ids = ["duration:whole:0"];
describe("evidence-linked revisions", () => {
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
