import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { Entry, CallRecord } from "./run";
import type { Task } from "./grade";

export const analysisVersion = "flowblock-campaign-analysis-v1";
export type Scope = "development" | "confirmation" | "initial-network-pilot";
type Manifest = {
  attemptId: string;
  arm: Entry["arm"];
  model: string | null;
  split: "development" | "confirmation";
  taskIds: string[];
  taskFile: string;
  tasksSha256: string;
  datasetManifest?: { path: string; sha256: string };
  protocol: { path: string; sha256: string };
  checkerVersion: string;
  runtimeVersion: string;
  promptSha256: string | null;
  inferenceBaseUrl: string | null;
  sourceHashes: Record<string, string>;
  settings: Record<string, unknown>;
  files: { path: string; sha256: string }[];
};
type LedgerCall = {
  id: string;
  arm: string;
  taskId: string;
  status: string;
  reservedNanodollars: number;
  chargedNanodollars?: number;
};
export type Row = {
  attemptId: string;
  arm: Entry["arm"];
  scope: Scope;
  taskId: string;
  sceneGroup: string;
  attempted: boolean;
  available: boolean;
  status: string;
  termination: string;
  productive: boolean | null;
  knownWitness: boolean | null;
  witnessSourceAttempts: string[];
  creditedPlans: number | null;
  invalidAdmissions: number | null;
  emptyFinish: boolean | null;
  compileChecked: boolean | null;
  uncheckedEmpty: boolean | null;
  falseAbstention: boolean | null;
  unsupportedAbstention: boolean | null;
  coordinatorLatencyMs: number | null;
  harnessLatencyMs: number | null;
  providerCalls: number;
  callsWithReportedUsage: number;
  callsWithoutReportedUsage: number;
  reportedInputTokens: number;
  reportedOutputTokens: number;
  estimatedChargeUsd: number | null;
  outstandingReservationUsd: number | null;
  missingBudgetReceipts: number;
};
export type Campaign = {
  directory: string;
  scope: Scope;
  manifest: Manifest;
  receipts: Record<string, string>;
  taskGroups: Record<string, string[]>;
  rows: Row[];
  recordedSummary: unknown;
};
const sha256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const ratio = (numerator: number, denominator: number) => ({
  numerator,
  denominator,
  rate: denominator ? numerator / denominator : null,
});
const numeric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const boolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;
function childPath(directory: string, path: string) {
  const full = resolve(directory, path);
  if (!full.startsWith(`${resolve(directory)}${sep}`))
    throw new Error(`Receipt path escapes its campaign: ${path}`);
  return full;
}

