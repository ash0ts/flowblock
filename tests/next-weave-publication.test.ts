import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPublication,
  importRecordedPredictions,
  recoverEmptyImport,
  summarizeScores,
  verifyPredictions,
  type PublicationResult,
} from "../training/experiments/next/publish-weave";

const directories: string[] = [];

describe("recorded prediction import", () => {
  it("bounds concurrent predictions and preserves score order and values", async () => {
    let active = 0;
    let maximum = 0;
    const completed: number[] = [];
    const rows = Array.from({ length: 9 }, (_, id) => ({
      input: { id: String(id) },
      output: { recorded: id },
      scores: { available: true, quality: id / 10 },
    }));
    await importRecordedPredictions(
      rows,
      async (input, output) => {
        active++;
        maximum = Math.max(maximum, active);
        expect(output).toEqual({ recorded: Number(input.id) });
        const scores: [string, boolean | number][] = [];
        await new Promise((resolve) => setTimeout(resolve, 1));
        return {
          async logScore(name, value) {
            scores.push([name, value]);
          },
          async finish() {
            expect(scores).toEqual([
              ["available", true],
              ["quality", Number(input.id) / 10],
            ]);
            completed.push(Number(input.id));
            active--;
          },
        };
      },
      3,
    );
    expect(maximum).toBe(3);
    expect(active).toBe(0);
    expect(completed.sort((a, b) => a - b)).toEqual(
      rows.map((row) => Number(row.input.id)),
    );
  });

  it("waits for active writers and stops scheduling after an error", async () => {
    const started: number[] = [];
    let otherFinished = false;
    const rows = Array.from({ length: 8 }, (_, id) => ({
      input: { id: String(id) },
      output: {},
      scores: { available: true },
    }));
    await expect(
      importRecordedPredictions(
        rows,
        async (input) => {
          started.push(Number(input.id));
          if (input.id === "0") throw new Error("Interrupted import");
          await new Promise((resolve) => setTimeout(resolve, 5));
          return {
            async logScore() {},
            async finish() {
              otherFinished = true;
            },
          };
        },
        2,
      ),
    ).rejects.toThrow("Interrupted import");
    expect(started).toEqual([0, 1]);
    expect(otherFinished).toBe(true);
  });
});
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), "flowblock-weave-next-"));
  directories.push(directory);
  const tasks = [
    { id: "sequence-a", source: "public-sequence" },
    { id: "sequence-b", source: "excluded-sequence" },
  ];
  const tasksPath = resolve(directory, "tasks.json");
  await writeFile(tasksPath, JSON.stringify(tasks));
  const manifestPath = resolve(directory, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      schemaVersion: 1,
      datasetId: "test-dataset",
      files: [
        {
          path: "tasks.json",
          sha256: hash(await readFile(tasksPath)),
          license: {
            id: "MIT",
            url: "https://opensource.org/license/mit",
            redistributionAllowed: true,
          },
        },
      ],
    }),
  );
  const result: PublicationResult = {
    schemaVersion: 1,
    experimentId: "diagnostic-v2",
    attemptId: "local-measurement-v2",
    datasetManifestSha256: hash(await readFile(manifestPath)),
    tasksSha256: hash(await readFile(tasksPath)),
    model: {
      name: "SAM2 diagnostic",
      provider: "local",
      modelId: "sam2.1-small",
      promptSha256: null,
      runtimeVersion: "runtime-v1",
      checkerVersion: "proxy-v1",
      sourceHashes: { "measure.py": "a".repeat(64) },
      settings: { device: "MPS" },
    },
    rows: [
      {
        taskId: "sequence-a",
        output: {
          status: "completed",
          note: "Projection discrepancy is not tracking accuracy.",
        },
        scores: {
          available: true,
          attempted: true,
          maskCentroidToProjected3dCenterFrameDiagonalDiscrepancy: 0.08,
        },
      },
      {
        taskId: "sequence-b",
        output: { status: "excluded", reason: "Unsupported clip" },
        scores: { available: false, attempted: false },
      },
    ],
    summary: { requested: 2, completed: 1 },
    metadata: {
      scope: "measurement-benchmark",
      recordedAt: "2026-10-29T00:00:00Z",
      limitations: ["One sequence is excluded."],
    },
  };
  const resultsPath = resolve(directory, "results.json");
  const save = () => writeFile(resultsPath, JSON.stringify(result));
  await save();
  return {
    tasks,
    tasksPath,
    manifestPath,
    resultsPath,
    result,
    save,
    load: () => loadPublication(manifestPath, tasksPath, resultsPath),
  };
}

