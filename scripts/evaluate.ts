import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PlannerMessage, PlanningResult } from "../src/server/planner";
import type { Fixture } from "../training/fixtures";
import { loadEvaluationRuntime } from "../training/runtime";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const selectedRuntime = await loadEvaluationRuntime(
  option("--runtime", "product"),
);
const { chat, plannerVersion, runPlanner, systemPrompt } =
  selectedRuntime.runtime;
const { planShots } = selectedRuntime.domain;
const { checkerVersion, gradeResult } = selectedRuntime.checker;
const { digest } = selectedRuntime.fixtures;
const arm = option("--arm", "library");
if (!["library", "baseline", "base", "candidate"].includes(arm))
  throw new Error("Arm must be library, baseline, base, or candidate.");
const split = option("--split", "test");
if (!["dev", "test"].includes(split))
  throw new Error("Evaluation only accepts dev or test fixtures.");
const limit = Number(option("--limit", "12"));
if (!Number.isInteger(limit) || limit < 1 || limit > 72)
  throw new Error("Limit must be an integer from 1 through 72.");
const manifest = JSON.parse(
  await readFile(resolve("training/frozen/manifest.json"), "utf8"),
);
if (manifest.systemPromptSha256 !== digest(systemPrompt))
  throw new Error(
    "The runtime system prompt changed after fixture freezing. Create a new experiment version.",
  );
const fixtureBytes = await readFile(
  resolve("training/frozen/fixtures.json"),
  "utf8",
);
if (digest(fixtureBytes) !== manifest.files["fixtures.json"])
  throw new Error("Frozen fixtures failed their content hash.");
const fixtures = (JSON.parse(fixtureBytes) as Fixture[])
  .filter((f) => f.split === split)
  .slice(0, limit);
let model =
  arm === "baseline"
    ? "openai/gpt-oss-20b"
    : "meta-llama/Llama-3.1-8B-Instruct";
const inferenceUrlOverride = option("--inference-url", "");
if (arm === "candidate") {
  const receipt = JSON.parse(
    await readFile(
      resolve(option("--receipt", "training/artifacts/training-receipt.json")),
      "utf8",
    ),
  );
  if (
    receipt.status !== "trained" ||
    !receipt.inferenceModel ||
    !receipt.inferenceBaseUrl ||
    !(receipt.trainedStep > 0)
  )
    throw new Error(
      "A successfully trained checkpoint receipt is required; step zero is not a trained candidate.",
    );
  model = receipt.inferenceModel;
  process.env.FLOWBLOCK_INFERENCE_URL = receipt.inferenceBaseUrl;
}
if (inferenceUrlOverride)
  process.env.FLOWBLOCK_INFERENCE_URL = new URL(inferenceUrlOverride)
    .toString()
    .replace(/\/$/, "");
if (
  arm !== "library" &&
  (!process.env.WANDB_API_KEY || !process.env.WANDB_ENTITY)
)
  throw new Error("Model evaluation needs WANDB_API_KEY and WANDB_ENTITY.");
