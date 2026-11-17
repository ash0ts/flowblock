import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compilePlan,
  defaultGear,
  defaultIntent,
  defaultScene,
} from "../src/domain";
import type { ChatResult, PlannerMessage } from "../src/server/planner";
import {
  actionSchema,
  initialMessages,
  observeCompile,
  researchPlannerVersion,
  runResearchPlanner,
} from "../training/experiments/next/planner";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  flush: vi.fn(),
  start: vi.fn(),
}));
vi.mock("weave", () => ({
  init: mocks.init,
  flushOTel: mocks.flush,
  startConversation: mocks.start,
  runIsolated: <T>(run: () => T) => run(),
}));
const input = { scene: defaultScene, gear: defaultGear, intent: defaultIntent };
const reply = (action: unknown): ChatResult => ({
  content: JSON.stringify(action),
  usage: { inputTokens: 2, outputTokens: 1 },
});
const compile = { action: "compile_candidate", recipeId: "hero-hold" };
const empty = {
  action: "finish",
  candidateIds: [],
  explanation: "Every possible shot is impossible.",
};
const successfulFinish = () => ({
  action: "finish",
  candidateIds: [
    compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold").id,
  ],
  explanation: "A stationary hero view.",
});

beforeEach(() => {
  vi.stubEnv("WANDB_API_KEY", "test-only");
  vi.stubEnv("WANDB_ENTITY", "test");
  vi.stubEnv("FLOWBLOCK_TRACE", "1");
  mocks.init.mockReset().mockResolvedValue({});
  mocks.flush.mockReset().mockResolvedValue(undefined);
  mocks.start.mockReset().mockImplementation(() => ({
    conversationId: "test-research",
    end: vi.fn(),
    startTurn: () => ({
      end: vi.fn(),
      record: vi.fn(),
      setAttributes: vi.fn(),
      recordError: vi.fn(),
      startLLM: () => ({ end: vi.fn(), output: vi.fn(), record: vi.fn() }),
      startTool: () => ({ end: vi.fn() }),
    }),
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("research-only planning protocol", () => {
  it("rejects an unchecked empty finish and then accepts an actual validated candidate", async () => {
    const replies = [empty, compile, successfulFinish()];
    const seen: PlannerMessage[][] = [];
    const result = await runResearchPlanner(input, {
      trace: false,
      chat: async (messages) => {
        seen.push(messages);
        return reply(replies[seen.length - 1]);
      },
    });
    expect(result.termination).toBe("finished");
    expect(result.plans).toHaveLength(1);
    expect(result.events[0].observation).toMatchObject({
      error: "unchecked_abstention",
    });
    expect(seen.map((messages) => messages.length)).toEqual([2, 4, 6]);
    expect(seen[0]).toEqual(initialMessages(input));
    expect(result.plannerVersion).toBe(researchPlannerVersion);
    expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 3 });
  });
  it("retains the third rejected compile and its observation before ending the repair budget", async () => {
    let calls = 0;
    const result = await runResearchPlanner(input, {
      trace: false,
      chat: async () =>
        reply({ ...compile, overrides: { distance: 0.1 + calls++ * 0.01 } }),
    });
    expect(result.termination).toBe("repair-budget");
    expect(calls).toBe(3);
    expect(result.events).toHaveLength(3);
    expect(
      result.events.every(
        (event) =>
          (event.observation as { validation: { valid: boolean } }).validation
            .valid === false,
      ),
    ).toBe(true);
    expect(result.plans).toEqual([]);
  });
  it("records every invalid revision action as a protocol failure", async () => {
    const action = { action: "read_take_findings" };
    expect(actionSchema.safeParse(action).success).toBe(false);
    const result = await runResearchPlanner(input, {
      trace: false,
      chat: async () => reply(action),
    });
    expect(result.termination).toBe("repair-budget");
    expect(result.events).toHaveLength(3);
    expect(
      result.events.every(
        (event) =>
          (event.observation as { error: string }).error === "invalid_action",
      ),
    ).toBe(true);
  });
  it("states only the scope of observed checks for an accepted empty result", async () => {
    const actions = [{ ...compile, overrides: { distance: 0.1 } }, empty];
    const result = await runResearchPlanner(input, {
      trace: false,
      chat: async () => reply(actions.shift()),
    });
    expect(result.termination).toBe("finished");
    expect(result.plans).toEqual([]);
    expect(result.message).toContain("after 1 compile checks");
    expect(result.message).toContain("do not prove");
    expect(result.message).toContain(empty.explanation);
  });
  it("keeps observer failures from changing the candidate and records the actual model identity", async () => {
    mocks.start.mockImplementation(() => {
      throw new Error("Observer failed");
    });
    const model = "wandb-artifact:///test/research/candidate:step1";
    const actions = [compile, successfulFinish()];
    const seen: string[] = [];
    const result = await runResearchPlanner(input, {
      model,
      chat: async (_messages, actualModel) => {
        seen.push(actualModel);
        return reply(actions.shift());
      },
    });
    expect(result.termination).toBe("finished");
    expect(result.plans).toHaveLength(1);
    expect(result.model).toBe(model);
    expect(seen).toEqual([model, model]);
    expect(mocks.start).toHaveBeenCalledWith(
      expect.objectContaining({ model, agentVersion: researchPlannerVersion }),
    );
  });
  it("classifies provider failure without presenting a fallback as model output", async () => {
    const result = await runResearchPlanner(input, {
      trace: false,
      chat: async () => {
        throw new Error("Transport failed");
      },
    });
    expect(result.termination).toBe("provider-error");
    expect(result.failure).toMatchObject({
      kind: "provider-error",
      stage: "inference",
    });
    expect(result.plans).toEqual([]);
    expect(result.events).toEqual([]);
  });
  it("rejects a late response under the shared deadline", async () => {
    vi.useFakeTimers();
    let release: ((response: ChatResult) => void) | undefined;
    const pending = runResearchPlanner(input, {
      trace: false,
      deadlineMs: 50,
      chat: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;
    expect(result.termination).toBe("deadline");
    expect(result.events).toEqual([]);
    release?.(reply(compile));
    await vi.advanceTimersByTimeAsync(0);
    expect(result.events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("exposes actual motion in the teacher observation, including reversed directions", () => {
    const plan = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "gentle-push",
      { reverse: true },
    );
    const observation = observeCompile(plan);
    expect(observation.motion.endDistanceMeters).toBeGreaterThan(
      observation.motion.startDistanceMeters,
    );
    expect(observation.motion.travelMeters).toBe(plan.arcLength);
    expect(observation.validation).toEqual(plan.validation);
  });
});