describe("new native Weave evidence publication", () => {
  it("supports generic measurement tasks and preserves exact proxy names and requested denominator", async () => {
    const f = await fixture();
    const plan = await f.load();
    expect(plan.predictions).toHaveLength(2);
    expect(plan.summary.task_counts).toEqual({ requested: 2, published: 2 });
    expect(plan.summary.available).toMatchObject({
      count: 2,
      true_count: 1,
      true_fraction: 0.5,
    });
    expect(
      plan.summary.maskCentroidToProjected3dCenterFrameDiagonalDiscrepancy,
    ).toEqual({ count: 1, mean: 0.08, sum: 0.08 });
    expect(plan.result.model.provider).toBe("local");
  });
  it("gives changed measured evidence a new publication identity but unchanged tasks the same dataset identity", async () => {
    const f = await fixture();
    const before = await f.load();
    f.result.rows[0].scores.maskCentroidToProjected3dCenterFrameDiagonalDiscrepancy = 0.09;
    await f.save();
    const after = await f.load();
    expect(after.publicationId).not.toBe(before.publicationId);
    expect(after.datasetName).toBe(before.datasetName);
    expect(after.modelName).toBe(before.modelName);
  });
  it("rejects stale hashes and undeclared tasks", async () => {
    const f = await fixture();
    f.result.datasetManifestSha256 = "0".repeat(64);
    await f.save();
    await expect(f.load()).rejects.toThrow(/frozen manifest/);
    f.result.datasetManifestSha256 = hash(await readFile(f.manifestPath));
    f.result.rows[0].taskId = "other-sequence";
    await f.save();
    await expect(f.load()).rejects.toThrow(/undeclared task/);
  });
  it("requires exactly one row for every requested task including exclusions", async () => {
    const f = await fixture();
    f.result.rows.pop();
    await f.save();
    await expect(f.load()).rejects.toThrow(/exactly one result/);
  });
  it("does not turn unavailable rows into quality failures", async () => {
    const f = await fixture();
    f.result.rows[1].scores.productive = false;
    await f.save();
    await expect(f.load()).rejects.toThrow(/Unavailable rows/);
  });
  it("rejects reserved scorer names and secret-bearing result material", async () => {
    const f = await fixture();
    f.result.rows[0].scores.task_counts = 1;
    await f.save();
    await expect(f.load()).rejects.toThrow(/summary fields/);
    delete f.result.rows[0].scores.task_counts;
    f.result.rows[0].output.url =
      "https://example.com/?X-Amz-Signature=private";
    await f.save();
    await expect(f.load()).rejects.toThrow(/signed-URL/);
  });
  it("separates model versions by full recorded configuration", async () => {
    const f = await fixture();
    const original = await f.load();
    f.result.model.settings.device = "CUDA";
    await f.save();
    expect((await f.load()).modelName).not.toBe(original.modelName);
  });
  it("verifies complete exact remote rows regardless of ordering", async () => {
    const f = await fixture();
    const { predictions } = await f.load();
    const calls = predictions.map((p) => ({
      inputs: { example: p.input },
      output: { output: p.output, scores: p.scores },
      ended_at: "2026-10-29T00:00:00Z",
    }));
    expect(verifyPredictions(predictions, calls.toReversed())).toBe(true);
    expect(verifyPredictions(predictions, [calls[0], calls[0]])).toBe(false);
    calls[0] = { ...calls[0], ended_at: "" };
    expect(verifyPredictions(predictions, calls)).toBe(false);
  });
  it("keeps recorded totals separate from per-score observed denominators", () => {
    const result = summarizeScores(
      [{ taskId: "a", output: {}, scores: { available: false } }],
      { usableClips: 0 },
    );
    expect(result.recorded_summary).toEqual({ usableClips: 0 });
    expect(result.available).toMatchObject({ mean: 0 });
    expect(result).not.toHaveProperty("productive");
  });
  it("makes a linked import recovery without changing experimental results or original identity", async () => {
    const f = await fixture();
    const original = await f.load();
    const path = resolve(f.manifestPath, "../failed-import.json");
    const receipt = {
      status: "needs-review",
      publicationId: original.publicationId,
      observedRows: 0,
      datasetMatches: true,
      configurationMatches: true,
      evaluationCallId: "interrupted-call-id",
    };
    await writeFile(path, JSON.stringify(receipt));
    const recovery = await recoverEmptyImport(original, path);
    expect(recovery.publicationId).not.toBe(original.publicationId);
    expect(recovery.result).toEqual(original.result);
    expect(recovery.recovery?.publicationId).toBe(original.publicationId);
    expect((await recoverEmptyImport(original, path)).publicationId).toBe(
      recovery.publicationId,
    );
    receipt.observedRows = 1;
    await writeFile(path, JSON.stringify(receipt));
    await expect(recoverEmptyImport(original, path)).rejects.toThrow(
      /zero completed rows/,
    );
  });
});
