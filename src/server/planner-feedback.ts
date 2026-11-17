import {
  compilePlan,
  recipes,
  type Intent,
  type Overrides,
  type PlanVersion,
  type Recipe,
} from "@/domain";

const bearingRepairOffsets = [
  15, -15, 30, -30, 45, -45, 60, -60, 90, -90, 120, -120,
] as const;
const collisionCodes = new Set([
  "camera_boundary",
  "operator_boundary",
  "camera_obstacle",
  "operator_obstacle",
]);

const commonOverrides = [
  "distance",
  "bearingDeg",
  "height",
  "durationSeconds",
] as const;

export function allowedOverrides(recipe: Recipe): (keyof Overrides)[] {
  if (recipe.family === "hold") return [...commonOverrides];
  return [
    ...commonOverrides,
    recipe.family === "orbit" ? "orbitDegrees" : "travel",
    "reverse",
  ];
}

export const parameterUnits = {
  distance:
    "meters of base radial distance on the floor; orbit radius, line midpoint radius, or reveal hero-endpoint radius; omitted means solve from framing",
  travel: "meters of linear camera travel; unused by holds and orbits",
  bearingDeg:
    "degrees of viewing-side placement, or arc midpoint bearing; zero is product +z, increasing toward +x; its sign does not determine movement direction",
  orbitDegrees:
    "signed degrees of arc before reverse; positive moves camera-right while facing the product, negative camera-left; reverse flips the compiled sweep",
  height: "meters above the floor",
  durationSeconds: "seconds",
  reverse: "boolean; reverses the complete path and its motion direction",
};

export function recipeContext(intent: Intent) {
  const movementScale =
    intent.motion === "subtle" ? 0.65 : intent.motion === "dynamic" ? 1.4 : 1;
  return recipes.map((recipe) => ({
    id: recipe.id,
    family: recipe.family,
    name: recipe.name,
    description: recipe.description,
    allowedOverrides: allowedOverrides(recipe),
    defaults: {
      bearingDeg: recipe.bearingDeg,
      height: intent.cameraHeight + recipe.heightOffset,
      durationSeconds: intent.durationSeconds,
      ...(recipe.family === "orbit"
        ? { orbitDegrees: recipe.orbitDegrees * movementScale, reverse: false }
        : recipe.family === "hold"
          ? {}
          : { reverse: false }),
    },
    computedDefaults: {
      distance: "solved from product dimensions, lens, and framing targets",
      ...(["push-in", "pull-out", "lateral", "reveal"].includes(recipe.family)
        ? {
            travel: {
              method: "fraction of solved distance",
              fraction: Math.abs(recipe.travelFactor) * movementScale,
            },
          }
        : {}),
    },
  }));
}