/** Reads immutable results; it never recompiles plans or substitutes the current checker. */
export async function loadCampaign(
  directory: string,
  pilot = false,
): Promise<Campaign> {
  const receipts: Record<string, string> = {};
  const read = async (path: string) => {
    const bytes = await readFile(childPath(directory, path), "utf8");
    receipts[path] = sha256(bytes);
    return bytes;
  };
  const manifest = JSON.parse(await read("manifest.json")) as Manifest;
  if (
    !manifest.attemptId ||
    !Array.isArray(manifest.taskIds) ||
    new Set(manifest.taskIds).size !== manifest.taskIds.length
  )
    throw new Error("Invalid campaign manifest or duplicate task IDs.");
  if (pilot && manifest.split !== "development")
    throw new Error("A confirmation run cannot be relabeled a network pilot.");
  const scope: Scope = pilot ? "initial-network-pilot" : manifest.split;
  const tasks = JSON.parse(await read(manifest.taskFile)) as Task[];
  if (receipts[manifest.taskFile] !== manifest.tasksSha256)
    throw new Error("Task source hash mismatch.");
  for (const file of manifest.files) {
    await read(file.path);
    if (receipts[file.path] !== file.sha256)
      throw new Error(`Manifest file hash mismatch: ${file.path}`);
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length)
    throw new Error("Duplicate IDs in the source task file.");
  const entries = (await read("results.jsonl"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Entry);
  if (
    entries.length !== manifest.taskIds.length ||
    new Set(entries.map((entry) => entry.taskId)).size !== entries.length ||
    entries.some((entry) => !manifest.taskIds.includes(entry.taskId))
  )
    throw new Error(
      "The campaign is incomplete or has duplicate/unexpected results.",
    );
  const recordedSummary = JSON.parse(await read("summary.json"));
  let ledger: Map<string, LedgerCall> | null = null;
  try {
    const value = JSON.parse(await read("budget-readback.json")) as {
      calls: LedgerCall[];
    };
    ledger = new Map(value.calls.map((call) => [call.id, call]));
    if (ledger.size !== value.calls.length)
      throw new Error("Duplicate budget reservation IDs.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const rows: Row[] = [];
  for (const id of manifest.taskIds) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Unsafe task filename.");
    const entry = entries.find((entry) => entry.taskId === id)!;
    const task = byId.get(id);
    const raw = JSON.parse(await read(`${id}.json`)) as {
      taskId: string;
      task: Task;
      entry: Entry;
      calls: CallRecord[];
      result: { latencyMs?: number } | null;
    };
    if (
      !task ||
      raw.taskId !== id ||
      !isDeepStrictEqual(raw.entry, entry) ||
      !isDeepStrictEqual(raw.task, task) ||
      entry.sceneGroup !== task.sceneGroup ||
      entry.arm !== manifest.arm ||
      task.split !== manifest.split
    )
      throw new Error(`Task receipt mismatch: ${id}`);
    if (entry.available && (!entry.attempted || !entry.grade))
      throw new Error(`Available task has no attempt or grade: ${id}`);
    if (!entry.available && entry.grade !== null)
      throw new Error(`Unavailable task has a quality grade: ${id}`);
    const grade = entry.grade;
    const issued = raw.calls.filter(
      (call) => call.reservationId && call.status !== "not-issued",
    );
    if (entry.attempted !== (manifest.arm === "library" || issued.length > 0))
      throw new Error(
        `Attempt flag differs from issued provider receipts: ${id}`,
      );
    const usage = issued.flatMap((call) => {
      const input = numeric(call.response?.usage.inputTokens),
        output = numeric(call.response?.usage.outputTokens);
      return input !== null && output !== null && input + output > 0
        ? [{ input, output }]
        : [];
    });
    const budgetCalls = issued.flatMap(
      (call) => ledger?.get(call.reservationId!) ?? [],
    );
    if (
      budgetCalls.some(
        (call) => call.taskId !== id || call.arm !== manifest.arm,
      )
    )
      throw new Error(
        `Budget reservation belongs to a different task or arm: ${id}`,
      );
    const budgetComplete = budgetCalls.length === issued.length;
    rows.push({
      attemptId: manifest.attemptId,
      arm: manifest.arm,
      scope,
      taskId: id,
      sceneGroup: task.sceneGroup,
      attempted: entry.attempted,
      available: entry.available,
      status: entry.status,
      termination: entry.termination,
      productive: grade ? grade.productive : null,
      knownWitness: grade ? grade.knownFeasible : null,
      witnessSourceAttempts: grade ? [manifest.attemptId] : [],
      creditedPlans: grade?.planGrades.length ?? null,
      invalidAdmissions: grade
        ? grade.planGrades.filter((plan) => plan.checks.feasible === false)
            .length
        : null,
      emptyFinish: boolean(grade?.emptyFinish),
      compileChecked: boolean(grade?.compileChecked),
      uncheckedEmpty: boolean(grade?.uncheckedEmpty),
      falseAbstention: boolean(grade?.falseAbstention),
      unsupportedAbstention: boolean(grade?.unsupportedAbstention),
      coordinatorLatencyMs: numeric(raw.result?.latencyMs),
      harnessLatencyMs: numeric(entry.latencyMs),
      providerCalls: issued.length,
      callsWithReportedUsage: usage.length,
      callsWithoutReportedUsage: issued.length - usage.length,
      reportedInputTokens: usage.reduce((sum, value) => sum + value.input, 0),
      reportedOutputTokens: usage.reduce((sum, value) => sum + value.output, 0),
      estimatedChargeUsd: budgetComplete
        ? budgetCalls.reduce(
            (sum, call) => sum + (call.chargedNanodollars ?? 0),
            0,
          ) / 1e9
        : null,
      outstandingReservationUsd: budgetComplete
        ? budgetCalls
            .filter((call) => call.chargedNanodollars === undefined)
            .reduce((sum, call) => sum + call.reservedNanodollars, 0) / 1e9
        : null,
      missingBudgetReceipts: issued.length - budgetCalls.length,
    });
  }
  const taskGroups: Record<string, string[]> = {};
  for (const task of tasks.filter((task) => task.split === manifest.split))
    (taskGroups[task.sceneGroup] ??= []).push(task.id);
  return {
    directory: resolve(directory),
    scope,
    manifest,
    receipts,
    taskGroups,
    rows,
    recordedSummary,
  };
}

function witnessCompatible(a: Campaign, b: Campaign) {
  const paths = [
    "training/experiments/next/search.ts",
    "training/experiments/next/grade.ts",
    "src/domain/engine.ts",
    "src/domain/contracts.ts",
    "src/domain/geometry.ts",
    "src/domain/defaults.ts",
  ];
  return (
    a.scope === b.scope &&
    a.manifest.tasksSha256 === b.manifest.tasksSha256 &&
    a.manifest.checkerVersion === b.manifest.checkerVersion &&
    paths.every(
      (path) =>
        !!a.manifest.sourceHashes[path] &&
        a.manifest.sourceHashes[path] === b.manifest.sourceHashes[path],
    )
  );
}
export function attachWitnessEvidence(campaigns: Campaign[]): Campaign[] {
  return campaigns.map((campaign) => ({
    ...campaign,
    rows: campaign.rows.map((row) => {
      const evidence = campaigns
        .filter((other) => witnessCompatible(campaign, other))
        .flatMap((other) => {
          const match = other.rows.find(
            (candidate) =>
              candidate.taskId === row.taskId &&
              candidate.knownWitness !== null,
          );
          return match
            ? [
                {
                  value: match.knownWitness!,
                  attemptId: other.manifest.attemptId,
                },
              ]
            : [];
        });
      if (new Set(evidence.map((item) => item.value)).size > 1)
        throw new Error(
          `Conflicting recorded witness evidence for ${row.taskId}`,
        );
      return evidence.length
        ? {
            ...row,
            knownWitness: evidence[0].value,
            witnessSourceAttempts: evidence.map((item) => item.attemptId),
          }
        : row;
    }),
  }));
}
function quantile(sorted: number[], p: number) {
  const at = (sorted.length - 1) * p,
    lower = Math.floor(at),
    upper = Math.ceil(at);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (at - lower);
}
export function distribution(values: (number | null)[]) {
  const sorted = values
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  return {
    count: sorted.length,
    missing: values.length - sorted.length,
    median: sorted.length ? quantile(sorted, 0.5) : null,
    p95: sorted.length ? quantile(sorted, 0.95) : null,
    minimum: sorted[0] ?? null,
    maximum: sorted.at(-1) ?? null,
  };
}
export function summarizeCampaign(campaign: Campaign) {
  const rows = campaign.rows,
    available = rows.filter((row) => row.available),
    witness = rows.filter((row) => row.knownWitness === true),
    witnessAvailable = witness.filter((row) => row.available);
  const successes = (values: Row[]) =>
    values.filter((row) => row.productive === true).length;
  const count = (key: "status" | "termination") =>
    Object.fromEntries(
      [...new Set(rows.map((row) => row[key]))]
        .sort()
        .map((value) => [
          value,
          rows.filter((row) => row[key] === value).length,
        ]),
    );
  const sum = (
    key:
      | "providerCalls"
      | "callsWithReportedUsage"
      | "callsWithoutReportedUsage"
      | "reportedInputTokens"
      | "reportedOutputTokens"
      | "missingBudgetReceipts",
  ) => rows.reduce((total, row) => total + row[key], 0);
  const estimated = (
    key: "estimatedChargeUsd" | "outstandingReservationUsd",
  ) => ({
    observedUsd: rows.reduce((total, row) => total + (row[key] ?? 0), 0),
    tasksMissingReceipts: rows.filter((row) => row[key] === null).length,
  });
  return {
    scheduled: rows.length,
    sceneGroups: new Set(rows.map((row) => row.sceneGroup)).size,
    attempted: rows.filter((row) => row.attempted).length,
    unattempted: rows.filter((row) => !row.attempted).length,
    availability: ratio(available.length, rows.length),
    status: count("status"),
    termination: count("termination"),
    operationalSuccessAmongScheduled: ratio(successes(rows), rows.length),
    qualitySuccessAmongAvailable: ratio(successes(available), available.length),
    knownWitness: {
      scheduled: witness.length,
      available: witnessAvailable.length,
      unknown: rows.filter((row) => row.knownWitness === null).length,
      operationalSuccessAmongScheduled: ratio(
        successes(witness),
        witness.length,
      ),
      qualitySuccessAmongAvailable: ratio(
        successes(witnessAvailable),
        witnessAvailable.length,
      ),
    },
    admissions: {
      creditedPlans: available.reduce(
        (sum, row) => sum + (row.creditedPlans ?? 0),
        0,
      ),
      invalidPlans: available.reduce(
        (sum, row) => sum + (row.invalidAdmissions ?? 0),
        0,
      ),
      tasksWithInvalidPlan: available.filter(
        (row) => (row.invalidAdmissions ?? 0) > 0,
      ).length,
    },
    empty: {
      accepted: available.filter((row) => row.emptyFinish === true).length,
      checked: available.filter(
        (row) => row.emptyFinish === true && row.compileChecked === true,
      ).length,
      unchecked: available.filter((row) => row.uncheckedEmpty === true).length,
      checkStatusUnknown: available.filter(
        (row) => row.emptyFinish === true && row.compileChecked === null,
      ).length,
      falseAbstention: available.filter((row) => row.falseAbstention === true)
        .length,
      unsupportedAbstention: available.filter(
        (row) => row.unsupportedAbstention === true,
      ).length,
    },
    latencyMs: {
      coordinatorAttempted: distribution(
        rows
          .filter((row) => row.attempted)
          .map((row) => row.coordinatorLatencyMs),
      ),
      harnessAttempted: distribution(
        rows.filter((row) => row.attempted).map((row) => row.harnessLatencyMs),
      ),
      coordinatorAvailable: distribution(
        available.map((row) => row.coordinatorLatencyMs),
      ),
    },
    usage: {
      providerCalls: sum("providerCalls"),
      callsWithReportedUsage: sum("callsWithReportedUsage"),
      callsWithoutReportedUsage: sum("callsWithoutReportedUsage"),
      reportedInputTokens: sum("reportedInputTokens"),
      reportedOutputTokens: sum("reportedOutputTokens"),
      disclosure:
        "Reported usage includes returned call receipts even if a later call failed. Missing or zero usage stays unknown; late responses outside the sealed task receipt are not substituted.",
    },
    budget: {
      estimatedCharge: estimated("estimatedChargeUsd"),
      outstandingReservation: estimated("outstandingReservationUsd"),
      missingCallReceipts: sum("missingBudgetReceipts"),
      disclosure:
        "Only reservation IDs from this attempt are included. Estimates and outstanding reservations are not invoice-derived charges; a shared ledger may also contain other attempts.",
    },
  };
}

export type Cluster = {
  sceneGroup: string;
  pairs: { base: number | null; trained: number | null }[];
};
/** Resamples whole scene groups with replacement, retaining their dependent task pairs. */
export function pairedClusterBootstrap(
  clusters: Cluster[],
  seed = 20261029,
  iterations = 10000,
) {
  if (
    !Number.isInteger(seed) ||
    seed < 0 ||
    seed > 0xffffffff ||
    !Number.isInteger(iterations) ||
    iterations < 100 ||
    iterations > 100000
  )
    throw new Error(
      "Bootstrap requires an integer seed and 100–100000 iterations.",
    );
  if (
    new Set(clusters.map((cluster) => cluster.sceneGroup)).size !==
    clusters.length
  )
    throw new Error("Bootstrap cluster IDs must be unique.");
  if (
    clusters.some((cluster) =>
      cluster.pairs.some(
        (pair) =>
          ![0, 1, null].includes(pair.base) ||
          ![0, 1, null].includes(pair.trained),
      ),
    )
  )
    throw new Error("Bootstrap outcomes must be binary or missing.");
  const eligibleGroups = clusters.filter((cluster) =>
    cluster.pairs.some((pair) => pair.base !== null && pair.trained !== null),
  ).length;
  let state = seed >>> 0;
  const random = () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const estimate = (sample: Cluster[]) => {
    let base = 0,
      trained = 0,
      denominator = 0;
    for (const cluster of sample)
      for (const pair of cluster.pairs) {
        if (pair.base === null || pair.trained === null) continue;
        base += pair.base;
        trained += pair.trained;
        denominator++;
      }
    return {
      base: ratio(base, denominator),
      trained: ratio(trained, denominator),
      difference: denominator ? (trained - base) / denominator : null,
    };
  };
  const point = estimate(clusters),
    differences: number[] = [];
  if (eligibleGroups >= 2 && point.difference !== null)
    for (let i = 0; i < iterations; i++) {
      const sample = Array.from(
        { length: clusters.length },
        () => clusters[Math.floor(random() * clusters.length)],
      );
      const value = estimate(sample).difference;
      if (value !== null) differences.push(value);
    }
  differences.sort((a, b) => a - b);
  return {
    ...point,
    sceneGroups: clusters.length,
    sceneGroupsWithEligiblePairs: eligibleGroups,
    intervalLimitation:
      eligibleGroups < 2
        ? "Fewer than two independent groups contain eligible pairs; no interval estimated."
        : eligibleGroups < 10
          ? "Few independent groups; percentile interval can be unstable."
          : null,
    interval95: differences.length
      ? [quantile(differences, 0.025), quantile(differences, 0.975)]
      : null,
    seed,
    iterations,
    validReplicates: differences.length,
    emptyReplicates:
      eligibleGroups >= 2 && point.difference !== null
        ? iterations - differences.length
        : 0,
    method:
      "Paired scene-group percentile bootstrap; difference is trained minus base. Entire groups are sampled with replacement; no task-level independent resampling.",
  };
}

export function compareCampaigns(
  base: Campaign,
  trained: Campaign,
  seed = 20261029,
  iterations = 10000,
) {
  const mismatches: string[] = [];
  for (const field of [
    "tasksSha256",
    "checkerVersion",
    "runtimeVersion",
    "promptSha256",
    "inferenceBaseUrl",
    "sourceHashes",
    "settings",
    "protocol",
  ] as const)
    if (!isDeepStrictEqual(base.manifest[field], trained.manifest[field]))
      mismatches.push(field);
  if (base.scope !== trained.scope || base.scope === "initial-network-pilot")
    mismatches.push("scope");
  const identity = {
    baseAttemptId: base.manifest.attemptId,
    trainedAttemptId: trained.manifest.attemptId,
    scope: base.scope,
  };
  if (
    base.manifest.arm !== "llama-base" ||
    trained.manifest.arm !== "llama-sft"
  )
    mismatches.push("arms");
  if (mismatches.length)
    return { ...identity, compatible: false as const, mismatches };
  const a = new Map(base.rows.map((row) => [row.taskId, row])),
    b = new Map(trained.rows.map((row) => [row.taskId, row]));
  const completeGroups = Object.entries(base.taskGroups).filter(([, ids]) =>
    ids.every((id) => a.has(id) && b.has(id)),
  );
  const pairs = completeGroups.flatMap(([, ids]) =>
    ids.map((id) => ({ base: a.get(id)!, trained: b.get(id)! })),
  );
  const clusters = (mode: "operational" | "available" | "witness"): Cluster[] =>
    completeGroups.map(([sceneGroup, ids]) => ({
      sceneGroup,
      pairs: ids.map((id) => {
        const left = a.get(id)!,
          right = b.get(id)!;
        const eligible =
          mode === "operational" ||
          (left.available &&
            right.available &&
            (mode !== "witness" ||
              (left.knownWitness === true && right.knownWitness === true)));
        return {
          base: eligible ? Number(left.productive === true) : null,
          trained: eligible ? Number(right.productive === true) : null,
        };
      }),
    }));
  return {
    ...identity,
    compatible: true as const,
    completeSceneGroups: completeGroups.length,
    excludedIncompleteSceneGroups: Object.keys(base.taskGroups).filter(
      (group) => !completeGroups.some(([id]) => id === group),
    ),
    missingness: {
      pairedScheduled: pairs.length,
      pairedAvailable: pairs.filter(
        (pair) => pair.base.available && pair.trained.available,
      ).length,
      baseOnlyAvailable: pairs.filter(
        (pair) => pair.base.available && !pair.trained.available,
      ).length,
      trainedOnlyAvailable: pairs.filter(
        (pair) => !pair.base.available && pair.trained.available,
      ).length,
      neitherAvailable: pairs.filter(
        (pair) => !pair.base.available && !pair.trained.available,
      ).length,
      baseUnattempted: pairs.filter((pair) => !pair.base.attempted).length,
      trainedUnattempted: pairs.filter((pair) => !pair.trained.attempted)
        .length,
    },
    operationalSuccessAmongPairedScheduled: pairedClusterBootstrap(
      clusters("operational"),
      seed,
      iterations,
    ),
    qualitySuccessAmongPairedAvailable: pairedClusterBootstrap(
      clusters("available"),
      seed,
      iterations,
    ),
    qualitySuccessAmongPairedAvailableWitnesses: pairedClusterBootstrap(
      clusters("witness"),
      seed,
      iterations,
    ),
    interpretation:
      "Operational success counts an unavailable scheduled pipeline outcome as no delivered plan. Quality estimates exclude unavailable outcomes rather than label them model mistakes. Paired-available estimates are conditional on observed availability and may be selected. Development remains diagnostic; these authored scene groups are not creators or real-world filming outcomes.",
  };
}
const csvCell = (value: unknown) => {
  const string =
    value === null || value === undefined
      ? ""
      : Array.isArray(value)
        ? value.join(";")
        : String(value);
  return /[",\n\r]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
};
export function rowsCsv(rows: Row[]) {
  const columns: (keyof Row)[] = [
    "attemptId",
    "scope",
    "arm",
    "taskId",
    "sceneGroup",
    "attempted",
    "available",
    "status",
    "termination",
    "productive",
    "knownWitness",
    "witnessSourceAttempts",
    "creditedPlans",
    "invalidAdmissions",
    "emptyFinish",
    "compileChecked",
    "uncheckedEmpty",
    "falseAbstention",
    "unsupportedAbstention",
    "coordinatorLatencyMs",
    "harnessLatencyMs",
    "providerCalls",
    "callsWithReportedUsage",
    "callsWithoutReportedUsage",
    "reportedInputTokens",
    "reportedOutputTokens",
    "estimatedChargeUsd",
    "outstandingReservationUsd",
    "missingBudgetReceipts",
  ];
  return (
    [
      columns.join(","),
      ...rows.map((row) => columns.map((key) => csvCell(row[key])).join(",")),
    ].join("\n") + "\n"
  );
}
const points = (value: number | null) =>
  value === null
    ? "unavailable"
    : `${(value * 100).toFixed(1)} percentage points`;
const percent = (value: number | null) =>
  value === null ? "unavailable" : `${(value * 100).toFixed(1)}%`;
function markdown(
  campaigns: Campaign[],
  comparisons: ReturnType<typeof compareCampaigns>[],
) {
  const lines = [
    "# FlowBlock recorded campaign analysis",
    "",
    "Every row below is a separate preserved attempt. Scores are read from receipts; no plan is regraded. Operational success measures delivered plans across scheduled tasks. Quality success excludes unavailable outcomes.",
    "",
    "| Scope / attempt | Arm | Scheduled | Available | Operational success | Quality success | Witness quality | Invalid plans |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const campaign of campaigns) {
    const s = summarizeCampaign(campaign);
    lines.push(
      `| ${campaign.scope} / ${campaign.manifest.attemptId} | ${campaign.manifest.arm} | ${s.scheduled} | ${s.availability.numerator} | ${percent(s.operationalSuccessAmongScheduled.rate)} | ${percent(s.qualitySuccessAmongAvailable.rate)} (${s.qualitySuccessAmongAvailable.numerator}/${s.qualitySuccessAmongAvailable.denominator}) | ${percent(s.knownWitness.qualitySuccessAmongAvailable.rate)} (${s.knownWitness.qualitySuccessAmongAvailable.numerator}/${s.knownWitness.qualitySuccessAmongAvailable.denominator}) | ${s.admissions.invalidPlans} |`,
    );
  }
  lines.push("", "## Base versus trained Llama", "");
  if (!comparisons.length)
    lines.push(
      "No completed base/SFT pair was supplied. No training-effect estimate is available.",
      "",
    );
  for (const comparison of comparisons) {
    lines.push(
      `**${comparison.baseAttemptId} → ${comparison.trainedAttemptId}** (${comparison.scope})`,
      "",
    );
    if (!comparison.compatible) {
      lines.push(
        `Not pooled: protocol mismatch in ${comparison.mismatches.join(", ")}.`,
        "",
      );
      continue;
    }
    const quality = comparison.qualitySuccessAmongPairedAvailable,
      operational = comparison.operationalSuccessAmongPairedScheduled;
    const interval = (value: typeof quality) =>
      value.interval95
        ? `${points(value.interval95[0])} to ${points(value.interval95[1])}`
        : "unavailable";
    lines.push(
      `Across ${comparison.completeSceneGroups} complete scene groups, ${comparison.missingness.pairedAvailable}/${comparison.missingness.pairedScheduled} task pairs were available in both arms. Paired quality changed by ${points(quality.difference)} (95% scene-group bootstrap interval ${interval(quality)}). Operational success changed by ${points(operational.difference)} (interval ${interval(operational)}).`,
      "",
      `Availability differed: base only ${comparison.missingness.baseOnlyAvailable}; trained only ${comparison.missingness.trainedOnlyAvailable}; neither ${comparison.missingness.neitherAvailable}. The quality comparison is conditional on this available subset.`,
      "",
    );
  }
  lines.push(
    "## Interpretation",
    "",
    "The JSON report contains status counts, known-witness coverage, empty-result checks, separate coordinator and harness latency, reported tokens, and attempt-specific cost reservations. Reserved cost is not billed cost. Missing usage is not zero usage.",
    "",
    "Intervals resample complete scene groups with their dependent tasks. They do not treat six moves in one room as six independent rooms. Development and the initial network pilot remain diagnostic; neither is fresh confirmation evidence. Synthetic planning outcomes and public tracking data do not answer whether measured feedback helps creators get a usable take sooner.",
    "",
  );
  return lines.join("\n");
}
export async function analyzeCampaigns(
  inputs: { directory: string; pilot?: boolean }[],
  output: string,
  seed = 20261029,
  iterations = 10000,
) {
  pairedClusterBootstrap([], seed, iterations);
  const campaigns = attachWitnessEvidence(
    await Promise.all(
      inputs.map((input) => loadCampaign(input.directory, input.pilot)),
    ),
  );
  if (
    !campaigns.length ||
    new Set(campaigns.map((campaign) => campaign.manifest.attemptId)).size !==
      campaigns.length
  )
    throw new Error("Supply at least one unique completed campaign.");
  const comparisons = campaigns
    .filter((campaign) => campaign.manifest.arm === "llama-base")
    .flatMap((base) =>
      campaigns
        .filter((campaign) => campaign.manifest.arm === "llama-sft")
        .map((trained) => compareCampaigns(base, trained, seed, iterations)),
    );
  const report = {
    schemaVersion: 1,
    analysisVersion,
    generatedAt: new Date().toISOString(),
    analysisSourceSha256: sha256(await readFile(new URL(import.meta.url))),
    seed,
    iterations,
    campaigns: campaigns.map((campaign) => ({
      attemptId: campaign.manifest.attemptId,
      arm: campaign.manifest.arm,
      model: campaign.manifest.model,
      scope: campaign.scope,
      sourceDirectory: relative(resolve(output), campaign.directory),
      receipts: campaign.receipts,
      manifest: campaign.manifest,
      summary: summarizeCampaign(campaign),
      originalRecordedSummary: campaign.recordedSummary,
    })),
    comparisons,
    limitations: [
      "No current-code regrading or replacement of sealed outputs.",
      "Unavailable quality outcomes stay missing; operational delivery failures use the scheduled denominator.",
      "Known witnesses come only from compatible recorded deterministic checks; absence of a witness does not prove infeasibility.",
      "Bootstrap uncertainty concerns these authored scene groups, not creators or general cinematic quality.",
      "No creator benefit or training improvement is inferred from absent arms.",
    ],
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await mkdir(output);
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  await writeFile(
    resolve(output, "tasks.csv"),
    rowsCsv(campaigns.flatMap((campaign) => campaign.rows)),
    { flag: "wx" },
  );
  await writeFile(
    resolve(output, "report.md"),
    markdown(campaigns, comparisons),
    { flag: "wx" },
  );
  return report;
}
async function main() {
  const inputs: { directory: string; pilot?: boolean }[] = [];
  let output: string | undefined,
    seed = 20261029,
    iterations = 10000;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === "--run" || key === "--pilot")
      inputs.push({ directory: value, pilot: key === "--pilot" });
    else if (key === "--output" && !output) output = value;
    else if (key === "--seed") seed = Number(value);
    else if (key === "--iterations") iterations = Number(value);
    else throw new Error(`Unknown or repeated argument ${key}`);
  }
  if (!output)
    throw new Error(
      "Required: --run COMPLETED_DIR [--run OTHER_DIR] [--pilot PILOT_DIR] --output NEW_DIR",
    );
  const result = await analyzeCampaigns(inputs, output, seed, iterations);
  process.stdout.write(
    JSON.stringify({
      campaigns: result.campaigns.length,
      comparisons: result.comparisons.length,
      output,
    }) + "\n",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
