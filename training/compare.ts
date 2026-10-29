import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "./fixtures";

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath)
  throw new Error(
    "Usage: tsx training/compare.ts BEFORE_ATTEMPT_DIRECTORY AFTER_ATTEMPT_DIRECTORY",
  );
async function readAttempt(path: string) {
  const manifest = JSON.parse(
    await readFile(resolve(path, "manifest.json"), "utf8"),
  );
  const summary = JSON.parse(
    await readFile(resolve(path, "summary.json"), "utf8"),
  );
  const raw = await readFile(resolve(path, "results.jsonl"), "utf8");
  const results = raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line)) as {
    fixtureId: string;
    available: boolean;
    grade: {
      success: boolean;
      feasibilityOutcome: string;
      schemaValidity: number;
      geometryValidity: number;
      invalidCandidateCount: number;
      compileCount: number;
    };
    latencyMs: number;
  }[];
  return { manifest, summary, results, resultsHash: digest(raw) };
}
const before = await readAttempt(beforePath),
  after = await readAttempt(afterPath);
const equivalenceIndex = process.argv.indexOf("--equivalence");
const equivalence =
  equivalenceIndex < 0
    ? null
    : JSON.parse(
        await readFile(resolve(process.argv[equivalenceIndex + 1]), "utf8"),
      );
const equivalentSourceHashes =
  equivalence?.verified === true &&
  equivalence.beforeAttempt === before.manifest.attempt &&
  equivalence.afterAttempt === after.manifest.attempt &&
  Object.keys(before.manifest.sourceHashes || {}).every(
    (path) =>
      before.manifest.sourceHashes[path] ===
        after.manifest.sourceHashes?.[path] ||
      (path === equivalence.path &&
        before.manifest.sourceHashes[path] === equivalence.beforeHash &&
        after.manifest.sourceHashes[path] === equivalence.afterHash),
  );
const mismatches: string[] = [];
for (const key of [
  "fixtureSha256",
  "systemPromptSha256",
  "plannerVersion",
  "checkerVersion",
  "settings",
  "fixtureIds",
  "sourceHashes",
])
  if (
    (JSON.stringify(before.manifest[key]) !==
      JSON.stringify(after.manifest[key]) ||
      before.manifest[key] === undefined) &&
    !(key === "sourceHashes" && equivalentSourceHashes)
  )
    mismatches.push(key);
if (
  String(before.manifest.inferenceBaseUrl).replace(/\/$/, "") !==
  String(after.manifest.inferenceBaseUrl).replace(/\/$/, "")
)
  mismatches.push("inferenceBaseUrl");
const pairs = before.results.flatMap((a) => {
  const b = after.results.find((r) => r.fixtureId === a.fixtureId);
  return b && a.available && b.available
    ? [
        {
          fixtureId: a.fixtureId,
          before: a.grade.success,
          after: b.grade.success,
          beforeLatencyMs: a.latencyMs,
          afterLatencyMs: b.latencyMs,
        },
      ]
    : [];
});
const gains = pairs.filter((p) => !p.before && p.after).length,
  losses = pairs.filter((p) => p.before && !p.after).length;
const result = {
  comparison: "Matched base versus trained candidate qualification",
  controlsMatched: mismatches.length === 0,
  mismatches,
  exactSourceHashesMatch:
    JSON.stringify(before.manifest.sourceHashes) ===
    JSON.stringify(after.manifest.sourceHashes),
  sourceEquivalenceAudit: equivalentSourceHashes ? equivalence : null,
  beforeAttempt: before.manifest.attempt,
  afterAttempt: after.manifest.attempt,
  beforeResultsSha256: before.resultsHash,
  afterResultsSha256: after.resultsHash,
  requestedTasks: before.manifest.fixtureIds.length,
  pairedAvailableTasks: pairs.length,
  pairedSceneGroups: new Set(
    pairs.map((p) =>
      p.fixtureId.replace(/-(hold|push-in|pull-out|lateral|orbit|reveal)$/, ""),
    ),
  ).size,
  gains,
  losses,
  sharedSuccesses: pairs.filter((p) => p.before && p.after).length,
  sharedFailures: pairs.filter((p) => !p.before && !p.after).length,
  beforeProductiveCandidates: before.results.filter(
    (r) => r.available && r.grade.feasibilityOutcome === "candidate",
  ).length,
  afterProductiveCandidates: after.results.filter(
    (r) => r.available && r.grade.feasibilityOutcome === "candidate",
  ).length,
  beforeBoundedSearchAbstentions: before.results.filter(
    (r) =>
      r.available && r.grade.feasibilityOutcome === "bounded-search-abstention",
  ).length,
  afterBoundedSearchAbstentions: after.results.filter(
    (r) =>
      r.available && r.grade.feasibilityOutcome === "bounded-search-abstention",
  ).length,
  pairedSuccessDelta:
    pairs.length && mismatches.length === 0
      ? (gains - losses) / pairs.length
      : null,
  beforeSummary: before.summary,
  afterSummary: after.summary,
  pairs,
  interpretation:
    "One trial per intent, dependent intents within scene groups, synthetic fixtures and solver-defined criteria. This qualification does not establish cinematic quality or generalization beyond these scenes. No automatic model promotion.",
};
await mkdir(resolve("training/results"), { recursive: true });
const target = resolve(
  "training/results",
  `${before.manifest.attempt}--${after.manifest.attempt}${equivalence ? "-audited" : ""}.json`,
);
await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${JSON.stringify({ target, ...result }, null, 2)}\n`);
