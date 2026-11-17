import { afterEach, describe, expect, it, vi } from "vitest";
import * as weave from "weave";
import {
  createWorkflowTraceContext,
  runWorkflowStage,
  workflowAttributes,
  WorkflowTraceContextSchema,
} from "../src/server/workflow-telemetry";

vi.mock("weave", async (importOriginal) => ({
  ...(await importOriginal<typeof import("weave")>()),
  flushOTel: vi.fn().mockResolvedValue(undefined),
}));
const enabled = { initialize: async () => true };
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("persistent workflow telemetry", () => {
  it("reopens the same conversation while isolating simultaneous attempts", async () => {
    const first = createWorkflowTraceContext({ stage: "analysis", attempt: 1 });
    const second = createWorkflowTraceContext({
      workflowId: first.workflowId,
      stage: "analysis",
      attempt: 2,
      parentAttemptId: first.attemptId,
    });
    expect(second.attemptId).not.toBe(first.attemptId);
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen: {
      conversationId: string;
      attemptId: unknown;
      turn: unknown;
    }[] = [];
    await Promise.all(
      [first, second].map((context) =>
        runWorkflowStage(
          context,
          async () => {
            const conversation = weave.getCurrentConversation()!;
            seen.push({
              conversationId: conversation.conversationId,
              attemptId: conversation.attributes["flowblock.attempt_id"],
              turn: weave.getCurrentTurn(),
            });
            if (seen.length === 2) release();
            await barrier;
            return 75;
          },
          (measuredFrames) => ({ status: "succeeded", measuredFrames }),
          enabled,
        ),
      ),
    );
    expect(seen.map((entry) => entry.conversationId)).toEqual([
      first.workflowId,
      first.workflowId,
    ]);
    expect(new Set(seen.map((entry) => entry.attemptId)).size).toBe(2);
    expect(new Set(seen.map((entry) => entry.turn)).size).toBe(2);
    expect(weave.getCurrentConversation()).toBeUndefined();
  });

  it("records the published status rather than assuming a resolved operation succeeded", async () => {
    const context = createWorkflowTraceContext({
      stage: "analysis",
      attempt: 1,
    });
    let attributes: ReturnType<typeof vi.spyOn> | undefined;
    await runWorkflowStage(
      context,
      async () => {
        attributes = vi.spyOn(weave.getCurrentTurn()!, "setAttributes");
        return { needsReview: true };
      },
      () => ({
        status: "needs_review",
        measuredFrames: 40,
        expectedFrames: 75,
      }),
      enabled,
    );
    expect(attributes).toHaveBeenCalledWith({
      "flowblock.stage_outcome": "needs_review",
    });
  });

  it("preserves original exceptions but exports only a sanitized error", async () => {
    const context = createWorkflowTraceContext({
      stage: "acceptance",
      attempt: 1,
    });
    const failure = new Error("signedUrl=https://private?token=secret");
    let errors: ReturnType<typeof vi.spyOn> | undefined;
    await expect(
      runWorkflowStage(
        context,
        async () => {
          errors = vi.spyOn(weave.getCurrentTurn()!, "recordError");
          throw failure;
        },
        () => ({ status: "succeeded" }),
        enabled,
      ),
    ).rejects.toBe(failure);
    const exported = errors!.mock.calls[0][0] as Error;
    expect(exported.name).toBe("WorkflowStageError");
    expect(exported.message).toBe("Workflow stage failed");
    expect(weave.getCurrentTurn()).toBeUndefined();
  });

  it("rejects sensitive context keys and does not export invalid completion payloads", async () => {
    const context = createWorkflowTraceContext({ stage: "replay", attempt: 1 });
    expect(
      WorkflowTraceContextSchema.safeParse({ ...context, objectKey: "private" })
        .success,
    ).toBe(false);
    expect(() =>
      workflowAttributes({ ...context, planId: "https://private" }),
    ).toThrow();
    let recorded: ReturnType<typeof vi.spyOn> | undefined;
    let attributes: ReturnType<typeof vi.spyOn> | undefined;
    const result = await runWorkflowStage(
      context,
      async () => {
        recorded = vi.spyOn(weave.getCurrentTurn()!, "record");
        attributes = vi.spyOn(weave.getCurrentTurn()!, "setAttributes");
        return 42;
      },
      () => ({ status: "succeeded", signedUrl: "secret" }) as never,
      enabled,
    );
    expect(result).toBe(42);
    expect(recorded).not.toHaveBeenCalled();
    expect(attributes).toHaveBeenCalledWith({
      "flowblock.stage_outcome": "unknown",
    });
  });

  it("does not block the operation on a stalled telemetry initialization", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockResolvedValue("saved");
    const pending = runWorkflowStage(
      createWorkflowTraceContext({ stage: "acceptance", attempt: 1 }),
      operation,
      () => ({ status: "succeeded" }),
      { initialize: () => new Promise<boolean>(() => {}) },
    );
    await vi.advanceTimersByTimeAsync(1000);
    await expect(pending).resolves.toBe("saved");
    expect(operation).toHaveBeenCalledOnce();
  });
});
