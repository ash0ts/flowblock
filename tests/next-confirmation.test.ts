import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  claimConfirmationAttempt,
  ConfirmationSelectionSchema,
  validateConfirmationSelection,
  type ConfirmationActual,
  type ConfirmationSelection,
} from "../training/experiments/next/confirmation";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function fixture() {
  const policy = {
    model: "base",
    promptSha256: digest("prompt"),
    runtimeVersion: "research-v2",
    inferenceBaseUrl: "https://forge.coreweave.com/api/training/v1",
    settings: {
      concurrency: 1,
      transport: { enabled: true, version: "v2", connections: 1 },
    },
  };
  const receipt: ConfirmationSelection = {
    schemaVersion: 2,
    experimentId: "flowblock-v2",
    selectedModel: "checkpoint",
    selectedPromptSha256: digest("prompt"),
    sourceHashes: { "run.ts": digest("run") },
    confirmationTasksSha256: digest("tasks"),
    taskIds: ["a-0", "a-1"],
    protocolSha256: digest("protocol"),
    datasetManifestSha256: digest("dataset"),
    frozenAt: "2026-10-29T00:00:00Z",
    arms: {
      library: {
        ...policy,
        model: null,
        promptSha256: null,
        inferenceBaseUrl: null,
      },
      "gpt-oss": { ...policy, model: "gpt" },
      "llama-base": policy,
      "llama-sft": { ...policy, model: "checkpoint" },
    },
    developmentEvidence: {
      baseAttemptId: "base-development",
      trainedAttemptId: "trained-development",
      analysisSha256: digest("analysis"),
      trainingReadbackSha256: digest("training"),
    },
  };
  const actual: ConfirmationActual = {
    ...policy,
    arm: "llama-base",
    sourceHashes: receipt.sourceHashes,
    tasksSha256: receipt.confirmationTasksSha256,
    taskIds: receipt.taskIds,
    protocolSha256: receipt.protocolSha256,
    datasetManifestSha256: receipt.datasetManifestSha256,
  };
  const bytes = JSON.stringify(receipt);
  return {
    receipt,
    bytes,
    hash: digest(bytes),
    actual,
    now: Date.parse("2026-10-30T00:00:00Z"),
  };
}

describe("confirmation protocol binding", () => {
  it("accepts the complete frozen base protocol and retains the selected SFT checkpoint", () => {
    const f = fixture();
    expect(
      validateConfirmationSelection(f.bytes, f.hash, f.actual, f.now),
    ).toEqual({ sha256: f.hash, receipt: f.receipt });
    expect(
      validateConfirmationSelection(
        f.bytes,
        f.hash,
        { ...f.actual, arm: "llama-sft", model: "checkpoint" },
        f.now,
      ).receipt.selectedModel,
    ).toBe("checkpoint");
  });
  it("rejects endpoint, transport, protocol, task subset/order, and dataset changes", () => {
    const f = fixture();
    const changes: Partial<ConfirmationActual>[] = [
      { inferenceBaseUrl: "https://api.training.wandb.ai/v1" },
      { settings: { ...f.actual.settings, transport: { enabled: false } } },
      { protocolSha256: digest("changed") },
      { datasetManifestSha256: digest("changed") },
      { taskIds: ["a-0"] },
      { taskIds: ["a-1", "a-0"] },
      { sourceHashes: { "run.ts": digest("changed") } },
      { promptSha256: digest("changed") },
    ];
    for (const change of changes)
      expect(() =>
        validateConfirmationSelection(
          f.bytes,
          f.hash,
          { ...f.actual, ...change },
          f.now,
        ),
      ).toThrow("Frozen confirmation");
  });
  it("rejects stale checkpoint identity, altered receipt bytes, and future selections", () => {
    const f = fixture();
    expect(() =>
      validateConfirmationSelection(
        f.bytes,
        f.hash,
        { ...f.actual, arm: "llama-sft", model: "other-checkpoint" },
        f.now,
      ),
    ).toThrow("model changed");
    expect(() =>
      validateConfirmationSelection(f.bytes + " ", f.hash, f.actual, f.now),
    ).toThrow("receipt hash changed");
    expect(() =>
      validateConfirmationSelection(
        f.bytes,
        f.hash,
        f.actual,
        Date.parse("2026-10-28T00:00:00Z"),
      ),
    ).toThrow("frozen before");
  });
  it("rejects incomplete arm policies and credential-bearing endpoints", () => {
    const f = fixture();
    const invalid = structuredClone(f.receipt);
    invalid.arms["llama-base"].inferenceBaseUrl =
      "https://user:secret@example.com/v1";
    expect(ConfirmationSelectionSchema.safeParse(invalid).success).toBe(false);
    expect(
      ConfirmationSelectionSchema.safeParse({
        ...f.receipt,
        arms: { "llama-base": f.receipt.arms["llama-base"] },
      }).success,
    ).toBe(false);
  });
});

describe("one-shot confirmation claim", () => {
  it("allows exactly one concurrent claim and never releases it for a new output directory", async () => {
    const directory = await mkdtemp(
      resolve(tmpdir(), "flowblock-confirmation-"),
    );
    directories.push(directory);
    const f = fixture();
    const input = {
      ledgerDirectory: directory,
      selectionSha256: f.hash,
      arm: "llama-base" as const,
      attemptId: "attempt-a",
      outputDirectory: resolve(directory, "output-a"),
      taskIds: f.actual.taskIds,
      protocolSha256: f.actual.protocolSha256,
    };
    const results = await Promise.allSettled([
      claimConfirmationAttempt(input),
      claimConfirmationAttempt({
        ...input,
        attemptId: "attempt-b",
        outputDirectory: resolve(directory, "output-b"),
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const winner = results.find((result) => result.status === "fulfilled");
    if (winner?.status !== "fulfilled") throw new Error("No claim won");
    const before = await readFile(winner.value.path, "utf8");
    await expect(
      claimConfirmationAttempt({ ...input, attemptId: "third" }),
    ).rejects.toThrow("already has a confirmation claim");
    expect(await readFile(winner.value.path, "utf8")).toBe(before);
    await expect(
      claimConfirmationAttempt({ ...input, arm: "llama-sft" }),
    ).resolves.toMatchObject({ receipt: { arm: "llama-sft" } });
  });
});
