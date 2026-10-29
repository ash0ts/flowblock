import { describe, it, expect } from "vitest";
import { runPlanner, type ChatResult } from "../src/server/planner";
import {
  defaultScene,
  defaultGear,
  defaultIntent,
  compilePlan,
} from "../src/domain";
const input = { scene: defaultScene, gear: defaultGear, intent: defaultIntent };
const reply = (action: unknown): ChatResult => ({
  content: JSON.stringify(action),
  usage: { inputTokens: 10, outputTokens: 10 },
});
describe("planner execution boundary", () => {
  it("cannot mutate scene facts or run an unknown action", async () => {
    let calls = 0;
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => {
        calls++;
        return reply({
          action: "move_obstacle",
          obstacleId: "table",
          center: { x: 99, z: 99 },
        });
      },
    });
    expect(calls).toBe(3);
    expect(result.source).toBe("library");
    expect(defaultScene.subject.center.x).toBe(0);
    expect(result.plans.every((p) => p.validation.valid)).toBe(true);
  });
  it("never accepts unknown candidate identifiers", async () => {
    const result = await runPlanner(input, {
      trace: false,
      chat: async () =>
        reply({
          action: "finish",
          candidateIds: ["invented"],
          explanation: "This is safe.",
        }),
    });
    expect(result.source).toBe("library");
    expect(result.events).toHaveLength(6);
  });
  it("returns the compiled validated plan, not model-supplied coordinates", async () => {
    let i = 0;
    const plan = compilePlan(
      defaultScene,
      defaultGear,
      defaultIntent,
      "hero-hold",
    );
    const result = await runPlanner(input, {
      trace: false,
      chat: async () =>
        reply(
          i++ === 0
            ? { action: "compile_candidate", recipeId: "hero-hold" }
            : {
                action: "finish",
                candidateIds: [plan.id],
                explanation: "A stationary hero composition fits this setup.",
              },
        ),
    });
    expect(result.source).toBe("forge");
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0].validation.valid).toBe(true);
    expect(result.usage.inputTokens).toBe(20);
  });
  it("preserves input and offers explicit library fallback on provider failure", async () => {
    const result = await runPlanner(input, {
      trace: false,
      chat: async () => {
        throw new Error("Provider unavailable");
      },
    });
    expect(result.source).toBe("library");
    expect(result.message).toContain("could not finish");
    expect(result.events).toEqual([]);
  });
  it("rejects invalid caller geometry before any model request", async () => {
    let called = false;
    await expect(
      runPlanner(
        { ...input, scene: { ...defaultScene, boundary: [] } },
        {
          trace: false,
          chat: async () => {
            called = true;
            return reply({});
          },
        },
      ),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });
});
