import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pairedClusterBootstrap, type Cluster } from "../next/analyze";
import type { gradeTask } from "../next/run";
import type { ResearchPlanningResult } from "../next/planner";
import type { buildValidationSuite } from "./fixtures";

type Row = {
  id: string;
  taskId: string;
  arm: "llama-base" | "llama-sft";
  trial: number;
  sceneGroup: string;
  available: boolean;
  attempted: boolean;
  monotonicElapsedMs?: number;
  result?: {
    grade: ReturnType<typeof gradeTask> | null;
    result: ResearchPlanningResult;
    independentChecks: { valid: boolean; failedChecks?: string[] }[];
  } | null;
};
const [directory] = process.argv.slice(2);
if (!directory) throw new Error("Pass the completed experiment directory.");
const root = resolve(directory);
const rows = JSON.parse(
  readFileSync(resolve(root, "entries.json"), "utf8"),
) as Row[];
const suite = JSON.parse(
  readFileSync(resolve(root, "suite.json"), "utf8"),
) as ReturnType<typeof buildValidationSuite>;
const protocol = JSON.parse(
  readFileSync(resolve(root, "protocol.json"), "utf8"),
);
if (
  rows.length !== protocol.schedule.length ||
  new Set(rows.map((r) => r.id)).size !== rows.length
)
  throw new Error("Incomplete or duplicate occurrence identities.");
const condition = (r: Row) => suite.conditions[r.taskId];
const positive = (r: Row) => condition(r) !== "unsupported";
const pass = (r: Row): boolean => r.available && !!r.result?.grade?.productive;
const stop = (r: Row): boolean =>
  r.available && !!r.result?.grade?.unsupportedAbstention;