const attempt = `${new Date().toISOString().replace(/[:.]/g, "-")}-${arm}-${randomUUID().slice(0, 8)}`;
const directory = resolve("training/artifacts", attempt);
await mkdir(directory, { recursive: true });
const { sourceHashes } = selectedRuntime;
const attemptManifest = {
  attempt,
  arm,
  condition: option("--condition", "qualification"),
  model: arm === "library" ? null : model,
  inferenceBaseUrl:
    arm === "library"
      ? null
      : process.env.FLOWBLOCK_INFERENCE_URL ||
        "https://api.inference.wandb.ai/v1",
  split,
  fixtureVersion: manifest.fixtureVersion,
  fixtureSha256: manifest.files["fixtures.json"],
  plannerVersion,
  runtime: {
    selection: selectedRuntime.selection,
    sourcePath: selectedRuntime.sourcePath,
    sourceSha256: selectedRuntime.sourceSha256,
    sourceManifestSha256: selectedRuntime.sourceManifestSha256,
  },
  checkerVersion,
  sourceHashes,
  systemPromptSha256: digest(systemPrompt),
  settings: {
    temperature: 0.1,
    maxTokens: 1600,
    maximumActions: 6,
    deadlineMs: 30000,
    trials: 1,
  },
  fixtureIds: fixtures.map((f) => f.id),
  scope:
    limit < 72 ? "qualification, not a full campaign" : "frozen test campaign",
  startedAt: new Date().toISOString(),
};
await writeFile(
  resolve(directory, "manifest.json"),
  `${JSON.stringify(attemptManifest, null, 2)}\n`,
);
const results: {
  fixtureId: string;
  arm: string;
  available: boolean;
  status: string;
  grade: ReturnType<typeof gradeResult> | null;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number } | null;
  serviceErrors: string[];
  traceId?: string;
}[] = [];
for (const fixture of fixtures) {
  const calls: {
    messages: PlannerMessage[];
    response?: unknown;
    error?: string;
  }[] = [];
  const serviceErrors: string[] = [];
  const started = Date.now();
  const result: PlanningResult =
    arm === "library"
      ? {
          plans: planShots(
            fixture.input.scene,
            fixture.input.gear,
            fixture.input.intent,
          ).slice(0, 3),
          source: "library",
          message: "Deterministic recipe ranking",
          events: [],
          usage: { inputTokens: 0, outputTokens: 0 },
          inputHash: digest(fixture.input),
          plannerVersion,
          latencyMs: 0,
        }
      : await runPlanner(fixture.input, {
          model,
          chat: async (messages, modelName, signal) => {
            const call = {
              messages: structuredClone(messages),
            } as (typeof calls)[number];
            calls.push(call);
            try {
              const response = await chat(messages, modelName, signal);
              call.response = response;
              return response;
            } catch (error) {
              const message =
                error instanceof Error
                  ? error.message
                  : "Unknown inference failure";
              call.error = message;
              serviceErrors.push(message);
              throw error;
            }
          },
        });
  const available = serviceErrors.length === 0;
  const rawResponses = calls.flatMap((call) =>
    call.response ? [(call.response as { content: string }).content] : [],
  );
  const entry = {
    fixtureId: fixture.id,
    arm,
    available,
    status: !available
      ? "service-unavailable"
      : result.source === "library" && arm !== "library"
        ? "actor-failure"
        : "completed",
    grade: available ? gradeResult(fixture, result, arm, rawResponses) : null,
    latencyMs: Date.now() - started,
    usage: arm === "library" ? null : result.usage,
    serviceErrors,
    traceId: result.traceId,
  };
  results.push(entry);
  await appendFile(
    resolve(directory, "results.jsonl"),
    `${JSON.stringify(entry)}\n`,
  );
  await writeFile(
    resolve(directory, `${fixture.id}.json`),
    `${JSON.stringify({ fixtureId: fixture.id, calls, result, entry }, null, 2)}\n`,
  );
  process.stdout.write(
    `${fixture.id}: ${entry.status}, success=${entry.grade?.success ?? "unavailable"}\n`,
  );
  // Stop a clearly unavailable arm after two consecutive infrastructure failures.
  // Unattempted tasks remain missing and never become implicit failures or wins.
  if (results.length >= 2 && results.slice(-2).every((r) => !r.available))
    break;
}
const available = results.filter((r) => r.available);
const successCount = available.filter((r) => r.grade?.success).length;
const latencies = available.map((r) => r.latencyMs).sort((a, b) => a - b);
const summary = {
  attempt,
  arm,
  model: arm === "library" ? null : model,
  requestedTasks: fixtures.length,
  attemptedTasks: results.length,
  availableTasks: available.length,
  unavailableTasks: results.filter((r) => !r.available).length,
  unattemptedTasks: fixtures.length - results.length,
  successCount,
  successRateAmongAvailable: available.length
    ? successCount / available.length
    : null,
  successRateAmongRequestedLowerBound: successCount / fixtures.length,
  medianLatencyMs: latencies.length
    ? latencies[Math.floor(latencies.length / 2)]
    : null,
  inputTokens:
    arm === "library"
      ? null
      : results.reduce((s, r) => s + (r.usage?.inputTokens ?? 0), 0),
  outputTokens:
    arm === "library"
      ? null
      : results.reduce((s, r) => s + (r.usage?.outputTokens ?? 0), 0),
  dollarCost: null,
  costDisclosure:
    "Provider token counts are preserved when reported. No invoice-derived dollar cost was available.",
  limitation:
    "One trial per synthetic task. The fixed oracle search is not a proof of global infeasibility. Qualification results do not establish general performance.",
};
await writeFile(
  resolve(directory, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify({ directory, ...summary }, null, 2)}\n`);
