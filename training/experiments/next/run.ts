import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  chat,
  PlanningInputSchema,
  plannerVersion,
  runPlanner,
  telemetry,
  systemPrompt as productPrompt,
  type ChatResult,
  type PlannerMessage,
  type PlanningResult,
} from "../../../src/server/planner";
import {
  checkerVersion,
  gradePlan,
  provenUnsupported,
  type Task,
} from "./grade";
import { search, searchVersion } from "./search";
import {
  researchPlannerVersion,
  runResearchPlanner,
  systemPrompt as researchPrompt,
  type ResearchPlanningResult,
} from "./planner";
import { AgentActionSchema, ValidationReportSchema } from "../../../src/domain";
import { BudgetStop, openBudgetLedger } from "./budget";
import {
  validateConfirmationSelection,
  claimConfirmationAttempt,
} from "./confirmation";
import {
  installExperimentTransport,
  transportSettings,
  transportVersion,
} from "./transport";
import {
  beforeDeadline,
  createDeadline,
} from "../../../src/server/coordinator-runtime";

export async function prewarmTelemetry(
  operation: () => Promise<unknown> = telemetry,
  timeoutMs = 60_000,
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("Telemetry prewarm must be bounded to at most 60 seconds.");
  const started = Date.now();
  const deadline = createDeadline(timeoutMs, started);
  let initialized = false;
  let status: "initialized" | "unavailable" | "deadline" | "failed";
  try {
    initialized = !!(await beforeDeadline(operation, deadline.signal));
    status = initialized ? "initialized" : "unavailable";
  } catch {
    status = deadline.signal.aborted ? "deadline" : "failed";
  } finally {
    deadline.close();
  }
  return {
    initialized,
    status,
    latencyMs: Date.now() - started,
    timeoutMs,
    disclosure:
      "Optional tracing initialization before task timing; no inference request. A deadline does not cancel SDK initialization, which may complete later. Within-task tracing remains optional and bounded independently.",
  };
}

