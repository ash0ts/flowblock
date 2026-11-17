import { afterEach, describe, expect, it, vi } from "vitest";
import * as domain from "../src/domain";
import { revisionEvidenceActionSchema } from "../src/server/revision-actions";
import type { PlannerMessage } from "../src/server/planner";
import {
  proposeRevision,
  validateRevision,
  RevisionAbstainedError,
} from "../src/server/revision-planner";
import { plan, analysis } from "./fixtures/revision";

const sizeAnalysis: domain.TakeAnalysis = {
  ...analysis,
  findings: [
    {
      ...analysis.findings[0],
      kind: "size",
      phase: "ending",
      title: "Synthetic size mismatch",
      measurement: {
        metric: "size-ratio",
        observed: 1.8,
        target: 1,
        delta: 0.8,
        unit: "relative-size",
        timestamp: 4.9,
      },
    },
  ],
};
const sizeIds = ["size:ending:0"];
const reply = (action: unknown) => ({
  content: JSON.stringify(action),
  usage: { inputTokens: 1, outputTokens: 1 },
});
const change = (overrides: domain.Overrides, findingIds = sizeIds) => ({
  action: "propose_revision",
  overrides,
  findingIds,
  reason: "Try one framing experiment and compare the next recorded take.",
});
afterEach(() => vi.restoreAllMocks());

describe("evidence-specific revision actions", () => {
  it("limits each known citation to its own parameter space in mixed findings", () => {
    const mixed = {
      ...analysis,
      findings: [...sizeAnalysis.findings, ...analysis.findings],
    };
    const schema = revisionEvidenceActionSchema(plan, mixed);
    expect(schema.safeParse(change({ distance: 2.4 })).success).toBe(true);
    expect(
      schema.safeParse(change({ durationSeconds: 5 }, ["duration:whole:1"]))
        .success,
    ).toBe(true);
    for (const action of [
      change({ durationSeconds: 5 }),
      change({ distance: 2.4 }, ["duration:whole:1"]),
      change({ distance: 2.4 }, ["invented"]),
      change({ distance: 2.4, height: 1.1 }),
      {},
      { action: "read_take_findings" },
    ])
      expect(schema.safeParse(action).success).toBe(false);
  });

  it("supports a measured size direction without claiming a metric camera-distance estimate", () => {
    expect(() =>
      validateRevision(
        plan,
        sizeAnalysis,
        { distance: plan.path.radius * 0.9 },
        sizeIds,
      ),
    ).toThrow("increase in planned distance as an experiment");
    const small = {
      ...sizeAnalysis,
      findings: [
        {
          ...sizeAnalysis.findings[0],
          measurement: {
            ...sizeAnalysis.findings[0].measurement!,
            observed: 0.6,
            delta: -0.4,
          },
        },
      ],
    };
    expect(() =>
      validateRevision(
        plan,
        small,
        { distance: plan.path.radius * 1.1 },
        sizeIds,
      ),
    ).toThrow("decrease in planned distance as an experiment");
    expect(
      validateRevision(
        plan,
        small,
        { distance: plan.path.radius * 0.9 },
        sizeIds,
      ).validation.valid,
    ).toBe(true);
  });

  it("replays the failed duration/empty-object prefix with useful repair feedback and accepts a model-chosen value", async () => {
    const actions = [
      { action: "read_take_findings" },
      change({ durationSeconds: 5 }),
      {},
      change({ distance: 2.4 }),
    ];
    const requests: PlannerMessage[][] = [];
    const result = await proposeRevision(plan, sizeAnalysis, {
      trace: false,
      chat: async (messages) => {
        requests.push(messages);
        return reply(actions[requests.length - 1]);
      },
    });
    expect(result.source).toBe("forge");
    expect(result.plan.path.radius).toBe(2.4);
    expect(result.plan.path.radius).not.toBeCloseTo(plan.path.radius * 1.12);
    expect(result.findingIds).toEqual(sizeIds);
    const actionSchema = JSON.parse(
      requests[1][0].content.split("Available actions:\n")[1],
    );
    expect(JSON.stringify(actionSchema)).not.toContain("durationSeconds");
    expect(JSON.stringify(actionSchema)).toContain("abstain_revision");
    expect(requests[1][0].content).toContain(
      "not a calibrated distance multiplier",
    );
    expect(JSON.parse(requests[1][1].content).plan.allowedOverrides).toEqual([
      "distance",
    ]);
    const observation = JSON.parse(requests[2].at(-1)!.content).observation;
    expect(observation.error).toContain("spatial finding cannot justify");
    expect(observation.repairGuidance.choices[0]).toMatchObject({
      findingId: sizeIds[0],
      parameters: ["distance"],
      distanceExperiment: {
        direction: "increase",
        currentMeters: plan.path.radius,
      },
    });
    expect(result.events[2].action).toEqual({});
    expect(result.events[2].observation).toMatchObject({
      status: "rejected",
      error: expect.stringContaining("empty object"),
    });
  });

  it("does not recompile an identical rejected proposal when only its explanation changes", async () => {
    const compile = vi.spyOn(domain, "compilePlan");
    const actions = [
      { action: "read_take_findings" },
      change({ distance: 30 }),
      { ...change({ distance: 30 }), reason: "Rephrased same rejected plan" },
      change({ distance: 2.4 }),
    ];
    let index = 0;
    const result = await proposeRevision(plan, sizeAnalysis, {
      trace: false,
      chat: async () => reply(actions[index++]),
    });
    expect(result.source).toBe("forge");
    expect(compile).toHaveBeenCalledTimes(2);
    expect(result.events[2].observation).toMatchObject({
      status: "rejected",
      error: expect.stringContaining("No new compile ran"),
    });
  });

  it("ends explicit model abstention without substituting the feasible library correction", async () => {
    let calls = 0;
    let failure: unknown;
    try {
      await proposeRevision(plan, analysis, {
        trace: false,
        chat: async () =>
          reply(
            calls++ === 0
              ? { action: "read_take_findings" }
              : {
                  action: "abstain_revision",
                  findingIds: ["duration:whole:0"],
                  reason:
                    "Keep the specified pacing and record another take before changing duration.",
                },
          ),
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RevisionAbstainedError);
    expect(failure).toMatchObject({
      source: "forge",
      findingIds: ["duration:whole:0"],
      reason: expect.stringContaining("specified pacing"),
      events: expect.any(Array),
    });
    expect((failure as RevisionAbstainedError).events).toHaveLength(2);
    expect(calls).toBe(2);
  });

  it("offers explicit abstention for legacy size findings without a measured direction", () => {
    const legacy = {
      ...sizeAnalysis,
      findings: [{ ...sizeAnalysis.findings[0], measurement: undefined }],
    };
    const schema = revisionEvidenceActionSchema(plan, legacy);
    expect(schema.safeParse(change({ distance: 2.4 })).success).toBe(false);
    expect(
      schema.safeParse({
        action: "abstain_revision",
        findingIds: sizeIds,
        reason: "The size measurement direction is unavailable.",
      }).success,
    ).toBe(true);
  });
});
