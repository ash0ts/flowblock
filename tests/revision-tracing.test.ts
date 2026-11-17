import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as weave from "weave";
import {
  proposeRevision,
  RevisionAbstainedError,
} from "../src/server/revision-planner";
import { plan, analysis } from "./fixtures/revision";

// Keep real async span ownership; exports and inference never reach the network.
vi.mock("weave", async (importOriginal) => ({
  ...(await importOriginal<typeof import("weave")>()),
  init: vi.fn().mockResolvedValue({}),
  flushOTel: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  vi.stubEnv("WANDB_API_KEY", "test-only");
  vi.stubEnv("WANDB_ENTITY", "test");
  vi.stubEnv("FLOWBLOCK_TRACE", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function captureTurn() {
  const turn = weave.getCurrentTurn()!;
  const conversationId = weave.getCurrentConversation()!.conversationId;
  const errors = vi.spyOn(turn, "recordError");
  const record = vi.spyOn(turn, "record");
  const attributes = vi.spyOn(turn, "setAttributes");
  const ends: ReturnType<typeof vi.spyOn>[] = [];
  const startTool = turn.startTool.bind(turn);
  const tools = vi.spyOn(turn, "startTool").mockImplementation((args) => {
    const tool = startTool(args);
    ends.push(vi.spyOn(tool, "end"));
    return tool;
  });
  return { conversationId, errors, record, attributes, ends, tools };
}
const usage = { inputTokens: 1, outputTokens: 1 };

describe("revision evidence and fallback traces", () => {
  it("preserves empty invalid payloads in trace arguments without changing recorded raw actions", async () => {
    let captured: ReturnType<typeof captureTurn> | undefined;
    const result = await proposeRevision(plan, analysis, {
      chat: async () => {
        captured ??= captureTurn();
        return { content: "{}", usage };
      },
    });
    expect(result.events.map((event) => event.action)).toEqual([{}, {}, {}]);
    expect(JSON.parse(String(captured!.tools.mock.calls[0][0].args))).toEqual({
      received: {},
    });
    expect(captured!.errors).not.toHaveBeenCalled();
  });

  it("records explicit abstention inside the supplied workflow without an error or library substitution", async () => {
    const workflowTrace = {
      schemaVersion: "1.0" as const,
      workflowId: "6e91f382-1057-4444-b134-37558894024a",
      stage: "revision" as const,
      attemptId: "196a5462-806f-4a33-92ae-bcb9b8bd7ee9",
      attempt: 1,
      planId: plan.id,
    };
    let captured: ReturnType<typeof captureTurn> | undefined;
    let calls = 0;
    let failure: unknown;
    try {
      await proposeRevision(plan, analysis, {
        workflowTrace,
        chat: async () => {
          captured ??= captureTurn();
          return {
            content: JSON.stringify(
              calls++ === 0
                ? { action: "read_take_findings" }
                : {
                    action: "abstain_revision",
                    findingIds: ["duration:whole:0"],
                    reason: "Keep the requested pacing for another rehearsal.",
                  },
            ),
            usage,
          };
        },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RevisionAbstainedError);
    expect(failure).toMatchObject({
      traceId: workflowTrace.workflowId,
      source: "forge",
    });
    expect(captured!.conversationId).toBe(workflowTrace.workflowId);
    expect(captured!.errors).not.toHaveBeenCalled();
    expect(captured!.attributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "flowblock.outcome": "abstained",
        "flowblock.stop_reason": "model_abstention",
        "flowblock.result_source": "forge",
      }),
    );
    expect(captured!.record).toHaveBeenCalledWith({
      outputMessages: [
        { role: "assistant", content: (failure as Error).message },
      ],
    });
    expect(weave.getCurrentConversation()).toBeUndefined();
  });

  it("records every rejected action and the final fallback without marking validation as a crash", async () => {
    let captured: ReturnType<typeof captureTurn> | undefined;
    const result = await proposeRevision(plan, analysis, {
      chat: async () => {
        captured ??= captureTurn();
        return { content: "not a JSON action", usage };
      },
    });
    expect(result.source).toBe("library");
    expect(result.traceId).toBe(captured!.conversationId);
    expect(result.events).toHaveLength(3);
    expect(result.events[2].observation).toMatchObject({ status: "rejected" });
    expect(captured!.errors).not.toHaveBeenCalled();
    expect(captured!.ends).toHaveLength(3);
    for (const end of captured!.ends) {
      expect(end).toHaveBeenCalledWith({
        result: expect.stringContaining('"status":"rejected"'),
      });
      expect(
        end.mock.calls
          .flat()
          .some(
            (value: unknown) =>
              value && typeof value === "object" && "error" in value,
          ),
      ).toBe(false);
    }
    expect(captured!.record).toHaveBeenCalledWith({
      outputMessages: [{ role: "assistant", content: result.reason }],
    });
    expect(captured!.attributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "flowblock.result_source": "library",
        "flowblock.revised_plan_id": result.plan.id,
        "flowblock.outcome": "fallback",
        "flowblock.stop_reason": "repair_budget",
      }),
    );
    expect(weave.getCurrentConversation()).toBeUndefined();
  });

  it("retains the evidence and validation observation when a rejected proposal is repaired", async () => {
    let captured: ReturnType<typeof captureTurn> | undefined;
    const actions = [
      { action: "read_take_findings" },
      {
        action: "propose_revision",
        overrides: { distance: 30 },
        findingIds: ["duration:whole:0"],
        reason: "Invalid citation relevance",
      },
      {
        action: "propose_revision",
        overrides: { durationSeconds: 5 },
        findingIds: ["duration:whole:0"],
        reason: "Try measured timing",
      },
    ];
    let index = 0;
    const result = await proposeRevision(plan, analysis, {
      chat: async () => {
        captured ??= captureTurn();
        return { content: JSON.stringify(actions[index++]), usage };
      },
    });
    expect(result.source).toBe("forge");
    expect(result.events).toHaveLength(3);
    expect(result.events[1].action).toEqual(actions[1]);
    expect(captured!.ends[1]).toHaveBeenCalledWith({
      result: expect.stringContaining("duration finding can justify only"),
    });
    expect(captured!.errors).not.toHaveBeenCalled();
    expect(captured!.attributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "flowblock.outcome": "revised",
        "flowblock.stop_reason": "completed",
      }),
    );
  });

  it("rejects rereading immutable findings and retains the labeled fallback", async () => {
    let captured: ReturnType<typeof captureTurn> | undefined;
    const result = await proposeRevision(plan, analysis, {
      chat: async () => {
        captured ??= captureTurn();
        return { content: '{"action":"read_take_findings"}', usage };
      },
    });
    expect(result.events).toHaveLength(4);
    expect(result.source).toBe("library");
    expect(result.traceId).toBe(captured!.conversationId);
    expect(captured!.errors).not.toHaveBeenCalled();
    expect(captured!.attributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "flowblock.stop_reason": "repair_budget",
        "flowblock.outcome": "fallback",
      }),
    );
  });

  it("records a provider failure and links its deterministic fallback", async () => {
    let captured: ReturnType<typeof captureTurn> | undefined;
    const failure = new Error("Provider failed fixture");
    const result = await proposeRevision(plan, analysis, {
      chat: async () => {
        captured ??= captureTurn();
        throw failure;
      },
    });
    expect(result.source).toBe("library");
    expect(result.traceId).toBe(captured!.conversationId);
    expect(captured!.errors).toHaveBeenCalledWith(failure);
    expect(captured!.attributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "flowblock.stop_reason": "provider_error",
        "flowblock.outcome": "fallback",
      }),
    );
    expect(captured!.record).toHaveBeenCalledWith({
      outputMessages: [{ role: "assistant", content: result.reason }],
    });
  });

  it("records deadline execution failure separately from provider failure", async () => {
    let captured: ReturnType<typeof captureTurn> | undefined;
    let llmErrors: ReturnType<typeof vi.spyOn> | undefined;
    const result = await proposeRevision(plan, analysis, {
      deadlineMs: 50,
      chat: async () => {
        captured = captureTurn();
        llmErrors = vi.spyOn(weave.getCurrentLLM()!, "recordError");
        return new Promise(() => {});
      },
    });
    expect(result.source).toBe("library");
    expect(result.traceId).toBe(captured!.conversationId);
    expect(llmErrors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Coordinator deadline reached" }),
    );
    expect(captured!.errors).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Coordinator deadline reached" }),
    );
    expect(captured!.attributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "flowblock.stop_reason": "deadline",
        "flowblock.outcome": "fallback",
      }),
    );
  });

  it("records an explicit abstention when no measured fallback fits", async () => {
    let captured: ReturnType<typeof captureTurn> | undefined;
    const spatial = {
      ...analysis,
      findings: [{ ...analysis.findings[0], kind: "framing" as const }],
    };
    await expect(
      proposeRevision(plan, spatial, {
        chat: async () => {
          captured ??= captureTurn();
          return { content: "malformed action", usage };
        },
      }),
    ).rejects.toThrow("No single feasible parameter change");
    expect(captured!.errors).not.toHaveBeenCalled();
    expect(captured!.record).toHaveBeenCalledWith({
      outputMessages: [
        {
          role: "assistant",
          content: expect.stringContaining(
            "No single feasible parameter change",
          ),
        },
      ],
    });
    expect(captured!.attributes).toHaveBeenCalledWith({
      "flowblock.outcome": "abstained",
      "flowblock.stop_reason": "repair_budget",
      "flowblock.rejected_actions": 3,
    });
    expect(weave.getCurrentConversation()).toBeUndefined();
  });
});
