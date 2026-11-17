import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import type { Entry } from "./run";

const directory = resolve(process.argv[2]);
const manifest = JSON.parse(
  await readFile(resolve(directory, "manifest.json"), "utf8"),
);
const datasetBytes = await readFile(
  resolve(directory, "dataset-manifest.json"),
);
const entries = (await readFile(resolve(directory, "results.jsonl"), "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Entry);
const summary = JSON.parse(
  await readFile(resolve(directory, "summary.json"), "utf8"),
);
const measured = entries.filter((entry) => entry.available);
const known = measured.filter((entry) => entry.grade?.knownFeasible);
const counts: Record<string, number> = {
  "tasks/requested": entries.length,
  "tasks/attempted": entries.filter((entry) => entry.attempted).length,
  "tasks/available": measured.length,
  "tasks/unattempted": entries.filter((entry) => entry.status === "unattempted")
    .length,
  "tasks/service_unavailable": entries.filter(
    (entry) => entry.status === "service-unavailable",
  ).length,
  "plans/productive": measured.filter((entry) => entry.grade?.productive)
    .length,
  "plans/admitted_invalid": measured.reduce(
    (n, entry) =>
      n +
      (entry.grade?.planGrades.filter((plan) => !plan.checks.feasible).length ??
        0),
    0,
  ),
  "plans/false_abstentions": measured.filter(
    (entry) => entry.grade?.falseAbstention,
  ).length,
  "plans/known_witness_tasks_available": known.length,
  "usage/complete_tasks": summary.completeUsageTasks,
  "usage/reported_input_tokens": summary.reportedInputTokens,
  "usage/reported_output_tokens": summary.reportedOutputTokens,
};
if (entries.length)
  counts["workflow/productive_fraction_scheduled"] =
    counts["plans/productive"] / entries.length;
if (measured.length)
  counts["plans/productive_fraction_available"] =
    counts["plans/productive"] / measured.length;
if (known.length)
  counts["plans/productive_fraction_known_witness_available"] =
    known.filter((entry) => entry.grade?.productive).length / known.length;
const result = {
  schemaVersion: 1,
  experimentId: `flowblock-v2-${manifest.split}-${manifest.arm}-${manifest.attemptId.slice(0, 19)}`,
  datasetManifestSha256: createHash("sha256")
    .update(datasetBytes)
    .digest("hex"),
  status: "completed",
  metrics: counts,
  rows: entries.map((entry) => ({
    taskId: entry.taskId,
    sceneId: entry.sceneGroup,
    arm: entry.arm,
    split: manifest.split,
    available: entry.available,
    status: entry.status,
    preservedBrief: entry.grade?.productive ?? null,
    feasible: entry.grade
      ? entry.grade.planGrades.some((grade) => grade.checks.feasible)
      : null,
    durationMs: entry.latencyMs,
    inputTokens: entry.usage?.inputTokens ?? null,
    outputTokens: entry.usage?.outputTokens ?? null,
    outcome: entry.termination,
    runtimeVersion: manifest.runtimeVersion,
    checkerVersion: manifest.checkerVersion,
    note: entry.available
      ? "Recorded model output or deterministic search, checked against the structured brief. durationMs is harness wall time including scoring, not model latency."
      : "Unavailable or unattempted; no model-quality score. Unknown usage is retained in the budget ledger.",
  })),
  metadata: {
    runtimeVersion: manifest.runtimeVersion,
    checkerVersion: manifest.checkerVersion,
    evaluationKind: manifest.split,
    limitations: [
      "Authored synthetic rooms and dimensioned products. Geometry and semantic checks do not measure cinematic quality or creator time savings.",
      "Six dependent tasks per scene group. Do not treat the task count as a count of independent rooms.",
      "The library reference has a structured movement family and checker access; model arms receive the natural-language brief.",
      "Scheduled workflow completion includes unavailable and unattempted requests; available-only and known-witness scores have separate denominators.",
      "This run publishes recorded execution. Publication duration is not inference latency. Exact coordinator latency and requests are preserved in the local task receipts and native Weave evaluation.",
      "Token costs are estimates at published rates, not a billing readback.",
      `Exact model identity: ${manifest.model ?? manifest.runtimeVersion}. Attempt: ${manifest.attemptId}.`,
    ],
  },
};
const path = resolve(directory, "models-results.json");
await writeFile(path, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ path, metrics: counts }));