export function compileFingerprint(
  recipeId: string,
  overrides: Overrides = {},
) {
  return JSON.stringify({
    recipeId,
    overrides: Object.fromEntries(
      Object.entries(overrides).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  });
}

export function intentMismatches(plan: PlanVersion, intent: Intent) {
  const tolerance = 1e-6;
  return [
    {
      field: "cameraHeight",
      override: "height",
      requested: intent.cameraHeight,
      actual: plan.cameraHeight,
      unit: "meters",
      tolerance,
    },
    {
      field: "durationSeconds",
      override: "durationSeconds",
      requested: intent.durationSeconds,
      actual: plan.durationSeconds,
      unit: "seconds",
      tolerance,
    },
  ].filter(({ requested, actual }) => Math.abs(requested - actual) > tolerance);
}

/** Orbit traversal is measured from the compiled arc, including reversal. */
export function orbitDirectionContext(
  plan: PlanVersion,
  reference?: PlanVersion,
) {
  if (plan.path.kind !== "arc") return undefined;
  const degrees = (angle: number) => (angle * 180) / Math.PI;
  return {
    direction:
      plan.path.sweepAngle > 0
        ? "camera-right"
        : plan.path.sweepAngle < 0
          ? "camera-left"
          : "stationary",
    directionBasis:
      "Camera lateral movement while facing the product; not world-x movement or product movement in the image.",
    signedSweepDegrees: degrees(plan.path.sweepAngle),
    startBearingDeg: degrees(plan.path.startAngle),
    endBearingDeg: degrees(plan.path.startAngle + plan.path.sweepAngle),
    ...(reference?.path.kind === "arc"
      ? {
          referenceSweepDegrees: degrees(reference.path.sweepAngle),
          preservesSweep:
            Math.abs(plan.path.sweepAngle - reference.path.sweepAngle) <= 1e-9,
        }
      : {}),
  };
}

/** Search suggestions stay outside the coordinator's selectable candidates. */
export function searchBearingRepairs(plan: PlanVersion) {
  if (
    intentMismatches(plan, plan.intent).length ||
    !plan.validation.violations.some(
      (item) => item.severity === "error" && collisionCodes.has(item.code),
    )
  )
    return undefined;
  const started = performance.now();
  const recipe = recipes.find((item) => item.id === plan.recipeId)!;
  const baseBearingDeg = plan.overrides.bearingDeg ?? recipe.bearingDeg;
  const trials: {
    offsetDeg: number;
    overrides: Overrides;
    valid: boolean;
    rejectionCodes: string[];
  }[] = [];
  const options: {
    recipeId: PlanVersion["recipeId"];
    family: PlanVersion["family"];
    overrides: Overrides;
    radiusMeters: number;
    minClearanceMeters: number;
    framing: PlanVersion["framing"];
    cameraHeightMeters: number;
    durationSeconds: number;
    motion: {
      kind: PlanVersion["path"]["kind"];
      travelMeters: number;
      orbitSweepDegrees: number;
      orbit: ReturnType<typeof orbitDirectionContext>;
      start: PlanVersion["path"]["start"];
      end: PlanVersion["path"]["end"];
      startDistanceMeters: number;
      endDistanceMeters: number;
    };
    tradeoff: string;
  }[] = [];
  for (const offsetDeg of bearingRepairOffsets) {
    const bearingDeg =
      ((((baseBearingDeg + offsetDeg + 180) % 360) + 360) % 360) - 180;
    const overrides = { ...plan.overrides, bearingDeg };
    const candidate = compilePlan(
      plan.scene,
      plan.gear,
      plan.intent,
      plan.recipeId,
      overrides,
    );
    const mismatches = intentMismatches(candidate, plan.intent);
    const rejectionCodes = candidate.validation.violations
      .filter((item) => item.severity === "error")
      .map((item) => item.code);
    if (mismatches.length) rejectionCodes.push("intent_mismatch");
    const valid = candidate.validation.valid && !mismatches.length;
    trials.push({ offsetDeg, overrides, valid, rejectionCodes });
    if (!valid) continue;
    options.push({
      recipeId: candidate.recipeId,
      family: candidate.family,
      overrides,
      radiusMeters: candidate.path.radius,
      minClearanceMeters: candidate.validation.minClearance,
      framing: candidate.framing,
      cameraHeightMeters: candidate.cameraHeight,
      durationSeconds: candidate.durationSeconds,
      motion: {
        kind: candidate.path.kind,
        travelMeters: candidate.arcLength,
        orbitSweepDegrees: (candidate.path.sweepAngle * 180) / Math.PI,
        orbit: orbitDirectionContext(candidate, plan),
        start: candidate.path.start,
        end: candidate.path.end,
        startDistanceMeters: candidate.keyframes[0].distance,
        endDistanceMeters: candidate.keyframes.at(-1)!.distance,
      },
      tradeoff:
        "Changes the viewing side and world heading. The recipe, reversal setting, camera height, duration, scene, and gear stay fixed. If distance was omitted, the framing solver recalculates radius and default travel; inspect the measured motion against the brief.",
    });
    if (options.length === 3) break;
  }
  return {
    method: "bounded-bearing-search-v1",
    referenceOrbit: orbitDirectionContext(plan),
    baseBearingDeg,
    offsetsDeg: bearingRepairOffsets,
    maxCompileChecks: bearingRepairOffsets.length,
    compileChecks: trials.length,
    elapsedMs: performance.now() - started,
    stopReason: options.length === 3 ? "three_valid_options" : "search_budget",
    trials,
    options,
    instruction: options.length
      ? "These are deterministic search suggestions, not selected agent candidates. A bearing changes viewing-side placement, not orbit direction; a negative bearing can retain a positive camera-right sweep. Check motion.orbit for the actual direction and whether the signed sweep matches the rejected candidate. Compare the viewing-side tradeoff with the brief, including any explicit permission to change it, then choose one by issuing compile_candidate with its recipeId and overrides. Finish only with the ID returned by that requested compile."
      : "No validated suggestion was found within this bounded bearing search. This does not prove that every possible move is infeasible. Do not alter supplied facts or the requested movement silently.",
  };
}

export function validationGuidance(plan: PlanVersion) {
  const codes = new Set(
    plan.validation.violations
      .filter((item) => item.severity === "error")
      .map((item) => item.code),
  );
  const suggestions: string[] = [];
  if ([...codes].some((code) => /_(boundary|obstacle)$/.test(code))) {
    suggestions.push(
      "Try a different bearing or distance with the same recipe and motion direction, then compile again. Bearing changes placement; its sign does not reverse an orbit. A distance change also changes framing; the next validation must pass both checks.",
    );
  }
  if (
    ["framing_band", "framing_clipped", "invalid_projection"].some((code) =>
      codes.has(code),
    )
  ) {
    suggestions.push(
      "Check the distance override against the requested framing. Removing an explicit distance uses the framing solver. Preserve the requested camera height and motion direction.",
    );
  }
  if (codes.has("tripod_translation") || codes.has("slider_arc")) {
    suggestions.push(
      "This movement conflicts with the supplied equipment. Do not change equipment facts or replace the movement silently. Explain the constraint and ask the creator to choose a setup or creative compromise.",
    );
  }
  if (codes.has("camera_speed")) {
    suggestions.push(
      "The move is too fast for the supplied gear. A shorter move changes the visual effect, and a longer duration changes the brief; either requires an explicit creator compromise. Do not silently change the requested duration.",
    );
  }
  if (codes.has("camera_height")) {
    suggestions.push(
      "The camera height is outside the supplied gear range. Check whether a recipe height offset caused this; use the requested height when supported. Do not change the requested height or gear limits silently.",
    );
  }
  return {
    preserve: [
      "scene and gear facts",
      "requested movement family and direction",
      "requested height and duration",
    ],
    suggestions,
    instruction:
      "Change a relevant allowed parameter before another compile, or finish with a qualified explanation of the candidates checked. No alternative is feasible until validation passes.",
  };
}
