import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  attachWitnessEvidence,
  compareCampaigns,
  loadCampaign,
  pairedClusterBootstrap,
  rowsCsv,
  summarizeCampaign,
  type Campaign,
  type Row,
} from "../training/experiments/next/analyze";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const witnessPaths = [
  "training/experiments/next/search.ts",
  "training/experiments/next/grade.ts",
  "src/domain/engine.ts",
  "src/domain/contracts.ts",
  "src/domain/geometry.ts",
  "src/domain/defaults.ts",
];
function row(taskId: string, changes: Partial<Row> = {}): Row {
  return {
    attemptId: "base",
    arm: "llama-base",
    scope: "development",
    taskId,
    sceneGroup: taskId.split("-")[0],
    attempted: true,
    available: true,
    status: "completed",
    termination: "finished",
    productive: true,
    knownWitness: true,
    witnessSourceAttempts: ["base"],
    creditedPlans: 1,
    invalidAdmissions: 0,
    emptyFinish: false,
    compileChecked: true,
    uncheckedEmpty: false,
    falseAbstention: false,
    unsupportedAbstention: false,
    coordinatorLatencyMs: 100,
    harnessLatencyMs: 150,
    providerCalls: 2,
    callsWithReportedUsage: 2,
    callsWithoutReportedUsage: 0,
    reportedInputTokens: 20,
    reportedOutputTokens: 10,
    estimatedChargeUsd: 0.001,
    outstandingReservationUsd: 0,
    missingBudgetReceipts: 0,
    ...changes,
  };
}
function campaign(rows: Row[], trained = false): Campaign {
  return {
    directory: "/fixture",
    scope: "development",
    receipts: {},
    recordedSummary: {},
    taskGroups: Object.fromEntries(
      [...new Set(rows.map((row) => row.sceneGroup))].map((group) => [
        group,
        rows.filter((row) => row.sceneGroup === group).map((row) => row.taskId),
      ]),
    ),
    manifest: {
      attemptId: trained ? "trained" : "base",
      arm: trained ? "llama-sft" : "llama-base",
      model: trained ? "checkpoint" : "base-model",
      split: "development",
      taskIds: rows.map((row) => row.taskId),
      taskFile: "tasks.json",
      tasksSha256: "tasks-hash",
      protocol: { path: "protocol.json", sha256: "protocol-hash" },
      checkerVersion: "checker-v4",
      runtimeVersion: "research-v2",
      promptSha256: "prompt-hash",
      inferenceBaseUrl: "https://forge.coreweave.com/api/training/v1",
      sourceHashes: Object.fromEntries(
        witnessPaths.map((path) => [path, "same-hash"]),
      ),
      settings: { concurrency: 1 },
      files: [],
    },
    rows: rows.map((row) => ({
      ...row,
      attemptId: trained ? "trained" : "base",
      arm: trained ? "llama-sft" : "llama-base",
    })),
  };
}

describe("scene-group uncertainty", () => {
  it("resamples dependent tasks together and reproduces intervals from a fixed seed", () => {
    const clusters = [
      {
        sceneGroup: "a",
        pairs: Array.from({ length: 6 }, () => ({ base: 0, trained: 1 })),
      },
      {
        sceneGroup: "b",
        pairs: Array.from({ length: 6 }, () => ({ base: 1, trained: 0 })),
      },
    ];
    const result = pairedClusterBootstrap(clusters, 27, 1000);
    expect(result).toEqual(pairedClusterBootstrap(clusters, 27, 1000));
    expect(result.difference).toBe(0);
    expect(result.interval95).toEqual([-1, 1]);
    expect(result.base.denominator).toBe(12);
    expect(result.sceneGroups).toBe(2);
  });
  it("excludes missing quality pairs and reports empty bootstrap replicates", () => {
    const result = pairedClusterBootstrap(
      [
        { sceneGroup: "a", pairs: [{ base: 0, trained: 1 }] },
        { sceneGroup: "b", pairs: [{ base: null, trained: 1 }] },
        { sceneGroup: "c", pairs: [{ base: 0, trained: 1 }] },
      ],
      7,
      1000,
    );
    expect(result.base.denominator).toBe(2);
    expect(result.difference).toBe(1);
    expect(result.emptyReplicates).toBeGreaterThan(0);
    expect(result.validReplicates + result.emptyReplicates).toBe(1000);
  });
  it("does not invent uncertainty for one scene or an empty eligible sample", () => {
    expect(
      pairedClusterBootstrap(
        [{ sceneGroup: "one", pairs: [{ base: 0, trained: 1 }] }],
        7,
        100,
      ).interval95,
    ).toBeNull();
    expect(pairedClusterBootstrap([], 7, 100).difference).toBeNull();
  });
});

