import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Fixture } from "../../fixtures";
import {
  diagnoseRecordedAttempt,
  diagnosticsVersion,
  type RecordedAttempt,
} from "./diagnostics";

const hash = (bytes: string) =>
  createHash("sha256").update(bytes).digest("hex");
const attemptNames = [
  "2026-10-29T09-55-47-916Z-baseline-9b8ab274",
  "2026-10-29T09-57-33-340Z-base-cf306701",
  "2026-10-29T10-00-01-734Z-candidate-3dd66429",
];
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output"))
  throw new Error("Usage: diagnose-history.ts [--output NEW_RECEIPT_PATH]");
const fixtureBytes = await readFile("training/frozen/fixtures.json", "utf8");
const fixtures = JSON.parse(fixtureBytes) as Fixture[];
const arms = [];
for (const attempt of attemptNames) {
  const manifestBytes = await readFile(
    `training/artifacts/${attempt}/manifest.json`,
    "utf8",
  );
  const manifest = JSON.parse(manifestBytes) as {
    arm: string;
    fixtureIds: string[];
  };
  const tasks = [];
  for (const id of manifest.fixtureIds) {
    const fixture = fixtures.find((item) => item.id === id);
    if (!fixture) throw new Error(`Missing diagnostic fixture ${id}`);
    const sourcePath = `training/artifacts/${attempt}/${id}.json`;
    const bytes = await readFile(sourcePath, "utf8");
    const diagnostic = await diagnoseRecordedAttempt(
      fixture,
      JSON.parse(bytes) as RecordedAttempt,
      "frozen-v1",
    );
    tasks.push({ sourcePath, sourceSha256: hash(bytes), ...diagnostic });
  }
  const counts: Record<string, number> = {};
  const violationCounts: Record<string, number> = {};
  for (const task of tasks) {
    for (const [key, value] of Object.entries(task.counts))
      counts[key] = (counts[key] ?? 0) + value;
    for (const [key, value] of Object.entries(task.recomputedViolationCounts))
      violationCounts[key] = (violationCounts[key] ?? 0) + value;
  }
  arms.push({
    arm: manifest.arm,
    attempt,
    manifestSha256: hash(manifestBytes),
    taskCount: tasks.length,
    counts,
    recomputedViolationCounts: violationCounts,
    tasks,
  });
}
const rows = (await readFile("training/frozen/train.jsonl", "utf8"))
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as { messages: { content: string }[] });
const trainingTargetCounts: Record<string, number> = {};
for (const row of rows) {
  const action = JSON.parse(row.messages.at(-1)!.content) as {
    action: string;
    candidateIds?: string[];
  };
  const label =
    action.action === "finish"
      ? action.candidateIds?.length
        ? "finish-with-candidate"
        : "finish-empty"
      : action.action;
  trainingTargetCounts[label] = (trainingTargetCounts[label] ?? 0) + 1;
}
const report = {
  diagnosticsVersion,
  createdAt: new Date().toISOString(),
  purpose: "Development diagnosis of already inspected historical tasks",
  fixtureSha256: hash(fixtureBytes),
  trainingTargetCounts,
  uniqueBoundaryWidths: [
    ...new Set(
      fixtures.map((fixture) => {
        const xs = fixture.input.scene.boundary.map((point) => point.x);
        return Math.max(...xs) - Math.min(...xs);
      }),
    ),
  ],
  arms,
  limitations: [
    "Recomputed compiles are diagnostic counterfactuals, not a new model run or evidence that an unrecorded tool ran.",
    "The three arms share the same twelve inspected tasks in two scene groups. These tasks are development data for future changes.",
    "Recorded grades are retained. The next experiment requires a fresh confirmation set and a stronger brief-preservation checker.",
  ],
};
if (args[1]) {
  const path = resolve(args[1]);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(
    `${JSON.stringify({ path, arms: arms.map(({ arm, counts }) => ({ arm, counts })), trainingTargetCounts, uniqueBoundaryWidths: report.uniqueBoundaryWidths }, null, 2)}\n`,
  );
} else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
