import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

export const confirmationGuardVersion = "flowblock-confirmation-guard-v2";
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const arm = z.enum(["library", "gpt-oss", "llama-base", "llama-sft"]);
const taskId = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const endpoint = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  }, "An inference endpoint must be credential-free HTTPS.")
  .nullable();
const settings = z.record(z.string(), z.json());
const armPolicy = z
  .object({
    model: z.string().min(1).nullable(),
    promptSha256: sha.nullable(),
    runtimeVersion: z.string().min(1),
    inferenceBaseUrl: endpoint,
    settings,
  })
  .strict();
export const ConfirmationSelectionSchema = z
  .object({
    schemaVersion: z.literal(2),
    experimentId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    selectedModel: z.string().min(1),
    selectedPromptSha256: sha,
    sourceHashes: z
      .record(z.string().min(1), sha)
      .refine(
        (value) => Object.keys(value).length > 0,
        "Runtime hashes are required.",
      ),
    confirmationTasksSha256: sha,
    taskIds: z
      .array(taskId)
      .min(1)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Task IDs must be unique.",
      ),
    protocolSha256: sha,
    datasetManifestSha256: sha,
    frozenAt: z.iso.datetime({ offset: true }),
    arms: z.record(arm, armPolicy),
    developmentEvidence: z
      .object({
        baseAttemptId: z.string().min(1),
        trainedAttemptId: z.string().min(1),
        analysisSha256: sha,
        trainingReadbackSha256: sha,
      })
      .strict(),
  })
  .strict();
export type ConfirmationSelection = z.infer<typeof ConfirmationSelectionSchema>;
export type ConfirmationActual = z.infer<typeof armPolicy> & {
  arm: z.infer<typeof arm>;
  sourceHashes: Record<string, string>;
  tasksSha256: string;
  taskIds: string[];
  protocolSha256: string;
  datasetManifestSha256: string;
};
const hash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Validates the complete execution contract before claiming a one-shot arm. */
export function validateConfirmationSelection(
  receiptBytes: string,
  expectedReceiptSha256: string,
  actual: ConfirmationActual,
  nowMs = Date.now(),
) {
  if (
    !sha.safeParse(expectedReceiptSha256).success ||
    hash(receiptBytes) !== expectedReceiptSha256
  )
    throw new Error("Confirmation selection receipt hash changed.");
  const receipt = ConfirmationSelectionSchema.parse(JSON.parse(receiptBytes));
  if (!Number.isFinite(nowMs) || Date.parse(receipt.frozenAt) > nowMs)
    throw new Error(
      "Confirmation selection must have been frozen before execution.",
    );
  if (
    receipt.arms["llama-sft"].model !== receipt.selectedModel ||
    receipt.arms["llama-sft"].promptSha256 !== receipt.selectedPromptSha256
  )
    throw new Error(
      "Selected checkpoint or prompt differs from the frozen SFT arm.",
    );
  const expected = receipt.arms[actual.arm];
  const comparisons = {
    sourceHashes: [receipt.sourceHashes, actual.sourceHashes],
    tasksSha256: [receipt.confirmationTasksSha256, actual.tasksSha256],
    taskIds: [receipt.taskIds, actual.taskIds],
    protocolSha256: [receipt.protocolSha256, actual.protocolSha256],
    datasetManifestSha256: [
      receipt.datasetManifestSha256,
      actual.datasetManifestSha256,
    ],
    model: [expected.model, actual.model],
    promptSha256: [expected.promptSha256, actual.promptSha256],
    runtimeVersion: [expected.runtimeVersion, actual.runtimeVersion],
    inferenceBaseUrl: [expected.inferenceBaseUrl, actual.inferenceBaseUrl],
    settings: [expected.settings, actual.settings],
  };
  for (const [field, [wanted, observed]] of Object.entries(comparisons))
    if (!isDeepStrictEqual(wanted, observed))
      throw new Error(`Frozen confirmation ${field} changed.`);
  return { sha256: expectedReceiptSha256, receipt };
}

/** An exclusive durable claim is never removed, including after a timeout or warmup failure. */
export async function claimConfirmationAttempt(input: {
  ledgerDirectory: string;
  selectionSha256: string;
  arm: z.infer<typeof arm>;
  attemptId: string;
  outputDirectory: string;
  taskIds: string[];
  protocolSha256: string;
}) {
  sha.parse(input.selectionSha256);
  sha.parse(input.protocolSha256);
  arm.parse(input.arm);
  if (!input.attemptId || !input.outputDirectory || !input.taskIds.length)
    throw new Error(
      "A confirmation claim requires an attempt, output and tasks.",
    );
  const directory = resolve(input.ledgerDirectory);
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `${input.selectionSha256}-${input.arm}.json`);
  let file;
  try {
    file = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        "This selection and arm already has a confirmation claim. Do not rerun or delete the claim; inspect its preserved attempt.",
      );
    throw error;
  }
  const receipt = {
    schemaVersion: 1,
    guardVersion: confirmationGuardVersion,
    selectionSha256: input.selectionSha256,
    arm: input.arm,
    attemptId: input.attemptId,
    outputDirectory: resolve(input.outputDirectory),
    taskIdsSha256: hash(JSON.stringify(input.taskIds)),
    protocolSha256: input.protocolSha256,
    claimedAt: new Date().toISOString(),
  };
  try {
    await file.writeFile(JSON.stringify(receipt, null, 2) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  const parent = await open(directory, "r");
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return { path, receipt };
}