describe("availability-aware comparisons", () => {
  it("separates scheduled operational outcomes from paired available quality", () => {
    const base = campaign([
      row("a-0"),
      row("b-0", {
        available: false,
        productive: null,
        status: "service-unavailable",
        creditedPlans: null,
        invalidAdmissions: null,
      }),
    ]);
    const trained = campaign([row("a-0"), row("b-0")], true);
    const result = compareCampaigns(base, trained, 7, 1000);
    expect(result.compatible).toBe(true);
    if (!result.compatible) throw new Error("Unexpected mismatch");
    expect(result.operationalSuccessAmongPairedScheduled.difference).toBe(0.5);
    expect(result.qualitySuccessAmongPairedAvailable.difference).toBe(0);
    expect(result.missingness).toMatchObject({
      pairedScheduled: 2,
      pairedAvailable: 1,
      trainedOnlyAvailable: 1,
    });
    const summary = summarizeCampaign(base);
    expect(summary.qualitySuccessAmongAvailable).toEqual({
      numerator: 1,
      denominator: 1,
      rate: 1,
    });
    expect(summary.operationalSuccessAmongScheduled.rate).toBe(0.5);
    expect(summary.latencyMs.coordinatorAttempted.median).toBe(100);
    expect(summary.latencyMs.harnessAttempted.median).toBe(150);
  });
  it("excludes partially scheduled scene groups and refuses incompatible runtimes", () => {
    const base = campaign([row("a-0"), row("a-1")]);
    const trained = campaign([row("a-0")], true);
    const comparison = compareCampaigns(base, trained, 7, 100);
    expect(comparison.compatible).toBe(true);
    if (!comparison.compatible) throw new Error("Unexpected mismatch");
    expect(comparison.completeSceneGroups).toBe(0);
    expect(comparison.excludedIncompleteSceneGroups).toEqual(["a"]);
    trained.manifest.settings.concurrency = 2;
    expect(compareCampaigns(base, trained).compatible).toBe(false);
  });
  it("keeps pilot results separate from development and confirmation", () => {
    const base = campaign([row("a-0")]);
    const trained = campaign([row("a-0")], true);
    base.scope = "initial-network-pilot";
    expect(compareCampaigns(base, trained).compatible).toBe(false);
  });
  it("borrows only compatible recorded witness evidence without altering quality availability", () => {
    const base = campaign([
      row("a-0", {
        available: false,
        productive: null,
        knownWitness: null,
        witnessSourceAttempts: [],
      }),
    ]);
    const trained = campaign([row("a-0")], true);
    const attached = attachWitnessEvidence([base, trained]);
    expect(attached[0].rows[0]).toMatchObject({
      knownWitness: true,
      productive: null,
      available: false,
      witnessSourceAttempts: ["trained"],
    });
    expect(summarizeCampaign(attached[0]).knownWitness).toMatchObject({
      scheduled: 1,
      available: 0,
      unknown: 0,
      qualitySuccessAmongAvailable: { denominator: 0, rate: null },
    });
    trained.manifest.checkerVersion = "other";
    expect(
      attachWitnessEvidence([base, trained])[0].rows[0].knownWitness,
    ).toBeNull();
  });
  it("rejects contradictory witness evidence and leaves missing CSV values blank", () => {
    expect(() =>
      attachWitnessEvidence([
        campaign([row("a-0")]),
        campaign([row("a-0", { knownWitness: false })], true),
      ]),
    ).toThrow("Conflicting");
    const csv = rowsCsv([
      row("a-0", { available: false, productive: null, knownWitness: null }),
    ]);
    expect(csv.split("\n")[1]).toContain("true,false,completed,finished,,,");
  });
});

