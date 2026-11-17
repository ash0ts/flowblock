import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { runWithWatchdog } from "./watchdog";
import type { Task } from "../next/grade";

const hash = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Pass a frozen experiment directory.");
const root = resolve(directory);
const protocol = JSON.parse(
  readFileSync(resolve(root, "protocol.json"), "utf8"),
);
for (const [path, expected] of Object.entries(protocol.sourceHashes)) {
  if (hash(readFileSync(path)) !== expected)
    throw new Error(`Frozen runtime changed: ${path}`);
}
const suiteBytes = readFileSync(resolve(root, "suite.json"));
if (hash(suiteBytes) !== protocol.suiteSha256)
  throw new Error("Frozen suite changed.");
const suite = JSON.parse(suiteBytes.toString()) as { tasks: Task[] };
const tasks = new Map(suite.tasks.map((t) => [t.id, t]));
const ledger = resolve(root, "budget.json");
const json = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
json(resolve(root, "execution-claim.json"), {
  startedAt: new Date().toISOString(),
  protocolSha256: hash(readFileSync(resolve(root, "protocol.json"))),
  pid: process.pid,
  nodeVersion: process.version,
  platform: process.platform,
  architecture: process.arch,
});
let stopReason: string | null = null;
let consecutiveUnavailablePairs = 0;
let pairAvailability: boolean[] = [];
const rows: Record<string, unknown>[] = [];
for (const occurrence of protocol.schedule as {
  id: string;
  taskId: string;
  arm: string;
  model: string;
  trial: number;
}[]) {
  const task = tasks.get(occurrence.taskId);
  if (!task) throw new Error("Unknown frozen task.");
  const output = resolve(root, "occurrences", occurrence.id);
  mkdirSync(output, { recursive: true });
  if (stopReason) {
    const row = {
      ...occurrence,
      sceneGroup: task.sceneGroup,
      available: false,
      attempted: false,
      stopReason,
    };
    rows.push(row);
    json(resolve(output, "entry.json"), row);
    continue;
  }
  for (const [path, expected] of Object.entries(protocol.sourceHashes)) {
    if (hash(readFileSync(path)) !== expected)
      throw new Error(`Frozen runtime changed: ${path}`);
  }
  const config = {
    task,
    model: occurrence.model,
    arm: occurrence.arm,
    output,
    ledger,
    initialNanodollars: protocol.initialNanodollars,
  };
  const configPath = resolve(output, "config.json");
  json(configPath, config);
  const guard = await runWithWatchdog({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "training/experiments/validation-planner/child.ts",
      configPath,
    ],
    cwd: process.cwd(),
    env: {
      ...process.env,
      FLOWBLOCK_INFERENCE_URL: protocol.endpoint,
      WEAVE_DISABLED: "true",
    },
    timeoutMs: 35_000,
    killGraceMs: 250,
  });
  json(resolve(output, "watchdog.json"), guard);
  // A killed child cannot release its lock. Only clear a lock whose owner no longer exists.
  if (existsSync(`${ledger}.lock`)) {
    const owner = JSON.parse(readFileSync(`${ledger}.lock`, "utf8"));
    if (owner.pid !== guard.pid)
      throw new Error(
        "Budget lock belongs to a different process; stopping without unlocking.",
      );
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      else throw error;
    }
    if (alive)
      throw new Error(
        "Budget lock owner remains live; stopping without unlocking.",
      );
    unlinkSync(`${ledger}.lock`);
  }
  const resultPath = resolve(output, "result.json");
  const result = existsSync(resultPath)
    ? JSON.parse(readFileSync(resultPath, "utf8"))
    : null;
  const available =
    !!result?.available && guard.status === "completed" && guard.exitCode === 0;
  const row = {
    ...occurrence,
    sceneGroup: task.sceneGroup,
    available,
    attempted:
      result?.attempted ??
      existsSync(resolve(output, "calls", "0-request.json")),
    result,
    watchdogStatus: guard.status,
    monotonicElapsedMs: guard.monotonicElapsedMs,
    wallElapsedMs: guard.wallElapsedMs,
  };
  rows.push(row);
  json(resolve(output, "entry.json"), row);
  console.log(
    JSON.stringify({
      occurrence: occurrence.id,
      available,
      productive: result?.grade?.productive ?? null,
      termination: result?.result?.termination ?? guard.status,
      elapsedMs: guard.monotonicElapsedMs,
    }),
  );
  pairAvailability.push(available);
  if (result?.budgetStopped) stopReason = "new-inference-allocation-exhausted";
  if (pairAvailability.length === 2) {
    consecutiveUnavailablePairs = pairAvailability.every((v) => !v)
      ? consecutiveUnavailablePairs + 1
      : 0;
    pairAvailability = [];
    if (consecutiveUnavailablePairs >= 2)
      stopReason = "two-consecutive-pairs-unavailable";
  }
}
json(resolve(root, "entries.json"), rows);
json(resolve(root, "completion.json"), {
  completedAt: new Date().toISOString(),
  stopReason,
  scheduled: rows.length,
  available: rows.filter((r) => r.available).length,
});
