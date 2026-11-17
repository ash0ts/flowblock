import { describe, expect, it } from "vitest";
import { compilePlan } from "../src/domain";
import { createTasks } from "../training/experiments/next/fixtures";
import { gradePlan } from "../training/experiments/next/grade";

describe("fresh research brief checks", () => {
  it("varies widths and geometry and keeps scene groups disjoint", () => {
    const a = createTasks("train", 12, 123),
      b = createTasks("confirmation", 12, 456);
    expect(new Set(a.map((t) => t.input.scene.boundary[1].x)).size).toBe(12);
    expect(new Set(a.map((t) => t.topology)).size).toBe(3);
    expect(
      b.some((t) => a.some((s) => s.geometryHash === t.geometryHash)),
    ).toBe(false);
    expect(a).toEqual(createTasks("train", 12, 123));
  });
  it("rejects a reversed push even though its family label still matches", () => {
    const task = createTasks("development", 1, 321).find(
      (t) => t.briefSpec.family === "push-in",
    )!;
    const p = compilePlan(
      task.input.scene,
      task.input.gear,
      task.input.intent,
      "gentle-push",
      { reverse: true },
    );
    expect(p.family).toBe("push-in");
    expect(gradePlan(task, p).checks.direction).toBe(false);
  });
  it("accepts the requested small push without inventing a five-percent size threshold", () => {
    const task = createTasks("train", 11, 2026102901).find(
      (item) => item.id === "train-010-push-in",
    )!;
    const plan = compilePlan(
      task.input.scene,
      task.input.gear,
      task.input.intent,
      "gentle-push",
      { travel: 0.1, bearingDeg: 0, height: task.input.intent.cameraHeight },
    );
    expect(plan.validation.valid).toBe(true);
    expect(
      plan.framing.endCoverage / plan.framing.startCoverage,
    ).toBeGreaterThan(1);
    expect(plan.framing.endCoverage / plan.framing.startCoverage).toBeLessThan(
      1.05,
    );
    expect(gradePlan(task, plan).productive).toBe(true);
  });
  it("rejects zero travel, changed duration, and unsupported occlusion claims", () => {
    const tasks = createTasks("development", 6, 321),
      task = tasks.find((t) => t.briefSpec.family === "lateral")!;
    const p = compilePlan(
      task.input.scene,
      task.input.gear,
      task.input.intent,
      "left-slide",
      { travel: 0, durationSeconds: 2 },
    );
    expect(gradePlan(task, p).failedChecks).toEqual(
      expect.arrayContaining(["motion", "direction", "duration"]),
    );
    const reveal = tasks.find((t) => t.briefSpec.requiresForegroundOcclusion)!;
    expect(
      gradePlan(
        reveal,
        compilePlan(
          reveal.input.scene,
          reveal.input.gear,
          reveal.input.intent,
          "left-reveal",
        ),
      ).checks.supported_effect,
    ).toBe(false);
  });
});
