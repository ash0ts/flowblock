import { isDeepStrictEqual } from "node:util";
import {
  compilePlan,
  samplePlan,
  type Family,
  type PlanVersion,
} from "../../../src/domain";
import type { PlanningInput } from "../../../src/server/planner";

export const checkerVersion = "flowblock-brief-checker-v4";
export type BriefSpec = {
  family: Family;
  direction: "left" | "right" | "either";
  minimumTravel: number;
  minimumOrbitDegrees: number;
  requiresForegroundOcclusion: boolean;
};
export type Task = {
  id: string;
  sceneGroup: string;
  split: "train" | "development" | "confirmation";
  topology: string;
  geometryHash: string;
  input: PlanningInput;
  briefSpec: BriefSpec;
  provenance: { kind: "authored-synthetic"; seed: number };
};

/** Grades executable motion and declared constraints, not cinematic quality. */
export function gradePlan(task: Task, plan: PlanVersion) {
  const sourcePreserved =
    isDeepStrictEqual(plan.scene, task.input.scene) &&
    isDeepStrictEqual(plan.gear, task.input.gear) &&
    isDeepStrictEqual(plan.intent, task.input.intent);
  const compiled = compilePlan(
    task.input.scene,
    task.input.gear,
    task.input.intent,
    plan.recipeId,
    plan.overrides,
  );
  const sourceMotionMatches =
    isDeepStrictEqual(plan.path, compiled.path) &&
    plan.durationSeconds === compiled.durationSeconds &&
    plan.cameraHeight === compiled.cameraHeight;
  const start = samplePlan(compiled, 0),
    end = samplePlan(compiled, 1),
    middle = samplePlan(compiled, 0.5);
  const subject = task.input.scene.subject.center;
  const radialStart = Math.hypot(
    start.position.x - subject.x,
    start.position.z - subject.z,
  );
  const radialEnd = Math.hypot(
    end.position.x - subject.x,
    end.position.z - subject.z,
  );
  const bearing = Math.atan2(
    middle.position.x - subject.x,
    middle.position.z - subject.z,
  );
  const tangentTravel =
    (end.position.x - start.position.x) * Math.cos(bearing) -
    (end.position.z - start.position.z) * Math.sin(bearing);
  const checks: Record<string, boolean> = {
    source_preserved: sourcePreserved && sourceMotionMatches,
    feasible: compiled.validation.valid,
    family: compiled.family === task.briefSpec.family,
    duration:
      Math.abs(compiled.durationSeconds - task.input.intent.durationSeconds) <
      0.001,
    height:
      Math.abs(compiled.cameraHeight - task.input.intent.cameraHeight) < 0.01,
    supported_effect: !task.briefSpec.requiresForegroundOcclusion,
    motion: compiled.arcLength >= task.briefSpec.minimumTravel - 0.000001,
    direction: true,
  };
  const f = task.briefSpec.family;
  if (f === "hold") checks.motion = compiled.arcLength < 0.001;
  if (f === "push-in")
    checks.direction =
      radialStart - radialEnd >= task.briefSpec.minimumTravel - 0.000001 &&
      end.coverage > start.coverage + 1e-6;
  if (f === "pull-out")
    checks.direction =
      radialEnd - radialStart >= task.briefSpec.minimumTravel - 0.000001 &&
      start.coverage > end.coverage + 1e-6;
  if (f === "orbit")
    checks.motion =
      checks.motion &&
      compiled.path.kind === "arc" &&
      (Math.abs(compiled.path.sweepAngle) * 180) / Math.PI >=
        task.briefSpec.minimumOrbitDegrees - 0.000001;
  if (
    ["lateral", "orbit", "reveal"].includes(f) &&
    task.briefSpec.direction !== "either"
  ) {
    checks.direction =
      task.briefSpec.direction === "right"
        ? tangentTravel > 0.01
        : tangentTravel < -0.01;
  }
  return {
    productive: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks)
      .filter(([, v]) => !v)
      .map(([k]) => k),
    minClearance: compiled.validation.minClearance,
    arcLength: compiled.arcLength,
    tangentTravel,
    radialChange: radialEnd - radialStart,
    violationCodes: compiled.validation.violations
      .filter((v) => v.severity === "error")
      .map((v) => v.code),
  };
}

export function provenUnsupported(task: Task): string | null {
  if (task.briefSpec.requiresForegroundOcclusion)
    return "Foreground occlusion is not modeled by the supported recipes.";
  if (
    task.input.gear.stabilizer === "tripod" &&
    task.briefSpec.family !== "hold"
  )
    return "The declared fixed tripod cannot perform the requested translation.";
  if (
    task.input.intent.cameraHeight < task.input.gear.minHeight ||
    task.input.intent.cameraHeight > task.input.gear.maxHeight
  )
    return "The requested fixed camera height is outside the declared gear range.";
  return null;
}
