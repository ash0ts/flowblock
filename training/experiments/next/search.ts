import {
  compilePlan,
  FamilySchema,
  recipes,
  type Family,
  type Overrides,
  type PlanVersion,
} from "../../../src/domain";
import type { PlanningInput } from "../../../src/server/planner";

export const searchVersion = "flowblock-family-search-v2";
const bearings = [0, -35, 35, -70, 70, -90, 90, 180];
const movementScales = [1, 0.75, 0.5];

export type SearchOptions = { family: Family; maxCandidates?: number };
export type SearchResult = {
  searchVersion: typeof searchVersion;
  family: Family;
  plans: PlanVersion[];
  sampledCandidates: number;
  budgetReached: boolean;
  disclosure: string;
};

/** Finds valid witnesses in a fixed grid. An empty result does not prove infeasibility. */
export function search(
  input: PlanningInput,
  options: SearchOptions,
): SearchResult {
  const family = FamilySchema.parse(options.family);
  const limit = options.maxCandidates ?? 128;
  if (!Number.isInteger(limit) || limit < 1 || limit > 512)
    throw new Error("Search requires a candidate budget between 1 and 512.");
  const plans = new Map<string, PlanVersion>();
  let sampledCandidates = 0;
  const result = (budgetReached: boolean): SearchResult => ({
    searchVersion,
    family,
    plans: [...plans.values()].sort(
      (a, b) => b.score - a.score || a.id.localeCompare(b.id),
    ),
    sampledCandidates,
    budgetReached,
    disclosure:
      "Valid plans are witnesses against the supplied geometry and current engine. This finite parameter search does not prove that other plans are infeasible or that a plan preserves every creative requirement.",
  });
  const accept = (plan: PlanVersion) => {
    sampledCandidates++;
    if (plan.validation.valid) plans.set(plan.id, plan);
  };
  for (const recipe of recipes.filter((item) => item.family === family)) {
    for (const bearingDeg of new Set([recipe.bearingDeg, ...bearings])) {
      if (sampledCandidates === limit) return result(true);
      const base = compilePlan(
        input.scene,
        input.gear,
        input.intent,
        recipe.id,
        { bearingDeg, height: input.intent.cameraHeight },
      );
      accept(base);
      if (family === "hold") continue;
      for (const scale of movementScales.slice(1)) {
        if (sampledCandidates === limit) return result(true);
        const overrides: Overrides =
          family === "orbit"
            ? {
                bearingDeg,
                height: input.intent.cameraHeight,
                orbitDegrees: (base.path.sweepAngle * 180 * scale) / Math.PI,
              }
            : {
                bearingDeg,
                height: input.intent.cameraHeight,
                travel: base.arcLength * scale,
              };
        accept(
          compilePlan(
            input.scene,
            input.gear,
            input.intent,
            recipe.id,
            overrides,
          ),
        );
      }
    }
  }
  return result(false);
}
