import { z } from "zod";
import { AgentActionSchema, OverridesSchema } from "@/domain";

const [
  listRecipes,
  compileCandidate,
  validateCandidate,
  readFindings,
  proposeRevision,
  finish,
] = AgentActionSchema.options;

// The public action vocabulary spans both workflows. A request receives only
// the actions supported by its current stage.
export const PlanningActionSchema = z.discriminatedUnion("action", [
  listRecipes,
  compileCandidate,
  validateCandidate,
  finish,
]);

export const ReviewReadActionSchema = readFindings;

const singleRevisionParameter = z.union([
  z.object({ distance: OverridesSchema.shape.distance.unwrap() }).strict(),
  z.object({ travel: OverridesSchema.shape.travel.unwrap() }).strict(),
  z.object({ bearingDeg: OverridesSchema.shape.bearingDeg.unwrap() }).strict(),
  z
    .object({ orbitDegrees: OverridesSchema.shape.orbitDegrees.unwrap() })
    .strict(),
  z.object({ height: OverridesSchema.shape.height.unwrap() }).strict(),
  z
    .object({ durationSeconds: OverridesSchema.shape.durationSeconds.unwrap() })
    .strict(),
]);

export const RevisionActionSchema = z.discriminatedUnion("action", [
  readFindings,
  proposeRevision.extend({
    overrides: singleRevisionParameter,
    findingIds: z.array(z.string().min(1)).length(1),
  }),
  z
    .object({
      action: z.literal("abstain_revision"),
      findingIds: z.array(z.string().min(1)).min(1).max(2),
      reason: z.string().min(1).max(1000),
    })
    .strict(),
]);
