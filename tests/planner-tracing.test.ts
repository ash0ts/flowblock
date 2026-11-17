import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as weave from "weave";
import {
  compilePlan,
  defaultGear,
  defaultIntent,
  defaultScene,
} from "../src/domain";
import { runPlanner, type ChatResult } from "../src/server/planner";
import { proposeRevision } from "../src/server/revision-planner";
import { plan, analysis } from "./fixtures/revision";

// Keep the SDK's actual async context implementation; no exporter or model runs.
vi.mock("weave", async (importOriginal) => ({
  ...(await importOriginal<typeof import("weave")>()),
  init: vi.fn().mockResolvedValue({}),
  flushOTel: vi.fn().mockResolvedValue(undefined),
}));

const input = { scene: defaultScene, gear: defaultGear, intent: defaultIntent };
const reply = (action: object): ChatResult => ({
  content: JSON.stringify(action),
  usage: { inputTokens: 1, outputTokens: 1 },
});
const finish = {
  action: "finish",
  candidateIds: [
    compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold").id,
  ],
  explanation: "Compiled hero shot.",
};
const compile = { action: "compile_candidate", recipeId: "hero-hold" };
const revision = {
  action: "propose_revision",
  overrides: { durationSeconds: 5 },
  findingIds: ["duration:whole:0"],
  reason: "Match duration",
};

beforeEach(() => {
  vi.stubEnv("WANDB_API_KEY", "test-only");
  vi.stubEnv("WANDB_ENTITY", "test");
  vi.stubEnv("FLOWBLOCK_TRACE", "1");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Agent Lens conversation isolation", () => {
  it.each(["planner", "revision"] as const)(
    "retains separate conversations and active LLM spans for concurrent %s requests",
    async (kind) => {
      const seen: { conversation: string | undefined; llm: unknown }[] = [];
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = () => {
        let calls = 0;
        const chat = async () => {
          if (calls++ === 0) {
            seen.push({
              conversation: weave.getCurrentConversation()?.conversationId,
              llm: weave.getCurrentLLM(),
            });
            if (seen.length === 2) release();
            await barrier;
            return reply(
              kind === "planner" ? compile : { action: "read_take_findings" },
            );
          }
          return reply(kind === "planner" ? finish : revision);
        };
        return kind === "planner"
          ? runPlanner(input, { chat })
          : proposeRevision(plan, analysis, { chat });
      };
      const results = await Promise.all([run(), run()]);
      expect(results.every((result) => result.source === "forge")).toBe(true);
      expect(seen).toHaveLength(2);
      expect(seen.every((entry) => entry.conversation && entry.llm)).toBe(true);
      expect(new Set(seen.map((entry) => entry.conversation)).size).toBe(2);
      expect(new Set(seen.map((entry) => entry.llm)).size).toBe(2);
      expect(results.map((result) => result.traceId).sort()).toEqual(
        seen.map((entry) => entry.conversation).sort(),
      );
      expect(weave.getCurrentConversation()).toBeUndefined();
      expect(weave.getCurrentTurn()).toBeUndefined();
      expect(weave.getCurrentLLM()).toBeUndefined();
    },
  );

  it.each(["planner", "revision"] as const)(
    "marks the failed provider call itself in %s traces",
    async (kind) => {
      let recorded: ReturnType<typeof vi.spyOn> | undefined;
      const failure = new Error("Provider unavailable fixture");
      const chat = async () => {
        const llm = weave.getCurrentLLM();
        expect(llm).toBeDefined();
        recorded = vi.spyOn(llm!, "recordError");
        throw failure;
      };
      const result =
        kind === "planner"
          ? await runPlanner(input, { chat })
          : await proposeRevision(plan, analysis, { chat });
      expect(result.source).toBe("library");
      expect(recorded).toHaveBeenCalledWith(failure);
      expect(weave.getCurrentConversation()).toBeUndefined();
    },
  );

  it("records the actual planner response at the invocation root", async () => {
    let recorded: ReturnType<typeof vi.spyOn> | undefined;
    let attributes: ReturnType<typeof vi.spyOn> | undefined;
    let calls = 0;
    const result = await runPlanner(input, {
      chat: async () => {
        const turn = weave.getCurrentTurn()!;
        recorded = vi.spyOn(turn, "record");
        attributes = vi.spyOn(turn, "setAttributes");
        return reply(calls++ === 0 ? compile : finish);
      },
    });
    expect(recorded).toHaveBeenCalledWith({
      outputMessages: [{ role: "assistant", content: result.message }],
    });
    expect(attributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "flowblock.result_source": "forge",
        "flowblock.plan_count": 1,
      }),
    );
  });

  it("keeps rejected geometry visible without marking the repair budget as a provider crash", async () => {
    let errors: ReturnType<typeof vi.spyOn> | undefined;
    let attributes: ReturnType<typeof vi.spyOn> | undefined;
    const toolEnds: ReturnType<typeof vi.spyOn>[] = [];
    let setup = false;
    const result = await runPlanner(input, {
      chat: async () => {
        if (!setup) {
          setup = true;
          const turn = weave.getCurrentTurn()!;
          errors = vi.spyOn(turn, "recordError");
          attributes = vi.spyOn(turn, "setAttributes");
          const startTool = turn.startTool.bind(turn);
          vi.spyOn(turn, "startTool").mockImplementation((args) => {
            const tool = startTool(args);
            toolEnds.push(vi.spyOn(tool, "end"));
            return tool;
          });
        }
        return reply({ ...compile, overrides: { distance: 0.1 } });
      },
    });
    expect(result.events).toHaveLength(3);
    expect(result.events[2].observation).toMatchObject({
      error: "no_progress",
      repairBudget: { exhausted: true },
    });
    expect(errors).not.toHaveBeenCalled();
    expect(toolEnds).toHaveLength(3);
    for (const end of toolEnds)
      expect(end).toHaveBeenCalledWith({
        result: expect.stringContaining('"rejected":true'),
      });
    expect(attributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "flowblock.result_source": "library",
        "flowblock.outcome": "fallback",
        "flowblock.stop_reason": "repair_budget",
        "flowblock.rejected_actions": 3,
        "flowblock.compile_checks": 1,
      }),
    );
  });
});