describe("receipt integrity", () => {
  it("requires complete result receipts and detects a changed source task", async () => {
    const dir = await mkdtemp(resolve(tmpdir(), "flowblock-analysis-"));
    directories.push(dir);
    const tasks = [{ id: "a-0", sceneGroup: "a", split: "development" }];
    const taskBytes = JSON.stringify(tasks);
    const hash = createHash("sha256").update(taskBytes).digest("hex");
    const manifest = {
      ...campaign([row("a-0")]).manifest,
      tasksSha256: hash,
      files: [{ path: "tasks.json", sha256: hash }],
    };
    const entry = {
      taskId: "a-0",
      sceneGroup: "a",
      arm: "llama-base",
      attempted: false,
      available: false,
      status: "unattempted",
      termination: "transport-warmup-failure",
      grade: null,
      latencyMs: null,
      usage: null,
      usageComplete: false,
    };
    await Promise.all([
      writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest)),
      writeFile(resolve(dir, "tasks.json"), taskBytes),
      writeFile(resolve(dir, "results.jsonl"), JSON.stringify(entry) + "\n"),
      writeFile(resolve(dir, "summary.json"), "{}"),
      writeFile(
        resolve(dir, "a-0.json"),
        JSON.stringify({
          taskId: "a-0",
          task: tasks[0],
          calls: [],
          result: null,
          entry,
        }),
      ),
    ]);
    const loaded = await loadCampaign(dir);
    expect(loaded.rows[0]).toMatchObject({
      attempted: false,
      available: false,
      productive: null,
      providerCalls: 0,
    });
    const paidEntry = {
      ...entry,
      attempted: true,
      status: "service-unavailable",
      termination: "provider-error",
    };
    await writeFile(
      resolve(dir, "results.jsonl"),
      JSON.stringify(paidEntry) + "\n",
    );
    await writeFile(
      resolve(dir, "a-0.json"),
      JSON.stringify({
        taskId: "a-0",
        task: tasks[0],
        result: null,
        entry: paidEntry,
        calls: [
          {
            reservationId: "current1",
            status: "completed",
            response: { usage: { inputTokens: 10, outputTokens: 2 } },
          },
          { reservationId: "current2", status: "failed" },
        ],
      }),
    );
    await writeFile(
      resolve(dir, "budget-readback.json"),
      JSON.stringify({
        calls: [
          {
            id: "prior",
            arm: "llama-base",
            taskId: "old-task",
            reservedNanodollars: 10000000000,
            chargedNanodollars: 10000000000,
          },
          {
            id: "current1",
            arm: "llama-base",
            taskId: "a-0",
            reservedNanodollars: 3000000,
            chargedNanodollars: 1000000,
          },
          {
            id: "current2",
            arm: "llama-base",
            taskId: "a-0",
            reservedNanodollars: 2000000,
          },
        ],
      }),
    );
    const withBudget = await loadCampaign(dir);
    expect(withBudget.rows[0]).toMatchObject({
      productive: null,
      providerCalls: 2,
      callsWithReportedUsage: 1,
      callsWithoutReportedUsage: 1,
      reportedInputTokens: 10,
      reportedOutputTokens: 2,
      estimatedChargeUsd: 0.001,
      outstandingReservationUsd: 0.002,
    });
    await writeFile(resolve(dir, "results.jsonl"), "");
    await expect(loadCampaign(dir)).rejects.toThrow("incomplete");
    await writeFile(
      resolve(dir, "results.jsonl"),
      JSON.stringify(paidEntry) + "\n",
    );
    const original = await readFile(resolve(dir, "a-0.json"), "utf8");
    await writeFile(
      resolve(dir, "a-0.json"),
      original.replace('"sceneGroup":"a"', '"sceneGroup":"changed"'),
    );
    await expect(loadCampaign(dir)).rejects.toThrow("receipt mismatch");
  });
});

describe("provider endpoint matching", () => {
  it("does not pool results obtained through different inference endpoints", () => {
    const base = campaign([row("a-0")]),
      trained = campaign([row("a-0")], true);
    trained.manifest.inferenceBaseUrl = "https://api.training.wandb.ai/v1";
    const comparison = compareCampaigns(base, trained);
    expect(comparison).toMatchObject({
      compatible: false,
      mismatches: ["inferenceBaseUrl"],
    });
  });
});
