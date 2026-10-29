import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultGear, defaultIntent, defaultScene } from "../src/domain";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  flush: vi.fn(),
  start: vi.fn(),
}));
vi.mock("weave", () => ({
  init: mocks.init,
  flushOTel: mocks.flush,
  startConversation: mocks.start,
}));

const input = { scene: defaultScene, gear: defaultGear, intent: defaultIntent };
const finish = {
  content: JSON.stringify({
    action: "finish",
    candidateIds: [],
    explanation: "No candidate selected.",
  }),
  usage: { inputTokens: 1, outputTokens: 1 },
};
const never = () => new Promise<never>(() => {});

describe("planner total deadline", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T12:00:00Z"));
    vi.stubEnv("WANDB_API_KEY", "test-only");
    vi.stubEnv("WANDB_ENTITY", "test");
    vi.stubEnv("FLOWBLOCK_TRACE", "1");
    mocks.init.mockReset().mockResolvedValue({});
    mocks.flush.mockReset().mockResolvedValue(undefined);
    mocks.start.mockReset().mockImplementation(() => ({
      conversationId: "test-conversation",
      end: vi.fn(),
      startTurn: () => ({
        end: vi.fn(),
        recordError: vi.fn(),
        startLLM: () => ({ end: vi.fn(), output: vi.fn(), record: vi.fn() }),
        startTool: () => ({ end: vi.fn() }),
      }),
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("returns at the deadline when telemetry initialization never settles", async () => {
    const { runPlanner } = await import("../src/server/planner");
    mocks.init.mockImplementation(never);
    const chat = vi.fn().mockResolvedValue(finish);
    const pending = runPlanner(input, { chat, deadlineMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.source).toBe("library");
    expect(result.latencyMs).toBe(100);
    expect(chat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("charges telemetry initialization to the same budget and rejects a late model reply", async () => {
    const { runPlanner } = await import("../src/server/planner");
    mocks.init.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 70)),
    );
    let signal: AbortSignal | undefined;
    let resolveReply: ((value: typeof finish) => void) | undefined;
    const pending = runPlanner(input, {
      deadlineMs: 100,
      chat: async (_messages, _model, deadline) => {
        signal = deadline;
        return new Promise((resolve) => {
          resolveReply = resolve;
        });
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.source).toBe("library");
    expect(result.latencyMs).toBe(100);
    expect(signal?.aborted).toBe(true);
    resolveReply?.(finish);
    await vi.advanceTimersByTimeAsync(0);
    expect(result.events).toEqual([]);
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds final telemetry flush by the remaining budget without discarding a completed response", async () => {
    const { runPlanner } = await import("../src/server/planner");
    mocks.flush.mockImplementation(never);
    const pending = runPlanner(input, {
      deadlineMs: 100,
      chat: async () =>
        new Promise((resolve) => setTimeout(() => resolve(finish), 80)),
    });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.source).toBe("forge");
    expect(result.latencyMs).toBe(100);
    expect(result.events).toHaveLength(1);
    expect(mocks.flush).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps optional initialization at one second so inference retains its remaining budget", async () => {
    const { runPlanner } = await import("../src/server/planner");
    mocks.init.mockImplementation(never);
    const chat = vi.fn().mockResolvedValue(finish);
    const pending = runPlanner(input, { deadlineMs: 2000, chat });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.source).toBe("forge");
    expect(result.latencyMs).toBe(1000);
    expect(chat).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports completed flush time in latency and removes the deadline timer", async () => {
    const { runPlanner } = await import("../src/server/planner");
    mocks.flush.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 25)),
    );
    const pending = runPlanner(input, {
      deadlineMs: 100,
      chat: async () => finish,
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;
    expect(result.latencyMs).toBe(25);
    expect(result.plannerVersion).toBe("flowblock-planner-v1.1");
    expect(vi.getTimerCount()).toBe(0);
  });
});
