import { createHash } from "node:crypto";
import {
  compilePlan,
  defaultGear,
  defaultIntent,
  defaultScene,
  recipes,
  type Family,
  type Overrides,
  type PlanVersion,
} from "../src/domain";
import { type PlanningInput } from "../src/server/planner";

export const fixtureVersion = "flowblock-fixtures-v1";
export const families: Family[] = [
  "hold",
  "push-in",
  "pull-out",
  "lateral",
  "orbit",
  "reveal",
];
export const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
export type Fixture = {
  id: string;
  sceneGroup: string;
  split: "train" | "dev" | "test";
  geometryHash: string;
  expectedFamily: Family;
  input: PlanningInput;
  oracle: {
    searchVersion: string;
    feasible: boolean;
    recipeId?: PlanVersion["recipeId"];
    overrides?: Overrides;
    candidateId?: string;
  };
};
const descriptions: Record<Family, string> = {
  hold: "Keep the camera stationary for a clean hero composition.",
  "push-in": "Move the camera closer to the product in a gentle push-in.",
  "pull-out": "Move away from the product to reveal more of its surroundings.",
  lateral: "Slide sideways while keeping the product in the frame.",
  orbit: "Move in a short curved orbit around the front of the product.",
  reveal:
    "Use an angled lateral reveal into the hero view. Explain that foreground occlusion must be checked separately.",
};
export function oraclePlans(
  input: PlanningInput,
  family: Family,
): PlanVersion[] {
  const candidates: PlanVersion[] = [];
  for (const recipe of recipes.filter((r) => r.family === family))
    for (const bearingDeg of [recipe.bearingDeg, -35, 35]) {
      const overrides: Overrides = { bearingDeg };
      const plan = compilePlan(
        input.scene,
        input.gear,
        input.intent,
        recipe.id,
        overrides,
      );
      if (plan.validation.valid) candidates.push(plan);
    }
  return candidates.sort(
    (a, b) => b.score - a.score || a.recipeId.localeCompare(b.recipeId),
  );
}
export function createFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const split of ["train", "dev", "test"] as const) {
    const sceneCount = split === "train" ? 24 : split === "dev" ? 6 : 12;
    const offset = split === "train" ? 0 : split === "dev" ? 100 : 200;
    for (let sceneIndex = 0; sceneIndex < sceneCount; sceneIndex++) {
      const number = offset + sceneIndex;
      const sceneGroup = `${split}-scene-${String(sceneIndex).padStart(2, "0")}`;
      const scene = structuredClone(defaultScene);
      scene.id = sceneGroup;
      scene.name = `Synthetic studio ${number}`;
      const width = 3.2 + ((number * 17 + 3) % 17) * 0.13;
      const front = 2.2 + ((number * 11 + 5) % 19) * 0.11;
      scene.boundary = [
        { x: -width, z: -3 },
        { x: width, z: -3 },
        { x: width, z: front },
        { x: -width, z: front },
      ];
      scene.subject.width = 0.15 + ((number * 7 + 3) % 11) * 0.012;
      scene.subject.depth = 0.14 + ((number * 13 + 1) % 11) * 0.011;
      scene.subject.height = 0.28 + ((number * 5 + 2) % 13) * 0.012;
      scene.subject.yawDeg = ((number * 17) % 70) - 35;
      scene.measurementUncertainty = 0.02 + (number % 4) * 0.015;
      scene.obstacles[1].center = {
        x: 1.15 + (number % 7) * 0.13,
        z: 0.5 + (number % 5) * 0.3,
      };
      scene.obstacles[1].yawDeg = (number * 7) % 90;
      const gear = structuredClone(defaultGear);
      gear.lens = {
        kind: "equivalent",
        focalLengthMm: [35, 50, 65][number % 3],
      };
      gear.aspectRatio = number % 4 === 0 ? "portrait" : "landscape";
      gear.operatorRadius = 0.23 + (number % 4) * 0.025;
      gear.stabilizer = number % 11 === 7 ? "tripod" : "gimbal";
      const geometryHash = digest({ ...scene, id: "", name: "" });
      for (const family of families) {
        const intent = {
          ...defaultIntent,
          durationSeconds: [6, 8, 10][number % 3],
          cameraHeight: 1.1 + (number % 5) * 0.07,
          brief: descriptions[family],
        };
        const input: PlanningInput = {
          scene,
          gear,
          intent,
          prompt: descriptions[family],
        };
        const candidate = oraclePlans(input, family)[0];
        fixtures.push({
          id: `${sceneGroup}-${family}`,
          sceneGroup,
          split,
          geometryHash,
          expectedFamily: family,
          input,
          oracle: {
            searchVersion: "two-family-recipes-three-bearings-v1",
            feasible: !!candidate,
            ...(candidate
              ? {
                  recipeId: candidate.recipeId,
                  overrides: candidate.overrides,
                  candidateId: candidate.id,
                }
              : {}),
          },
        });
      }
    }
  }
  return fixtures;
}
