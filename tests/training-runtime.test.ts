import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  loadEvaluationRuntime,
  verifyFrozenSources,
} from "../training/runtime";

// Frozen reproduction must work even if the product modules cannot be loaded.
vi.mock("../src/domain", () => {
  throw new Error("Frozen runtime imported the live domain");
});
vi.mock("../src/server/planner", () => {
  throw new Error("Frozen runtime imported the live planner");
});
vi.mock("../training/evaluation", () => {
  throw new Error("Frozen runtime imported the live grader");
});
vi.mock("../training/fixtures", () => {
  throw new Error("Frozen runtime imported the live fixtures");
});

describe("historical runtime isolation", () => {
  it("reconstructs all original source hashes through reversible import-only rewrites", async () => {
    const { hashes } = await verifyFrozenSources();
    const original = JSON.parse(
      await readFile("training/frozen/runtime-manifest.json", "utf8"),
    );
    expect(hashes["src/server/planner.ts"]).toBe(original.snapshotSha256);
    for (const [path, hash] of Object.entries(original.dependencies))
      expect(hashes[path]).toBe(hash);
  });

  it("regenerates the complete fixture bytes without loading product modules", async () => {
    const frozen = await loadEvaluationRuntime("frozen-v1");
    const original = await readFile("training/frozen/fixtures.json", "utf8");
    expect(
      `${JSON.stringify(frozen.fixtures.createFixtures(), null, 2)}\n`,
    ).toBe(original);
    expect(frozen.runtime.plannerVersion).toBe("flowblock-planner-v1");
  });

  it("plans and grades with the same archived geometry and action contracts", async () => {
    const { runtime, domain, checker, fixtures } =
      await loadEvaluationRuntime("frozen-v1");
    const fixture = fixtures
      .createFixtures()
      .find((f) => f.split === "test" && f.oracle.feasible)!;
    const plan = domain.compilePlan(
      fixture.input.scene,
      fixture.input.gear,
      fixture.input.intent,
      fixture.oracle.recipeId!,
      fixture.oracle.overrides,
    );
    let calls = 0;
    const result = await runtime.runPlanner(fixture.input, {
      trace: false,
      chat: async () => ({
        content: JSON.stringify(
          calls++ === 0
            ? {
                action: "compile_candidate",
                recipeId: plan.recipeId,
                overrides: plan.overrides,
              }
            : {
                action: "finish",
                candidateIds: [plan.id],
                explanation: "Compiled fixture candidate.",
              },
        ),
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    });
    expect(result.plans[0].id).toBe(fixture.oracle.candidateId);
    expect(checker.gradeResult(fixture, result, "base").success).toBe(true);
  });
});
