import { z } from "zod";
import {
  OverridesSchema,
  recipes,
  type Overrides,
  type PlanVersion,
  type TakeAnalysis,
} from "@/domain";
import { allowedOverrides } from "./planner-feedback";
import { RevisionActionSchema } from "./planner-actions";

type Finding = TakeAnalysis["findings"][number];
type Parameter = Exclude<keyof Overrides, "reverse">;
export type RevisionAction = z.infer<typeof RevisionActionSchema>;
export const revisionFindingId = (finding: Finding, index: number) =>
  `${finding.kind}:${finding.phase}:${index}`;

export function evidenceParameters(
  plan: PlanVersion,
  finding: Finding,
): Parameter[] {
  if (finding.kind === "duration") return ["durationSeconds"];
  if (finding.kind === "size")
    return finding.measurement?.metric === "size-ratio" &&
      finding.measurement.observed !== finding.measurement.target
      ? ["distance"]
      : [];
  if (finding.kind === "clipping") return ["distance"];
  const applicable = allowedOverrides(
    recipes.find((recipe) => recipe.id === plan.recipeId)!,
  );
  return applicable.filter(
    (key): key is Parameter => key !== "reverse" && key !== "durationSeconds",
  );
}

function distanceDirection(
  finding: Finding,
): "increase" | "decrease" | undefined {
  if (finding.kind === "clipping") return "increase";
  if (finding.kind === "size" && finding.measurement?.metric === "size-ratio") {
    const { observed, target } = finding.measurement;
    return observed > target
      ? "increase"
      : observed < target
        ? "decrease"
        : undefined;
  }
}

export function validateRevisionEvidence(
  plan: PlanVersion,
  finding: Finding,
  overrides: Overrides,
) {
  const parameter = Object.keys(overrides)[0] as Parameter;
  if (finding.kind === "duration" && parameter !== "durationSeconds")
    throw new Error(
      "A duration finding can justify only a duration experiment.",
    );
  if (finding.kind !== "duration" && parameter === "durationSeconds")
    throw new Error("A spatial finding cannot justify a duration experiment.");
  if (!evidenceParameters(plan, finding).includes(parameter))
    throw new Error(
      `This ${finding.kind} finding does not support ${parameter}. Use a listed evidence-specific parameter or abstain.`,
    );
  const direction = distanceDirection(finding);
  if (
    parameter === "distance" &&
    direction &&
    (direction === "increase"
      ? overrides.distance! <= plan.path.radius
      : overrides.distance! >= plan.path.radius)
  )
    throw new Error(
      `The measured ${finding.kind} finding supports an ${direction} in planned distance as an experiment. It does not establish the actual camera distance.`,
    );
}

export function revisionEvidenceChoices(
  plan: PlanVersion,
  analysis: TakeAnalysis,
) {
  return analysis.findings.map((finding, index) => {
    const direction = distanceDirection(finding);
    return {
      findingId: revisionFindingId(finding, index),
      kind: finding.kind,
      parameters: evidenceParameters(plan, finding),
      measurement: finding.measurement,
      ...(direction
        ? { distanceExperiment: { direction, currentMeters: plan.path.radius } }
        : {}),
      guidance:
        finding.kind === "size"
          ? direction
            ? `The tracked product is ${direction === "increase" ? "larger" : "smaller"} than the phase target. A modest ${direction} in planned distance is a testable framing experiment, not an estimate of physical distance. Preserve the brief and compile the change; no size ratio is a calibrated distance multiplier.`
            : "This finding lacks a measured size direction. Review the evidence or abstain; do not guess a distance change."
          : finding.kind === "clipping"
            ? "Border contact suggests possible clipping. A larger planned distance is an experiment that leaves more image space, not proof of a physical cause."
            : finding.kind === "duration"
              ? "The clip and plan differ in duration. A timing revision changes pacing; it cannot correct spatial framing."
              : "Center-distance is an unsigned image-space error. It does not establish left/right correction or a physical cause. Propose a modest applicable experiment that preserves the brief, or abstain.",
    };
  });
}

/** The advertised schema and the parser admit the same finding/parameter pairs. */
export function revisionEvidenceActionSchema(
  plan: PlanVersion,
  analysis: TakeAnalysis,
): z.ZodType<RevisionAction> {
  const branches: z.ZodType[] = [];
  for (const [index, finding] of analysis.findings.entries()) {
    for (const parameter of evidenceParameters(plan, finding)) {
      let value = OverridesSchema.shape[parameter].unwrap();
      if (parameter === "distance") {
        const direction = distanceDirection(finding);
        if (direction === "increase") value = value.gt(plan.path.radius);
        if (direction === "decrease") value = value.lt(plan.path.radius);
      }
      branches.push(
        z
          .object({
            action: z.literal("propose_revision"),
            overrides: z.object({ [parameter]: value }).strict(),
            findingIds: z.tuple([z.literal(revisionFindingId(finding, index))]),
            reason: z.string().min(1).max(1000),
          })
          .strict(),
      );
    }
  }
  const ids = analysis.findings.map(revisionFindingId) as [string, ...string[]];
  branches.push(
    z
      .object({
        action: z.literal("abstain_revision"),
        findingIds: z.array(z.enum(ids)).min(1).max(ids.length),
        reason: z.string().min(1).max(1000),
      })
      .strict(),
  );
  return (
    branches.length === 1
      ? branches[0]
      : z.union(branches as [z.ZodType, z.ZodType, ...z.ZodType[]])
  ) as z.ZodType<RevisionAction>;
}
