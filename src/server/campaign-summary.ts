import { z } from "zod";
import snapshot from "../../training/experiments/next/results/campaign-summary.json";

const count = z.number().int().nonnegative();
const source = z.strictObject({
  path: z.string().regex(/^training\/[a-zA-Z0-9_./:+-]+\.json$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const timestamp = z.iso.datetime({ offset: true });
const evidenceUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.origin === "https://forge.coreweave.com" &&
    url.pathname.startsWith("/wandb/wandb/flowblock/") &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
}, "Expected a clean link to the recorded private FlowBlock project");

export const CampaignSummarySchema = z.strictObject({
  schemaVersion: z.literal(1),
  experimentId: z.literal("flowblock-planner-v2"),
  recordedAt: timestamp,
  project: z.literal("wandb/flowblock"),
  access: z.literal("private"),
  analysis: source,
  results: z.array(
    z
      .strictObject({
        attemptId: z.string().min(1),
        label: z.string().min(1),
        cohort: z.enum(["development", "confirmation"]),
        scheduled: count,
        attempted: count,
        available: count,
        productive: count,
        sceneGroups: count,
        invalidAdmissions: count,
      })
      .refine(
        (row) =>
          row.productive <= row.available &&
          row.available <= row.attempted &&
          row.attempted <= row.scheduled,
      ),
  ),
  omittedAttempts: z.strictObject({
    initialPilot: count,
    zeroCallTransport: count,
  }),
  matchedComparisons: z.array(
    z.strictObject({
      cohort: z.enum(["development", "confirmation"]),
      baseAttemptId: z.string(),
      trainedAttemptId: z.string(),
      pairedAvailable: count,
      baseProductive: count,
      trainedProductive: count,
      sceneGroups: count,
      difference: z.number().min(-1).max(1).nullable(),
      interval95: z
        .tuple([z.number().min(-1).max(1), z.number().min(-1).max(1)])
        .nullable(),
      iterations: count,
      seed: count,
    }),
  ),
  training: z.strictObject({
    state: z.string().min(1),
    recordedAt: timestamp,
    examples: count,
    plannedSteps: count,
    completedSteps: count.nullable(),
    completionSource: source.nullable(),
    jobId: z.string().nullable(),
    source,
  }),
  confirmation: z.strictObject({
    state: z.enum(["unused", "in-progress", "completed"]),
    tasks: count,
    sceneGroups: count,
    source,
    executionSource: source.nullable(),
  }),
  creatorStudy: z.strictObject({
    state: z.literal("not-started"),
    participants: z.literal(0),
  }),
  objectron: z.strictObject({
    selected: count,
    completed: count,
    nonSeedSamples: count,
    heuristicAcceptedSamples: count,
    meanProjectionDiscrepancy: z.number().nonnegative(),
    modelsPublication: z.enum(["failed", "verified", "unverified"]),
    source,
  }),
  evidence: z.array(
    z.strictObject({
      label: z.string().min(1),
      url: evidenceUrl,
      status: z.literal("verified"),
      receipt: source,
    }),
  ),
});

export type CampaignSummary = z.infer<typeof CampaignSummarySchema>;

export function readCampaignSummary(): CampaignSummary | null {
  const parsed = CampaignSummarySchema.safeParse(snapshot);
  return parsed.success ? parsed.data : null;
}
