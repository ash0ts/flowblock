import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { buildValidationSuite } from "./fixtures";
import { runtimeSourcePaths } from "../next/run";
import { systemPrompt } from "../next/planner";

const hash = (b: string | Buffer) =>
  createHash("sha256").update(b).digest("hex");
const [directory] = process.argv.slice(2);
if (!directory || existsSync(directory))
  throw new Error("Supply a new experiment directory.");
const root = resolve(directory);
const suite = buildValidationSuite();
const write = (name: string, value: unknown) =>
  writeFileSync(resolve(root, name), JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
  });
if (suite.tasks.length !== 48) throw new Error("Expected 48 frozen tasks.");
const previousLedgerPath = "training/artifacts/v2-budget.json";
if (existsSync(`${previousLedgerPath}.lock`))
  throw new Error("Prior budget ledger is active.");
const previousLedgerBytes = readFileSync(previousLedgerPath);
const ledger = JSON.parse(previousLedgerBytes.toString());
const initialNanodollars = ledger.calls.reduce(
  (
    sum: number,
    c: { chargedNanodollars?: number; reservedNanodollars: number },
  ) => sum + (c.chargedNanodollars ?? c.reservedNanodollars),
  0,
);
if (initialNanodollars + 2_000_000_000 > 20_000_000_000 || ledger.stopped)
  throw new Error("Insufficient existing inference allocation.");
const paths = [
  ...new Set([
    ...runtimeSourcePaths,
    ...readdirSync("src/domain")
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/domain/${f}`),
    ...readdirSync("training/experiments/validation-planner")
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `training/experiments/validation-planner/${f}`),
    "training/experiments/next/analyze.ts",
  ]),
].sort();
const sources = paths.map((path) => ({
  path,
  sha256: hash(readFileSync(path)),
  source: readFileSync(path, "utf8"),
}));
let state = 2026103001 >>> 0;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const pairs = suite.tasks.flatMap((task) =>
  [0, 1].map((trial) => ({ taskId: task.id, trial })),
);
for (let i = pairs.length - 1; i > 0; i--) {
  const j = Math.floor(random() * (i + 1));
  [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
}
const models = {
  "llama-base": "meta-llama/Llama-3.1-8B-Instruct",
  "llama-sft": "wandb-artifact:///wandb/flowblock/flowblock-v2-20261029-sft:v1",
};
const schedule = pairs.flatMap((pair, i) => {
  const arms: (keyof typeof models)[] =
    i % 2 === 0 ? ["llama-base", "llama-sft"] : ["llama-sft", "llama-base"];
  return arms.map((arm) => ({
    id: `${pair.taskId}-trial${pair.trial}-${arm}`,
    ...pair,
    arm,
    model: models[arm],
  }));
});
mkdirSync(root, { recursive: true });
write("suite.json", suite);
write("runtime.json", sources);
writeFileSync(resolve(root, "budget.json"), previousLedgerBytes, {
  flag: "wx",
});
write("budget-before.json", ledger);
write("protocol.json", {
  schemaVersion: 1,
  experimentId: "flowblock-controlled-validation-v1",
  frozenAt: new Date().toISOString(),
  question:
    "Does the existing trained planner preserve a supported brief across new synthetic topology instances, wording changes and geometry perturbations, compared with its matched base?",
  intendedDecision:
    "Identify remaining failure mechanisms and whether a larger field-oriented confirmation is justified; no automatic promotion.",
  scope:
    "Controlled synthetic stress evaluation; solver-selected positive tasks; not natural task prevalence or creator benefit.",
  suiteSha256: hash(readFileSync(resolve(root, "suite.json"))),
  sourceHashes: Object.fromEntries(sources.map((s) => [s.path, s.sha256])),
  promptSha256: hash(systemPrompt),
  endpoint: "https://forge.coreweave.com/api/training/v1",
  models,
  checkpointEvidence: {
    path: "training/artifacts/next-training/flowblock-v2-20261029/native-models-independent-reconciliation.json",
    sha256: hash(
      readFileSync(
        "training/artifacts/next-training/flowblock-v2-20261029/native-models-independent-reconciliation.json",
      ),
    ),
    artifactVersion: "v1",
    artifactDigest: "1bea2d2f93b6cc19eab7ffed97ea98bb",
  },
  settings: {
    actions: 6,
    repairs: 2,
    coordinatorDeadlineMs: 30000,
    externalWatchdogMs: 35000,
    temperature: 0.1,
    maxTokens: 1600,
    repetitions: 2,
    concurrency: 1,
    tracing: false,
  },
  initialNanodollars,
  budget: {
    existingAuthorizedTotalUsd: 200,
    newInferenceMaximumUsd: 2,
    existingCumulativeInferenceMaximumUsd: 20,
    existingTrainingReservationUsd: 170,
    newTrainingJobs: 0,
    invoiceKnown: false,
    ledgerPredecessor: previousLedgerPath,
    ledgerPredecessorSha256: hash(previousLedgerBytes),
    priceSource: "https://www.coreweave.com/forge-pricing/inference-agents",
    pricingCheckedOn: "2026-10-29",
    llamaInputOutputUsdPerMillion: [0.22, 0.22],
  },
  scheduleSeed: 2026103001,
  schedule,
  stopRule:
    "No paid-request retries. Complete the second arm of each pair unless budget stops. Stop after two consecutive pairs with neither outcome available; preserve every remaining scheduled occurrence as unattempted. Never retry this frozen execution under a new directory.",
  analysis: {
    primary:
      "Paired difference in brief-preserving plan rate on known-positive tasks, per occurrence, with whole-scene-group bootstrap retaining conditions and repeats.",
    secondary: [
      "Correct checked abstention on explicit unsupported tasks, kept separate from productive plans",
      "Wording consistency within scene and trial",
      "Geometry perturbation sensitivity",
      "Repeat consistency",
      "Availability and operational delivered-plan rate",
      "Invalid returned plans, schema errors, repairs",
      "Parent monotonic and wall elapsed time; child event-loop delay; complete and unknown token usage",
    ],
    missingness:
      "Unavailable outcomes have no quality grade. Scheduled operational delivery and paired-available quality are separate. Intervals do not correct missingness.",
    bootstrapSeed: 2026103002,
    bootstrapIterations: 10000,
  },
  privacy:
    "Authored geometry and model actions only; no creator footage or credentials. Publication uses scored metadata to the existing private Forge project.",
  limitations: [
    "Two repetitions do not establish generation stability.",
    "Twelve authored groups are not a population of real rooms.",
    "Geometry/checker share the product engine; independent physical validity is unproven.",
    "Parent watchdog cannot defeat host suspension and does not cancel provider computation.",
    "Model artifact lineage is verified from recorded service metadata, not weight-byte access.",
    "This test does not isolate which training example category caused a difference.",
  ],
  reproduce: `node --env-file=.env.local --import tsx training/experiments/validation-planner/run.ts ${directory}`,
});
console.log(
  JSON.stringify({
    directory: root,
    tasks: suite.tasks.length,
    scheduled: schedule.length,
    suiteSha256: hash(readFileSync(resolve(root, "suite.json"))),
    protocolSha256: hash(readFileSync(resolve(root, "protocol.json"))),
    initialEstimatedAndReservedUsd: initialNanodollars / 1e9,
  }),
);
