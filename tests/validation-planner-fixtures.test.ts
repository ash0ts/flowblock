import { describe, expect, it } from "vitest";
import { compilePlan } from "../src/domain";
import {
  gradePlan,
  provenUnsupported,
} from "../training/experiments/next/grade";
import {
  buildValidationSuite,
  independentlyCheckPlan,
} from "../training/experiments/validation-planner/fixtures";

const suite = buildValidationSuite();
describe("controlled planner validation fixtures", () => {
  it("constructs disjoint groups with balanced conditions and retained witnesses", () => {
    expect(suite.tasks).toHaveLength(48);
    expect(new Set(suite.tasks.map((task) => task.sceneGroup)).size).toBe(12);
    expect(new Set(suite.tasks.map((task) => task.topology)).size).toBe(3);
    expect(Object.keys(suite.witnesses)).toHaveLength(36);
    expect(suite.construction.filter((row) => row.accepted)).toHaveLength(12);
    for (const task of suite.tasks) {
      const witness = suite.witnesses[task.id];
      if (suite.conditions[task.id] === "unsupported") {
        expect(provenUnsupported(task)).not.toBeNull();
        expect(witness).toBeUndefined();
      } else {
        expect(gradePlan(task, witness).productive).toBe(true);
        expect(independentlyCheckPlan(task, witness).valid).toBe(true);
      }
    }
  });
  it("changes only wording in paraphrases and invalidates the original path in perturbations", () => {
    for (const original of suite.tasks.filter(
      (task) => suite.conditions[task.id] === "original",
    )) {
      const paraphrase = suite.tasks.find(
        (task) => task.id === `${original.sceneGroup}-paraphrase`,
      )!;
      expect(paraphrase.input.scene).toEqual(original.input.scene);
      expect(paraphrase.input.gear).toEqual(original.input.gear);
      expect(paraphrase.briefSpec).toEqual(original.briefSpec);
      expect(paraphrase.input.prompt).not.toBe(original.input.prompt);
      expect(paraphrase.input.intent.brief).toBe(paraphrase.input.prompt);
      const changed = suite.tasks.find(
        (task) => task.id === `${original.sceneGroup}-geometry-perturbation`,
      )!;
      const old = suite.witnesses[original.id];
      const reused = compilePlan(
        changed.input.scene,
        changed.input.gear,
        changed.input.intent,
        old.recipeId,
        old.overrides,
      );
      expect(reused.validation.valid).toBe(false);
      expect(independentlyCheckPlan(changed, reused).valid).toBe(false);
      expect(changed.input.intent).toEqual(original.input.intent);
    }
  });
  it("rejects fabricated validity, wrong motion, and changed source facts independently", () => {
    const task = suite.tasks.find(
      (item) =>
        item.briefSpec.family === "push-in" &&
        suite.conditions[item.id] === "original",
    )!;
    const witness = suite.witnesses[task.id];
    const teleported = structuredClone(witness);
    teleported.path.start.x += 50;
    teleported.path.end.x += 50;
    teleported.validation.valid = true;
    expect(independentlyCheckPlan(task, teleported).valid).toBe(false);
    const reversed = structuredClone(witness);
    [reversed.path.start, reversed.path.end] = [
      reversed.path.end,
      reversed.path.start,
    ];
    expect(independentlyCheckPlan(task, reversed).checks.direction).toBe(false);
    const changedSource = structuredClone(witness);
    changedSource.scene.obstacles = [];
    expect(independentlyCheckPlan(task, changedSource).checks.source).toBe(
      false,
    );
    const longer = structuredClone(witness);
    longer.durationSeconds += 2;
    expect(independentlyCheckPlan(task, longer).checks.duration).toBe(false);
  });
  it("reproduces the same frozen inputs and construction decisions", () => {
    expect(buildValidationSuite()).toEqual(suite);
  });
});