export type Arm = "library" | "gpt-oss" | "llama-base" | "llama-sft";
export const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
export const runtimeSourcePaths = [
  "training/experiments/next/run.ts",
  "training/experiments/next/confirmation.ts",
  "training/experiments/next/budget.ts",
  "training/experiments/next/transport.ts",
  "package.json",
  "bun.lock",
  "training/experiments/next/planner.ts",
  "training/experiments/next/search.ts",
  "training/experiments/next/grade.ts",
  "training/experiments/next/fixtures.ts",
  "src/domain/engine.ts",
  "src/domain/contracts.ts",
  "src/domain/geometry.ts",
  "src/domain/defaults.ts",
  "src/server/planner.ts",
  "src/server/coordinator-runtime.ts",
];
export async function runtimeHashes() {
  return Object.fromEntries(
    await Promise.all(
      runtimeSourcePaths.map(async (path) => [
        path,
        hash(await readFile(path)),
      ]),
    ),
  );
}
export type CallRecord = {
  index: number;
  model: string;
  messages: PlannerMessage[];
  startedAt: string;
  status:
    | "reserved"
    | "completed"
    | "failed"
    | "outcome-unknown"
    | "not-issued";
  reservationId?: string;
  response?: ChatResult;
  error?: { name: string; message: string };
  latencyMs?: number;
};
export type Entry = {
  taskId: string;
  sceneGroup: string;
  arm: Arm;
  attempted: boolean;
  available: boolean;
  status:
    | "completed"
    | "actor-failure"
    | "service-unavailable"
    | "operational-failure"
    | "budget-exhausted"
    | "unattempted";
  termination: string;
  grade: ReturnType<typeof gradeTask> | null;
  latencyMs: number | null;
  usage: ChatResult["usage"] | null;
  usageComplete: boolean;
  traceId?: string;
};
export function classifyTaskOutcome(input: {
  attempted: boolean;
  providerFailed: boolean;
  budgetStopped: boolean;
  coordinatorDeadline: boolean;
  termination: string;
}): Pick<Entry, "available" | "status" | "termination"> {
  if (input.budgetStopped)
    return {
      available: false,
      status: "budget-exhausted",
      termination: input.termination,
    };
  if (input.providerFailed)
    return {
      available: false,
      status: "service-unavailable",
      termination: "provider-error",
    };
  if (input.coordinatorDeadline)
    return {
      available: false,
      status: input.attempted ? "operational-failure" : "unattempted",
      termination: input.attempted
        ? "deadline"
        : "coordinator-deadline-before-provider",
    };
  if (!input.attempted)
    return {
      available: false,
      status: "unattempted",
      termination: "coordinator-no-provider-call",
    };
  return {
    available: true,
    status: input.termination === "finished" ? "completed" : "actor-failure",
    termination: input.termination,
  };
}
export function isInfrastructureFailure(entry: Entry) {
  return (
    entry.status === "service-unavailable" ||
    entry.termination === "coordinator-no-provider-call"
  );
}
export function gradeTask(task: Task, result: PlanningResult, arm: Arm) {
  const witness = search(task.input, {
    family: task.briefSpec.family,
    maxCandidates: 128,
  });
  const knownFeasible = witness.plans.some(
    (plan) => gradePlan(task, plan).productive,
  );
  const credited = arm === "library" || result.source === "forge";
  const plans = credited ? result.plans : [];
  const planGrades = plans.map((plan) => ({
    planId: plan.id,
    ...gradePlan(task, plan),
  }));
  const finishIndex = result.events.findIndex((event) => {
    const action = AgentActionSchema.safeParse(event.action);
    const observation = event.observation as {
      accepted?: unknown;
      error?: unknown;
    } | null;
    return (
      action.success &&
      action.data.action === "finish" &&
      action.data.candidateIds.length === 0 &&
      !observation?.error &&
      Array.isArray(observation?.accepted) &&
      observation.accepted.length === 0
    );
  });
  const emptyFinish = credited && plans.length === 0 && finishIndex >= 0;
  const compileChecked =
    credited &&
    result.events
      .slice(0, emptyFinish ? finishIndex : undefined)
      .some((event) => {
        const action = AgentActionSchema.safeParse(event.action);
        const observation = event.observation as {
          candidateId?: unknown;
          recipeId?: unknown;
          validation?: unknown;
          error?: unknown;
        } | null;
        return (
          action.success &&
          action.data.action === "compile_candidate" &&
          !observation?.error &&
          typeof observation?.candidateId === "string" &&
          observation.recipeId === action.data.recipeId &&
          ValidationReportSchema.safeParse(observation.validation).success
        );
      });
  const unsupported = provenUnsupported(task);
  return {
    productive: planGrades.some((grade) => grade.productive),
    planGrades,
    supportedRequest: unsupported === null,
    unsupportedReason: unsupported,
    knownFeasible,
    falseAbstention: emptyFinish && knownFeasible,
    boundedEmpty:
      emptyFinish && compileChecked && !knownFeasible && !unsupported,
    unsupportedAbstention: emptyFinish && compileChecked && !!unsupported,
    emptyFinish,
    compileChecked,
    uncheckedEmpty: emptyFinish && !compileChecked,
    searchVersion,
    sampledCandidates: witness.sampledCandidates,
    searchBudgetReached: witness.budgetReached,
  };
}
export function summarize(entries: Entry[]) {
  const attempted = entries.filter((entry) => entry.attempted);
  const available = entries.filter((entry) => entry.available);
  const productive = available.filter(
    (entry) => entry.grade?.productive,
  ).length;
  return {
    requested: entries.length,
    attempted: attempted.length,
    available: available.length,
    serviceUnavailable: entries.filter(isInfrastructureFailure).length,
    transportWarmupUnattempted: entries.filter(
      (entry) => entry.termination === "transport-warmup-failure",
    ).length,
    operationalFailures: entries.filter(
      (entry) =>
        entry.status === "operational-failure" ||
        entry.termination === "coordinator-deadline-before-provider",
    ).length,
    budgetExhausted: entries.filter(
      (entry) => entry.status === "budget-exhausted",
    ).length,
    unattempted: entries.filter((entry) => entry.status === "unattempted")
      .length,
    productive,
    productiveAmongRequested: entries.length
      ? productive / entries.length
      : null,
    productiveAmongAvailable: available.length
      ? productive / available.length
      : null,
    falseAbstentions: available.filter((entry) => entry.grade?.falseAbstention)
      .length,
    unsupportedAbstentions: available.filter(
      (entry) => entry.grade?.unsupportedAbstention,
    ).length,
    boundedEmpty: available.filter((entry) => entry.grade?.boundedEmpty).length,
    uncheckedEmpty: available.filter((entry) => entry.grade?.uncheckedEmpty)
      .length,
    completeUsageTasks: attempted.filter((entry) => entry.usageComplete).length,
    reportedInputTokens: attempted.reduce(
      (sum, entry) => sum + (entry.usage?.inputTokens ?? 0),
      0,
    ),
    reportedOutputTokens: attempted.reduce(
      (sum, entry) => sum + (entry.usage?.outputTokens ?? 0),
      0,
    ),
    costDisclosure:
      "Token sums include complete reported usage only. Unknown usage and reservations are retained separately in the budget ledger. Billed dollars are unknown.",
  };
}
function unattempted(task: Task, arm: Arm, reason: string): Entry {
  return {
    taskId: task.id,
    sceneGroup: task.sceneGroup,
    arm,
    attempted: false,
    available: false,
    status: "unattempted",
    termination: reason,
    grade: null,
    latencyMs: null,
    usage: null,
    usageComplete: false,
  };
}
export async function executeWaves<T>(
  tasks: Task[],
  execute: (task: Task) => Promise<T>,
  isInfrastructureFailure: (result: T) => boolean,
  shouldStop: (result: T) => boolean = () => false,
  concurrency = 2,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
    throw new Error("Campaign concurrency must be one or two.");
  const results: T[] = [];
  let consecutive = 0;
  let stopped = false;
  for (let start = 0; start < tasks.length && !stopped; start += concurrency) {
    const settled = await Promise.allSettled(
      tasks.slice(start, start + concurrency).map(execute),
    );
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    const wave = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    for (const result of wave) {
      results.push(result);
      consecutive = isInfrastructureFailure(result) ? consecutive + 1 : 0;
      if (consecutive >= 2 || shouldStop(result)) stopped = true;
    }
  }
  return { results, unattempted: tasks.slice(results.length), stopped };
}
function parseTasks(value: unknown): Task[] {
  if (!Array.isArray(value))
    throw new Error("The task file must contain a JSON array.");
  const seen = new Set<string>();
  return value.map((raw: Task) => {
    if (
      !raw ||
      typeof raw.id !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(raw.id) ||
      seen.has(raw.id)
    )
      throw new Error("Task IDs must be unique filesystem-safe strings.");
    seen.add(raw.id);
    if (
      !raw.briefSpec ||
      !["hold", "push-in", "pull-out", "lateral", "orbit", "reveal"].includes(
        raw.briefSpec.family,
      ) ||
      !["left", "right", "either"].includes(raw.briefSpec.direction) ||
      ![raw.briefSpec.minimumTravel, raw.briefSpec.minimumOrbitDegrees].every(
        (n) => Number.isFinite(n) && n >= 0,
      ) ||
      typeof raw.briefSpec.requiresForegroundOcclusion !== "boolean" ||
      typeof raw.sceneGroup !== "string"
    )
      throw new Error(`Invalid brief contract for ${raw.id}`);
    PlanningInputSchema.parse(raw.input);
    return raw;
  });
}
async function json(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}
type Config = {
  split: "development" | "confirmation";
  arm: Arm;
  tasks: string;
  output: string;
  model?: string;
  limit?: number;
  selection?: string;
  selectionSha256?: string;
  tasksSha256?: string;
  protocol: string;
  datasetManifest?: string;
  budgetLedger?: string;
  transportWarmup?: boolean;
};
export async function runCampaign(config: Config) {
  const taskBytes = await readFile(config.tasks, "utf8");
  const tasksSha256 = hash(taskBytes);
  const sourceHashes = await runtimeHashes();
  const allTasks = parseTasks(JSON.parse(taskBytes));
  const matching = allTasks.filter((task) => task.split === config.split);
  const limit = config.limit ?? matching.length;
  if (!Number.isInteger(limit) || limit < 1 || limit > matching.length)
    throw new Error("Task limit must select at least one existing task.");
  const tasks = matching.slice(0, limit);
  const model =
    config.arm === "library"
      ? null
      : config.arm === "gpt-oss"
        ? "openai/gpt-oss-20b"
        : config.arm === "llama-base"
          ? "meta-llama/Llama-3.1-8B-Instruct"
          : config.model;
  if (config.arm === "llama-sft" && !model)
    throw new Error("The SFT arm requires an exact checkpoint --model.");
  if (config.model && config.arm !== "llama-sft")
    throw new Error("--model is reserved for the exact SFT checkpoint arm.");
  let selectionProof: unknown = null;
  if (config.split === "confirmation") {
    if (!config.selection || !config.selectionSha256 || !config.tasksSha256)
      throw new Error(
        "Confirmation requires --selection, --selection-sha256, and --tasks-sha256.",
      );
    const bytes = await readFile(config.selection, "utf8");
    if (
      hash(bytes) !== config.selectionSha256 ||
      tasksSha256 !== config.tasksSha256
    )
      throw new Error(
        "Confirmation task or selection receipt hash differs from its frozen value.",
      );
    const receipt = JSON.parse(bytes) as {
      selectedModel: string;
      selectedPromptSha256: string;
      sourceHashes: Record<string, string>;
      confirmationTasksSha256: string;
      frozenAt: string;
    };
    if (
      receipt.confirmationTasksSha256 !== tasksSha256 ||
      receipt.selectedPromptSha256 !== hash(researchPrompt) ||
      !Number.isFinite(Date.parse(receipt.frozenAt)) ||
      Date.parse(receipt.frozenAt) > Date.now()
    )
      throw new Error(
        "The selection receipt does not identify this confirmation protocol.",
      );
    for (const [path, expected] of Object.entries(sourceHashes))
      if (receipt.sourceHashes[path] !== expected)
        throw new Error(`Frozen runtime hash changed: ${path}`);
    if (config.arm === "llama-sft" && receipt.selectedModel !== model)
      throw new Error(
        "The SFT checkpoint differs from the selected candidate.",
      );
    selectionProof = { sha256: hash(bytes), receipt };
  }
  const protocolBytes = await readFile(config.protocol, "utf8");
  const protocol = JSON.parse(protocolBytes);
  if (
    config.arm !== "library" &&
    (!process.env.WANDB_API_KEY ||
      !process.env.WANDB_ENTITY ||
      !config.budgetLedger)
  )
    throw new Error("Model arms require W&B credentials and --budget-ledger.");
  if (!config.datasetManifest)
    throw new Error(
      "Campaign publication requires the canonical dataset manifest.",
    );
  const directory = resolve(config.output);
  await mkdir(dirname(directory), { recursive: true });
  await mkdir(directory);
  await writeFile(resolve(directory, "tasks.json"), taskBytes, { flag: "wx" });
  await writeFile(resolve(directory, "protocol.json"), protocolBytes, {
    flag: "wx",
  });
  let datasetManifest = null;
  if (config.datasetManifest) {
    const bytes = await readFile(config.datasetManifest, "utf8");
    await writeFile(resolve(directory, "dataset-manifest.json"), bytes, {
      flag: "wx",
    });
    datasetManifest = { path: "dataset-manifest.json", sha256: hash(bytes) };
  }
  const inferenceBaseUrl =
    config.arm === "library"
      ? null
      : config.arm === "gpt-oss"
        ? "https://api.inference.wandb.ai/v1"
        : process.env.WANDB_TRAINING_BASE_URL ||
          "https://forge.coreweave.com/api/training/v1";
  if (inferenceBaseUrl) process.env.FLOWBLOCK_INFERENCE_URL = inferenceBaseUrl;
  const promptSha256 =
    config.arm === "library"
      ? null
      : hash(config.arm === "gpt-oss" ? productPrompt : researchPrompt);
  const settings = {
    temperature: 0.1,
    maxTokens: 1600,
    maximumActions: 6,
    maximumRepairs: 2,
    deadlineMs: 30000,
    trials: 1,
    concurrency: 1,
    telemetryWarmupTimeoutMs: 60_000,
    transport:
      config.transportWarmup && config.arm !== "library"
        ? { enabled: true, version: transportVersion, ...transportSettings }
        : { enabled: false },
    ...(config.arm === "gpt-oss" ? { reasoningEffort: "low" } : {}),
  };
  const runtimeVersion =
    config.arm === "gpt-oss"
      ? plannerVersion
      : config.arm === "library"
        ? searchVersion
        : researchPlannerVersion;
  const verifiedSelection =
    config.split === "confirmation"
      ? validateConfirmationSelection(
          await readFile(config.selection!, "utf8"),
          config.selectionSha256!,
          {
            arm: config.arm,
            model: model ?? null,
            promptSha256,
            runtimeVersion,
            inferenceBaseUrl,
            settings,
            sourceHashes,
            tasksSha256,
            taskIds: tasks.map((task) => task.id),
            protocolSha256: hash(protocolBytes),
            datasetManifestSha256: datasetManifest!.sha256,
          },
        )
      : null;
  if (verifiedSelection) selectionProof = verifiedSelection;
  const attemptId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${config.arm}-${randomUUID().slice(0, 8)}`;
  const confirmationClaim = verifiedSelection
    ? await claimConfirmationAttempt({
        ledgerDirectory: resolve("training/artifacts/confirmation-claims"),
        selectionSha256: verifiedSelection.sha256,
        arm: config.arm,
        attemptId,
        outputDirectory: directory,
        taskIds: tasks.map((task) => task.id),
        protocolSha256: hash(protocolBytes),
      })
    : null;
  const manifest = {
    schemaVersion: 1,
    experimentId: "flowblock-planner-v2",
    attemptId,
    confirmationClaim: confirmationClaim
      ? {
          path: relative(directory, confirmationClaim.path),
          receipt: confirmationClaim.receipt,
        }
      : null,
    arm: config.arm,
    model,
    split: config.split,
    taskIds: tasks.map((task) => task.id),
    taskFile: "tasks.json",
    taskSourcePath: relative(directory, resolve(config.tasks)),
    tasksSha256,
    datasetManifest,
    protocol: {
      path: "protocol.json",
      sha256: hash(protocolBytes),
      value: protocol,
    },
    selectionProof,
    sourceHashes,
    promptSha256,
    runtimeVersion,
    checkerVersion,
    settings,
    inferenceBaseUrl,
    startedAt: new Date().toISOString(),
    stopPolicy:
      "Two consecutive infrastructure failures in task-manifest order stop new waves. Already issued requests finish and stay recorded. Unknown paid calls are never retried.",
    files: [
      { path: "tasks.json", sha256: tasksSha256 },
      { path: "protocol.json", sha256: hash(protocolBytes) },
      ...(datasetManifest ? [datasetManifest] : []),
    ],
  };
  await json(resolve(directory, "manifest.json"), manifest);
  const budget =
    config.arm === "library"
      ? undefined
      : openBudgetLedger(config.budgetLedger!);
  const rawOutputs = new Map<string, unknown>();
  let budgetStop = false;
  let transport: ReturnType<typeof installExperimentTransport> | undefined;
  let transportReady = true;
  try {
    if (config.arm !== "library")
      await json(
        resolve(directory, "telemetry-warmup.json"),
        await prewarmTelemetry(),
      );
    if (config.transportWarmup && inferenceBaseUrl) {
      transport = installExperimentTransport(inferenceBaseUrl);
      const receipt = await transport.warmup();
      transportReady = receipt.ready;
      await json(resolve(directory, "transport-warmup.json"), receipt);
    }
    const outcome = await executeWaves(
      transportReady ? tasks : [],
      async (task): Promise<Entry> => {
        const started = Date.now();
        const callDirectory = resolve(directory, "calls", task.id);
        await mkdir(callDirectory, { recursive: true });
        await json(resolve(callDirectory, "task-start.json"), {
          taskId: task.id,
          startedAt: new Date().toISOString(),
          inputHash: hash(JSON.stringify(task.input)),
        });
        const calls: CallRecord[] = [];
        let providerFailed = false;
        let deadlineDuringCall = false;
        let persistenceFailed = false;
        let taskBudgetStop = false;
        let sealed = false;
        const wrappedChat: typeof chat = async (
          messages,
          chosenModel,
          signal,
        ) => {
          const callStarted = Date.now();
          const call: CallRecord = {
            index: calls.length,
            model: chosenModel,
            messages: structuredClone(messages),
            startedAt: new Date().toISOString(),
            status: "reserved",
          };
          calls.push(call);
          try {
            if (budgetStop)
              throw new BudgetStop(
                "This campaign has stopped issuing inference requests.",
              );
            call.reservationId = budget!.reserve(config.arm, task.id, messages);
          } catch (error) {
            call.status = "not-issued";
            taskBudgetStop = budgetStop = true;
            throw error;
          }
          try {
            await json(
              resolve(callDirectory, `${call.index}-request.json`),
              call,
            );
          } catch (error) {
            persistenceFailed = true;
            throw error;
          }
          const onAbort = () => {
            if (call.status === "reserved") deadlineDuringCall = true;
          };
          signal?.addEventListener("abort", onAbort, { once: true });
          if (signal?.aborted) onAbort();
          try {
            const response = await chat(messages, chosenModel, signal);
            const completion = {
              response,
              latencyMs: Date.now() - callStarted,
              status: "completed" as const,
            };
            if (!sealed) Object.assign(call, completion);
            try {
              await json(
                resolve(callDirectory, `${call.index}-response.json`),
                { ...completion, late: sealed },
              );
            } catch (error) {
              persistenceFailed = true;
              throw error;
            }
            try {
              if (!sealed) budget!.settle(call.reservationId, response.usage);
            } catch (error) {
              if (error instanceof BudgetStop)
                taskBudgetStop = budgetStop = true;
              throw error;
            }
            return response;
          } catch (error) {
            if (
              !sealed &&
              !(error instanceof BudgetStop) &&
              !persistenceFailed &&
              !signal?.aborted
            )
              providerFailed = true;
            const failure = {
              name: error instanceof Error ? error.name : "Error",
              message:
                error instanceof BudgetStop
                  ? error.message
                  : signal?.aborted
                    ? "Coordinator deadline aborted the request; no automatic retry."
                    : "Provider request failed; no automatic retry.",
              latencyMs: Date.now() - callStarted,
            };
            if (!sealed && call.status !== "completed")
              Object.assign(call, { status: "failed", error: failure });
            if (!persistenceFailed)
              await json(resolve(callDirectory, `${call.index}-error.json`), {
                ...failure,
                late: sealed,
              }).catch(() => {
                persistenceFailed = true;
              });
            throw error;
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
        };
        let result: PlanningResult | ResearchPlanningResult;
        if (config.arm === "library") {
          const found = search(task.input, {
            family: task.briefSpec.family,
            maxCandidates: 128,
          });
          const selected = found.plans.find(
            (plan) => gradePlan(task, plan).productive,
          );
          result = {
            plans: selected ? [selected] : [],
            source: "library",
            message: selected
              ? "A bounded family search found a witness satisfying the structured brief."
              : "The bounded search found no witness satisfying this structured brief; this does not prove infeasibility.",
            events: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            inputHash: hash(JSON.stringify(task.input)),
            plannerVersion: searchVersion,
            latencyMs: Date.now() - started,
          };
        } else
          result = await (
            config.arm === "gpt-oss" ? runPlanner : runResearchPlanner
          )(task.input, {
            model: model!,
            chat: wrappedChat,
            deadlineMs: 30000,
          });
        sealed = true;
        if (persistenceFailed)
          throw new Error(
            "A request receipt could not be persisted. Campaign stopped; inspect existing reservations before resuming.",
          );
        const coordinatorDeadline =
          deadlineDuringCall ||
          ("termination" in result && result.termination === "deadline");
        for (const call of calls)
          if (call.status === "reserved") {
            call.status = "outcome-unknown";
            if (!coordinatorDeadline) providerFailed = true;
          }
        const attempted =
          config.arm === "library" ||
          calls.some(
            (call) => call.reservationId && call.status !== "not-issued",
          );
        const termination =
          "termination" in result && typeof result.termination === "string"
            ? result.termination
            : result.source === "library" && config.arm !== "library"
              ? "fallback"
              : "finished";
        const classification = classifyTaskOutcome({
          attempted,
          providerFailed,
          budgetStopped: taskBudgetStop,
          coordinatorDeadline,
          termination,
        });
        const available = classification.available;
        const usageComplete =
          config.arm !== "library" &&
          calls.length > 0 &&
          calls.every(
            (call) =>
              call.response &&
              (call.response.usage.inputTokens > 0 ||
                call.response.usage.outputTokens > 0),
          );
        const entry: Entry = {
          taskId: task.id,
          sceneGroup: task.sceneGroup,
          arm: config.arm,
          attempted,
          ...classification,
          grade: available ? gradeTask(task, result, config.arm) : null,
          latencyMs: Date.now() - started,
          usage: usageComplete
            ? calls.reduce(
                (sum, call) => ({
                  inputTokens:
                    sum.inputTokens + call.response!.usage.inputTokens,
                  outputTokens:
                    sum.outputTokens + call.response!.usage.outputTokens,
                }),
                { inputTokens: 0, outputTokens: 0 },
              )
            : null,
          usageComplete,
          traceId: result.traceId,
        };
        const raw = {
          taskId: task.id,
          task,
          calls: structuredClone(calls),
          result,
          entry,
        };
        await json(resolve(directory, `${task.id}.json`), raw);
        rawOutputs.set(task.id, raw);
        await appendFile(
          resolve(directory, "results.jsonl"),
          `${JSON.stringify(entry)}\n`,
        );
        process.stdout.write(
          `${task.id}: ${entry.status}; productive=${entry.grade?.productive ?? "unscored"}\n`,
        );
        return entry;
      },
      isInfrastructureFailure,
      (entry) =>
        entry.status === "budget-exhausted" ||
        budgetStop ||
        budget?.stopped === true,
      1,
    );
    const entries = outcome.results;
    for (const task of transportReady ? outcome.unattempted : tasks) {
      const entry = unattempted(
        task,
        config.arm,
        !transportReady
          ? "transport-warmup-failure"
          : budgetStop
            ? "campaign-budget-stop"
            : "campaign-infrastructure-stop",
      );
      entries.push(entry);
      const raw = { taskId: task.id, task, calls: [], result: null, entry };
      await json(resolve(directory, `${task.id}.json`), raw);
      rawOutputs.set(task.id, raw);
      await appendFile(
        resolve(directory, "results.jsonl"),
        `${JSON.stringify(entry)}\n`,
      );
    }
    const summary = summarize(entries);
    await json(resolve(directory, "summary.json"), summary);
    await json(resolve(directory, "weave-results.json"), {
      schemaVersion: 1,
      experimentId: manifest.experimentId,
      attemptId: manifest.attemptId,
      datasetManifestSha256: manifest.datasetManifest!.sha256,
      tasksSha256,
      model: {
        name: `${config.arm}-${model ?? searchVersion}`,
        provider: config.arm === "library" ? "local" : "coreweave",
        modelId: model ?? searchVersion,
        promptSha256,
        runtimeVersion: manifest.runtimeVersion,
        checkerVersion,
        sourceHashes,
        settings,
      },
      rows: entries.map((entry) => ({
        taskId: entry.taskId,
        output: rawOutputs.get(entry.taskId),
        scores: {
          available: entry.available,
          attempted: entry.attempted,
          ...(entry.available
            ? {
                productive: entry.grade!.productive,
                false_abstention: entry.grade!.falseAbstention,
                unsupported_abstention: entry.grade!.unsupportedAbstention,
                bounded_empty: entry.grade!.boundedEmpty,
                compile_checked: entry.grade!.compileChecked,
                unchecked_empty: entry.grade!.uncheckedEmpty,
              }
            : {}),
        },
      })),
      summary,
      metadata: {
        scope: config.split,
        recordedAt: new Date().toISOString(),
        limitations: [
          "Authored synthetic scenes and deterministic brief checks, not cinematic-quality or creator-benefit evidence.",
          "The deterministic baseline receives a structured brief; model arms receive the natural-language brief.",
          "No model result receives credit for recipe-library fallback.",
          "Provider failures, coordinator deadlines, budget stops and unattempted tasks stay distinct. No paid retries.",
        ],
      },
    });
    if (budget)
      await json(resolve(directory, "budget-readback.json"), budget.snapshot());
    return { directory, manifest, summary };
  } finally {
    budget?.close();
    await transport?.close();
  }
}
async function main() {
  const args = process.argv.slice(2);
  const allowed = new Set([
    "--split",
    "--arm",
    "--tasks",
    "--output",
    "--model",
    "--limit",
    "--selection",
    "--selection-sha256",
    "--tasks-sha256",
    "--protocol",
    "--dataset-manifest",
    "--budget-ledger",
    "--transport-warmup",
  ]);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.has(args[i]) || !args[i + 1] || options.has(args[i]))
      throw new Error(`Invalid or duplicate argument ${args[i]}`);
    options.set(args[i], args[i + 1]);
  }
  const split = options.get("--split"),
    arm = options.get("--arm");
  if (
    (split !== "development" && split !== "confirmation") ||
    !["library", "gpt-oss", "llama-base", "llama-sft"].includes(arm ?? "") ||
    !options.get("--tasks") ||
    !options.get("--output")
  )
    throw new Error(
      "Required: --split development|confirmation --arm library|gpt-oss|llama-base|llama-sft --tasks FILE --output NEW_DIRECTORY",
    );
  if (
    options.has("--transport-warmup") &&
    !["true", "false"].includes(options.get("--transport-warmup")!)
  )
    throw new Error("--transport-warmup must be true or false.");
  const result = await runCampaign({
    split,
    arm: arm as Arm,
    tasks: options.get("--tasks")!,
    output: options.get("--output")!,
    model: options.get("--model"),
    limit: options.has("--limit") ? Number(options.get("--limit")) : undefined,
    selection: options.get("--selection"),
    selectionSha256: options.get("--selection-sha256"),
    tasksSha256: options.get("--tasks-sha256"),
    protocol:
      options.get("--protocol") ??
      resolve(dirname(options.get("--tasks")!), "protocol.json"),
    datasetManifest:
      options.get("--dataset-manifest") ??
      resolve(dirname(options.get("--tasks")!), "manifest.json"),
    budgetLedger: options.get("--budget-ledger"),
    transportWarmup: options.get("--transport-warmup") === "true",
  });
  process.stdout.write(`${JSON.stringify(result.summary)}\n`);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