function counts(selected: Row[]) {
  const available = selected.filter((r) => r.available);
  const times = selected
    .flatMap((r) =>
      r.monotonicElapsedMs === undefined ? [] : [r.monotonicElapsedMs],
    )
    .sort((a, b) => a - b);
  return {
    scheduled: selected.length,
    attempted: selected.filter((r) => r.attempted).length,
    available: available.length,
    productive: selected.filter(pass).length,
    checkedUnsupportedAbstentions: selected.filter(stop).length,
    returnedAnyPlan: available.filter((r) => r.result!.result.plans.length > 0)
      .length,
    returnedInvalidPlans: available.reduce(
      (n, r) =>
        n +
        r.result!.grade!.planGrades.filter((g) => !g.checks.feasible).length,
      0,
    ),
    independentDisagreements: available.reduce(
      (n, r) => n + r.result!.independentChecks.filter((g) => !g.valid).length,
      0,
    ),
    falseAbstentions: available.filter((r) => r.result!.grade!.falseAbstention)
      .length,
    protocolFailures: available.filter(
      (r) => r.result!.result.termination !== "finished",
    ).length,
    latencySeconds: {
      count: times.length,
      median: times.length
        ? times[Math.floor(times.length * 0.5)] / 1000
        : null,
      p95: times.length
        ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] /
          1000
        : null,
      max: times.length ? times.at(-1)! / 1000 : null,
    },
  };
}
const byArm = Object.fromEntries(
  (["llama-base", "llama-sft"] as const).map((arm) => {
    const a = rows.filter((r) => r.arm === arm);
    const wording = suite.tasks
      .filter((t) => suite.conditions[t.id] === "original")
      .flatMap((t) =>
        [0, 1].map((trial) => {
          const original = a.find(
            (r) => r.taskId === t.id && r.trial === trial,
          )!;
          const para = a.find(
            (r) =>
              r.sceneGroup === t.sceneGroup &&
              condition(r) === "paraphrase" &&
              r.trial === trial,
          )!;
          return {
            available: original.available && para.available,
            agree: pass(original) === pass(para),
            bothProductive: pass(original) && pass(para),
          };
        }),
      );
    const repeats = suite.tasks.map((t) => {
      const pair = a.filter((r) => r.taskId === t.id);
      const metric = suite.conditions[t.id] === "unsupported" ? stop : pass;
      return {
        available: pair.every((r) => r.available),
        agree: metric(pair[0]) === metric(pair[1]),
        bothPass: pair.every(metric),
      };
    });
    return [
      arm,
      {
        all: counts(a),
        positive: counts(a.filter(positive)),
        unsupported: counts(a.filter((r) => !positive(r))),
        conditions: Object.fromEntries(
          [
            "original",
            "paraphrase",
            "geometry-perturbation",
            "unsupported",
          ].map((c) => [c, counts(a.filter((r) => condition(r) === c))]),
        ),
        wording: {
          pairs: wording.length,
          available: wording.filter((r) => r.available).length,
          agreement: wording.filter((r) => r.available && r.agree).length,
          bothProductive: wording.filter((r) => r.available && r.bothProductive)
            .length,
        },
        repeats: {
          pairs: repeats.length,
          available: repeats.filter((r) => r.available).length,
          agreement: repeats.filter((r) => r.available && r.agree).length,
          bothPass: repeats.filter((r) => r.available && r.bothPass).length,
        },
      },
    ];
  }),
);
function paired(operational: boolean, unsupported = false) {
  const clusters = new Map<string, Cluster>();
  let pairs = 0,
    available = 0,
    gains = 0,
    losses = 0,
    bothPass = 0,
    bothFail = 0;
  for (const base of rows.filter(
    (r) => r.arm === "llama-base" && (unsupported ? !positive(r) : positive(r)),
  )) {
    const trained = rows.find(
      (r) =>
        r.arm === "llama-sft" &&
        r.taskId === base.taskId &&
        r.trial === base.trial,
    )!;
    pairs++;
    const eligible = base.available && trained.available;
    const metric = unsupported ? stop : pass;
    if (eligible) {
      available++;
      if (metric(trained) && !metric(base)) gains++;
      else if (metric(base) && !metric(trained)) losses++;
      else if (metric(base)) bothPass++;
      else bothFail++;
    }
    const group = clusters.get(base.sceneGroup) ?? {
      sceneGroup: base.sceneGroup,
      pairs: [],
    };
    group.pairs.push({
      base: operational || base.available ? Number(metric(base)) : null,
      trained:
        operational || trained.available ? Number(metric(trained)) : null,
    });
    clusters.set(base.sceneGroup, group);
  }
  return {
    pairs,
    available,
    gains,
    losses,
    bothPass,
    bothFail,
    estimate: pairedClusterBootstrap([...clusters.values()], 2026103002, 10000),
  };
}
const budget = JSON.parse(readFileSync(resolve(root, "budget.json"), "utf8"));
const before = JSON.parse(
  readFileSync(resolve(root, "budget-before.json"), "utf8"),
);
const fresh = budget.calls.slice(before.calls.length) as {
  chargedNanodollars?: number;
  reservedNanodollars: number;
}[];
const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  experimentId: protocol.experimentId,
  byArm,
  positivePairedAvailable: paired(false),
  positiveOperational: paired(true),
  unsupportedPairedAvailable: paired(false, true),
  cost: {
    newCalls: fresh.length,
    withEstimatedCharge: fresh.filter((c) => c.chargedNanodollars !== undefined)
      .length,
    estimatedUsd:
      fresh.reduce((n, c) => n + (c.chargedNanodollars ?? 0), 0) / 1e9,
    unknownReservedUsd:
      fresh
        .filter((c) => c.chargedNanodollars === undefined)
        .reduce((n, c) => n + c.reservedNanodollars, 0) / 1e9,
    billedUsd: null,
    newTrainingJobs: 0,
  },
  scope: protocol.scope,
  limitations: protocol.limitations,
};
writeFileSync(
  resolve(root, "analysis.json"),
  JSON.stringify(report, null, 2) + "\n",
  { flag: "wx" },
);
const table = Object.entries(byArm).flatMap(([arm, data]) =>
  Object.entries(data.conditions).map(
    ([c, x]) =>
      `| ${arm} | ${c} | ${x.scheduled} | ${x.available} | ${c === "unsupported" ? x.checkedUnsupportedAbstentions : x.productive} |`,
  ),
);
writeFileSync(
  resolve(root, "report.md"),
  [
    "# Controlled planner validation",
    "",
    protocol.scope,
    "",
    "Positive tasks require a returned plan preserving the brief. Unsupported tasks report checked abstentions separately; their explanation correctness is not graded.",
    "",
    "| Arm | Condition | Scheduled | Available | Productive plans / checked unsupported stops |",
    "| --- | --- | ---: | ---: | ---: |",
    ...table,
    "",
    "## Paired positive-task result",
    "",
    JSON.stringify(report.positivePairedAvailable, null, 2),
    "",
    "The paired interval conditions on available results. It does not repair missingness or establish filming benefit. Repetitions and conditions stay clustered within scene group.",
    "",
    "## Budget",
    "",
    JSON.stringify(report.cost, null, 2),
    "",
    "## Limits",
    "",
    ...protocol.limitations.map((v: string) => `- ${v}`),
    "",
  ].join("\n"),
  { flag: "wx" },
);
console.log(JSON.stringify(report));
