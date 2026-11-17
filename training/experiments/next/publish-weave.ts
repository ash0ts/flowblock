import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  Agent,
  fetch as transportFetch,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";
import * as weave from "weave";
import { z } from "zod";

export const publicationVersion = "flowblock-native-evaluation-v2";
const rootDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const hash = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/);
const jsonObject = z.record(z.string(), z.json());
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetId: identity.optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().regex(/\.(json|jsonl|csv)$/i),
            sha256: hashSchema,
            license: z.object({
              id: z.string().min(1),
              url: z
                .url()
                .refine(
                  (value) =>
                    value.startsWith("https://") && !new URL(value).search,
                ),
              redistributionAllowed: z.literal(true),
            }),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();
const taskSchema = z.object({ id: identity }).catchall(z.json());
const resultSchema = z
  .object({
    schemaVersion: z.literal(1),
    experimentId: identity,
    attemptId: identity,
    datasetManifestSha256: hashSchema,
    tasksSha256: hashSchema,
    model: z
      .object({
        name: z.string().min(1).max(250),
        provider: z.string().min(1).max(100),
        modelId: z.string().min(1).max(500),
        promptSha256: hashSchema.nullable(),
        runtimeVersion: z.string().min(1).max(150),
        checkerVersion: z.string().min(1).max(150),
        sourceHashes: z.record(z.string(), hashSchema),
        settings: jsonObject,
      })
      .strict(),
    rows: z
      .array(
        z
          .object({
            taskId: identity,
            output: jsonObject,
            scores: z.record(
              z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_/-]{0,99}$/),
              z.union([z.boolean(), z.number().finite()]),
            ),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
    summary: jsonObject,
    metadata: z
      .object({
        scope: z.enum(["development", "confirmation", "measurement-benchmark"]),
        recordedAt: z.iso.datetime({ offset: true }),
        limitations: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();
export type PublicationResult = z.infer<typeof resultSchema>;
type Task = z.infer<typeof taskSchema>;
type Prediction = {
  input: Task;
  output: PublicationResult["rows"][number]["output"];
  scores: Record<string, boolean | number>;
};

function rejectSensitive(value: unknown): void {
  if (typeof value === "string") {
    if (
      /Bearer\s|X-Amz-|X-Goog-|[?&](?:token|signature)=|data:[^;]+;base64,/i.test(
        value,
      )
    )
      throw new Error(
        "Publication contains credential, signed-URL, or embedded-media material.",
      );
  } else if (Array.isArray(value)) {
    value.forEach(rejectSensitive);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (
        /^(?:wandb[_-]?)?api[_-]?key$|^authorization$|^cookie$|^password$|^(?:access|refresh)[_-]?token$/i.test(
          key,
        )
      )
        throw new Error("Publication contains a credential field.");
      rejectSensitive(entry);
    }
  }
}

export function summarizeScores(
  rows: PublicationResult["rows"],
  recorded: PublicationResult["summary"],
): Record<string, unknown> & {
  task_counts: { requested: number; published: number };
  recorded_summary: PublicationResult["summary"];
} {
  const names = [
    ...new Set(rows.flatMap((row) => Object.keys(row.scores))),
  ].sort();
  const aggregate: Record<string, Record<string, number>> = {};
  for (const name of names) {
    const values = rows.flatMap((row) =>
      name in row.scores ? [row.scores[name]] : [],
    );
    const sum = values.reduce<number>(
      (total, value) => total + Number(value),
      0,
    );
    aggregate[name] = { count: values.length, mean: sum / values.length, sum };
    if (values.every((value) => typeof value === "boolean")) {
      aggregate[name].true_count = sum;
      aggregate[name].false_count = values.length - sum;
      aggregate[name].true_fraction = sum / values.length;
    }
  }
  return {
    ...aggregate,
    task_counts: { requested: rows.length, published: rows.length },
    recorded_summary: recorded,
  };
}

export async function loadPublication(
  manifestPath: string,
  tasksPath: string,
  resultsPath: string,
) {
  const paths = [manifestPath, tasksPath, resultsPath].map((path) =>
    resolve(path),
  );
  const [manifestBytes, taskBytes, resultBytes] = await Promise.all(
    paths.map((path) => readFile(path)),
  );
  if (taskBytes.length > 20_000_000 || resultBytes.length > 80_000_000)
    throw new Error("Publication exceeds the bounded metadata size.");
  const manifest = manifestSchema.parse(JSON.parse(manifestBytes.toString()));
  const tasks = z
    .array(taskSchema)
    .min(1)
    .max(10000)
    .parse(JSON.parse(taskBytes.toString()));
  const result = resultSchema.parse(JSON.parse(resultBytes.toString()));
  rejectSensitive(manifest);
  rejectSensitive(tasks);
  rejectSensitive(result);
  const sourceHashes = {
    manifest: hash(manifestBytes),
    tasks: hash(taskBytes),
    results: hash(resultBytes),
  };
  if (
    result.datasetManifestSha256 !== sourceHashes.manifest ||
    result.tasksSha256 !== sourceHashes.tasks
  )
    throw new Error(
      "Evaluation results do not match the frozen manifest and task bytes.",
    );
  const taskEntries = manifest.files.filter(
    (file) => file.sha256 === sourceHashes.tasks,
  );
  if (taskEntries.length !== 1)
    throw new Error(
      "Task bytes must match exactly one file declared in the dataset manifest.",
    );
  const manifestDirectory = await realpath(dirname(paths[0]));
  const declared = new Set<string>();
  for (const file of manifest.files) {
    if (
      isAbsolute(file.path) ||
      file.path.split(/[\\/]/).includes("..") ||
      declared.has(file.path)
    )
      throw new Error("Dataset manifest paths must be relative and unique.");
    declared.add(file.path);
    const actualPath = await realpath(resolve(manifestDirectory, file.path));
    const rel = relative(manifestDirectory, actualPath);
    if (
      rel.startsWith("..") ||
      isAbsolute(rel) ||
      hash(await readFile(actualPath)) !== file.sha256
    )
      throw new Error(
        "A frozen dataset file is outside its manifest or has changed.",
      );
  }
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  if (
    taskMap.size !== tasks.length ||
    new Set(result.rows.map((row) => row.taskId)).size !== result.rows.length ||
    result.rows.length !== tasks.length
  )
    throw new Error(
      "Every requested task must have exactly one result row, including unavailable tasks.",
    );
  const predictions: Prediction[] = result.rows.map((row) => {
    const input = taskMap.get(row.taskId);
    if (!input)
      throw new Error("Evaluation row references an undeclared task.");
    if (
      Object.keys(row.scores).some((key) =>
        ["task_counts", "recorded_summary"].includes(key),
      )
    )
      throw new Error(
        "Score names must not overwrite publication summary fields.",
      );
    if (
      row.scores.available === false &&
      Object.keys(row.scores).some(
        (key) => !["available", "attempted"].includes(key),
      )
    )
      throw new Error("Unavailable rows must not receive quality scores.");
    return { input, output: row.output, scores: row.scores };
  });
  const publicationId = hash(
    JSON.stringify({ version: publicationVersion, sourceHashes }),
  );
  const modelHash = hash(JSON.stringify(result.model));
  const modelName = `${result.model.name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 65)}-${modelHash.slice(0, 16)}`;
  return {
    result,
    tasks,
    predictions,
    publicationId,
    sourceHashes,
    modelName,
    datasetName: `flowblock-${(manifest.datasetId || result.experimentId).slice(0, 70)}-${sourceHashes.tasks.slice(0, 12)}`,
    summary: summarizeScores(result.rows, result.summary),
  };
}
export type Publication = Awaited<ReturnType<typeof loadPublication>> & {
  recovery?: {
    publicationId: string;
    evaluationCallId: string;
    receiptSha256: string;
  };
};

export async function recoverEmptyImport(
  plan: Publication,
  receiptPath: string,
): Promise<Publication> {
  const bytes = await readFile(receiptPath);
  const receipt = JSON.parse(bytes.toString());
  if (
    receipt.status !== "needs-review" ||
    receipt.publicationId !== plan.publicationId ||
    receipt.observedRows !== 0 ||
    receipt.datasetMatches !== true ||
    receipt.configurationMatches !== true ||
    typeof receipt.evaluationCallId !== "string"
  )
    throw new Error(
      "Recovery requires verified dataset/configuration and an incomplete import with zero completed rows.",
    );
  const recovery = {
    publicationId: plan.publicationId,
    evaluationCallId: receipt.evaluationCallId,
    receiptSha256: hash(bytes),
  };
  return {
    ...plan,
    recovery,
    publicationId: hash(
      JSON.stringify({
        publicationVersion,
        recovery,
        sourceHashes: plan.sourceHashes,
      }),
    ),
  };
}

export function verifyPredictions(
  expected: Prediction[],
  observed: {
    inputs: Record<string, unknown>;
    output?: unknown;
    ended_at?: string | null;
    exception?: string | null;
  }[],
) {
  if (expected.length !== observed.length) return false;
  const rows = new Map(expected.map((row) => [row.input.id, row]));
  const seen = new Set<string>();
  for (const call of observed) {
    const id = (call.inputs.example as { id?: string } | undefined)?.id;
    if (!id || seen.has(id) || !call.ended_at || call.exception) return false;
    const row = rows.get(id);
    if (
      !row ||
      !isDeepStrictEqual(call.inputs.example, row.input) ||
      !isDeepStrictEqual(call.output, {
        output: row.output,
        scores: row.scores,
      })
    )
      return false;
    seen.add(id);
  }
  return true;
}

async function requirePrivateProject(entity: string, project: string) {
  const base = process.env.WANDB_BASE_URL || "https://api.forge.coreweave.com";
  const proofPath = process.env.FLOWBLOCK_PRIVATE_PROJECT_PROOF;
  if (proofPath) {
    const bytes = await readFile(proofPath);
    const proof = JSON.parse(bytes.toString());
    const age = Date.now() - Date.parse(proof.startedAt);
    if (
      proof.mode !== "read-only" ||
      proof.status !== "verified-read" ||
      proof.privateProjectVerified !== true ||
      proof.sdkAuthenticated !== true ||
      proof.apiBase !== base ||
      proof.entity !== entity ||
      proof.project !== project ||
      proof.originalRun?.entity !== entity ||
      proof.originalRun?.project !== project ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 15 * 60_000
    )
      throw new Error(
        "Cached project proof must be a verified read of this same private project within 15 minutes.",
      );
    return {
      source: "cached-same-session-read",
      proofSha256: hash(bytes),
      verifiedAt: proof.startedAt,
      apiBase: base,
    };
  }
  const dispatcher = new Agent({ connect: { timeout: 55000, family: 4 } });
  try {
    const response = await transportFetch(
      `${base.replace(/\/$/, "")}/graphql`,
      {
        method: "POST",
        dispatcher,
        signal: AbortSignal.timeout(90000),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${Buffer.from(`api:${process.env.WANDB_API_KEY}`).toString("base64")}`,
        },
        body: JSON.stringify({
          query:
            "query FlowBlockEvaluationAccess($entity: String!, $project: String!) { project(name: $project, entityName: $entity) { access } }",
          variables: { entity, project },
        }),
      },
    );
    if (!response.ok) throw new Error("Project privacy preflight failed.");
    const body = (await response.json()) as {
      errors?: unknown;
      data?: { project?: { access?: string } };
    };
    if (
      body.errors ||
      !["private", "restricted"].includes(
        String(body.data?.project?.access).toLowerCase(),
      )
    )
      throw new Error(
        "Evaluation publication requires an existing private project.",
      );
    return {
      source: "live-read",
      verifiedAt: new Date().toISOString(),
      apiBase: base,
    };
  } finally {
    await dispatcher.close();
  }
}

export async function publishEvaluation(plan: Publication, verifyOnly = false) {
  // This CLI owns the process. The SDK's fetch requests share this pool;
  // changing only our preflight leaves SDK connections on Node's 10s default.
  const previous = getGlobalDispatcher();
  const dispatcher = new Agent({
    connections: 4,
    connect: { timeout: 55000, family: 4 },
    headersTimeout: 90000,
    bodyTimeout: 90000,
    keepAliveTimeout: 60000,
    keepAliveMaxTimeout: 120000,
  });
  setGlobalDispatcher(dispatcher);
  try {
    return await publishWithTransport(plan, verifyOnly);
  } finally {
    setGlobalDispatcher(previous);
    await dispatcher.destroy();
  }
}

export async function importRecordedPredictions(
  predictions: Prediction[],
  logPrediction: (
    input: Prediction["input"],
    output: Prediction["output"],
  ) => Promise<{
    logScore(name: string, value: boolean | number): Promise<unknown>;
    finish(): Promise<unknown>;
  }>,
  concurrency = 4,
) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error(
      "Import concurrency must be an integer from one through eight.",
    );
  let next = 0;
  let stopped = false;
  const workers = Array.from(
    { length: Math.min(concurrency, predictions.length) },
    async () => {
      while (!stopped && next < predictions.length) {
        const row = predictions[next++];
        try {
          const prediction = await logPrediction(row.input, row.output);
          for (const [name, value] of Object.entries(row.scores))
            await prediction.logScore(name, value);
          await prediction.finish();
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    },
  );
  // Preserve receipts only after every in-flight writer has settled. This
  // prevents a failed worker from leaving background writes unobserved.
  const settled = await Promise.allSettled(workers);
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

async function publishWithTransport(plan: Publication, verifyOnly: boolean) {
  const entity = process.env.WANDB_ENTITY,
    project = process.env.WANDB_PROJECT || "flowblock";
  if (!entity || !process.env.WANDB_API_KEY)
    throw new Error("WANDB_ENTITY and WANDB_API_KEY are required.");
  const projectAccess = await requirePrivateProject(entity, project);
  const client = await weave.init(`${entity}/${project}`);
  const receiptDirectory = resolve(
    rootDirectory,
    "training/experiments/next/results/weave-publications",
  );
  await mkdir(receiptDirectory, { recursive: true });
  const receiptPath = resolve(receiptDirectory, `${plan.publicationId}.json`);
  const findRoots = () =>
    client.getCalls({
      filter: { trace_roots_only: true },
      query: {
        $expr: {
          $eq: [
            { $getField: "attributes.flowblock_publication_id" },
            { $literal: plan.publicationId },
          ],
        },
      },
      limit: 2,
    });
  let roots = await findRoots();
  if (roots.length > 1)
    throw new Error("Duplicate evaluation roots require review.");
  let previous: Record<string, unknown> | undefined;
  try {
    previous = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (previous && previous.publicationId !== plan.publicationId)
    throw new Error("Existing receipt has different evidence.");
  if (!roots.length && !verifyOnly) {
    if (previous)
      throw new Error(
        "A prior publication has no visible root; read back before retrying any write.",
      );
    if (plan.recovery) {
      const original = await client.getCalls({
        filter: { call_ids: [plan.recovery.evaluationCallId] },
        limit: 2,
      });
      const children = await client.getCalls({
        filter: { parent_ids: [plan.recovery.evaluationCallId] },
        limit: plan.predictions.length + 50,
      });
      if (
        original.length !== 1 ||
        original[0].attributes.flowblock_publication_id !==
          plan.recovery.publicationId ||
        children.some((call) =>
          call.op_name.includes("Evaluation.predict_and_score"),
        )
      )
        throw new Error(
          "Interrupted import changed since readback; recovery stopped before writes.",
        );
    }
    await writeFile(
      receiptPath,
      JSON.stringify(
        {
          status: "publishing",
          publicationId: plan.publicationId,
          publicationVersion,
          attemptId: plan.result.attemptId,
          startedAt: new Date().toISOString(),
          sourceHashes: plan.sourceHashes,
          projectAccess,
          recoveryOf: plan.recovery,
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    try {
      const dataset = new weave.Dataset({
        name: plan.datasetName,
        // The SDK attaches row references while saving. Keep prediction inputs
        // as immutable recorded JSON so call readback can compare them directly.
        rows: structuredClone(plan.tasks),
      });
      await dataset.save();
      const evaluation = new weave.EvaluationLogger({
        name: `flowblock-${plan.result.attemptId.slice(0, 75)}-${plan.publicationId.slice(0, 10)}`,
        description:
          "Imported completed experiment. This publication performs no inference. Use recorded task/provider latency, not import-call wall time. Unavailable tasks have coverage scores only." +
          (plan.recovery
            ? ` Recovery of interrupted import ${plan.recovery.evaluationCallId}; this is the same recorded experiment.`
            : ""),
        dataset,
        model: { name: plan.modelName },
        scorers: [
          ...new Set(
            plan.result.rows.flatMap((row) => Object.keys(row.scores)),
          ),
        ],
        attributes: {
          flowblock_publication_id: plan.publicationId,
          experiment_id: plan.result.experimentId,
          attempt_id: plan.result.attemptId,
          scope: plan.result.metadata.scope,
          import_only: true,
          recovery_of: plan.recovery?.evaluationCallId,
        },
        publicationVersion,
        sourceFileHashes: plan.sourceHashes,
        modelConfiguration: plan.result.model,
        experimentMetadata: plan.result.metadata,
      });
      await importRecordedPredictions(plan.predictions, (input, output) =>
        evaluation.logPredictionAsync(input, output),
      );
      await evaluation.logSummary(plan.summary);
      await weave.flush();
      roots = await findRoots();
    } catch (error) {
      await writeFile(
        receiptPath,
        JSON.stringify(
          {
            status: "outcome-unknown",
            publicationId: plan.publicationId,
            publicationVersion,
            attemptId: plan.result.attemptId,
            errorType: error instanceof Error ? error.name : "UnknownError",
            sourceHashes: plan.sourceHashes,
          },
          null,
          2,
        ) + "\n",
      );
      throw error;
    }
  }
  if (roots.length !== 1)
    throw new Error(
      "No evaluation root is visible. No duplicate publication was attempted.",
    );
  const root = roots[0];
  const children = await client.getCalls({
    filter: { parent_ids: [root.id] },
    limit: plan.predictions.length + 50,
  });
  const predictions = children.filter((call) =>
    call.op_name.includes("Evaluation.predict_and_score"),
  );
  const rowsMatch = verifyPredictions(plan.predictions, predictions);
  const summaryMatches = isDeepStrictEqual(root.output, plan.summary);
  const remoteEvaluation = await client.get(
    weave.ObjectRef.fromUri(String(root.inputs.self)),
  );
  const datasetRef = String(remoteEvaluation.dataset);
  const remoteDataset = await client.get(weave.ObjectRef.fromUri(datasetRef));
  const datasetRows: unknown[] = [];
  for await (const row of remoteDataset) {
    const value = { ...row };
    delete value.__savedRef;
    datasetRows.push(value);
  }
  const datasetMatches = isDeepStrictEqual(datasetRows, plan.tasks);
  const configurationMatches =
    isDeepStrictEqual(remoteEvaluation.modelConfiguration, plan.result.model) &&
    isDeepStrictEqual(remoteEvaluation.sourceFileHashes, plan.sourceHashes);
  const verified = Boolean(
    root.ended_at &&
      !root.exception &&
      rowsMatch &&
      summaryMatches &&
      datasetMatches &&
      configurationMatches,
  );
  const base = `https://forge.coreweave.com/wandb/${encodeURIComponent(entity)}/${encodeURIComponent(project)}/weave`;
  const receipt = {
    status: verified ? "verified" : "needs-review",
    publicationVersion,
    publicationId: plan.publicationId,
    experimentId: plan.result.experimentId,
    attemptId: plan.result.attemptId,
    verifiedAt: new Date().toISOString(),
    importOnly: true,
    recoveryOf: plan.recovery,
    projectAccess,
    modelsApiBase:
      process.env.WANDB_BASE_URL || "https://api.forge.coreweave.com",
    traceApiBase: client.traceServerApi.baseURL,
    sourceHashes: plan.sourceHashes,
    evaluationCallId: root.id,
    evaluationRef: root.inputs.self,
    modelRef: root.inputs.model,
    datasetRef,
    evaluationUrl: `${base}/calls/${root.id}`,
    evaluationsUrl: `${base}/evaluations`,
    expectedRows: plan.predictions.length,
    observedRows: predictions.length,
    rowsMatch,
    summaryMatches,
    datasetMatches,
    configurationMatches,
    summary: plan.summary,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  if (!verified)
    throw new Error(
      "Remote rows or aggregate evidence did not reconcile. Inspect the preserved receipt.",
    );
  return receipt;
}

async function main() {
  const args = process.argv.slice(2);
  const publish = args.includes("--publish"),
    verify = args.includes("--verify");
  const recoveryArg = args.find((arg) => arg.startsWith("--recovery-receipt="));
  const paths = args.filter((arg) => !arg.startsWith("--"));
  if (
    paths.length !== 3 ||
    (publish && verify) ||
    args.some(
      (arg) =>
        arg.startsWith("--") &&
        !["--publish", "--verify"].includes(arg) &&
        !arg.startsWith("--recovery-receipt="),
    )
  )
    throw new Error(
      "Usage: tsx publish-weave.ts MANIFEST TASKS RESULTS [--publish | --verify]",
    );
  let plan: Publication = await loadPublication(paths[0], paths[1], paths[2]);
  if (recoveryArg)
    plan = await recoverEmptyImport(
      plan,
      recoveryArg.slice("--recovery-receipt=".length),
    );
  console.log(
    JSON.stringify(
      publish || verify
        ? await publishEvaluation(plan, verify)
        : {
            mode: "dry-run",
            publicationId: plan.publicationId,
            datasetName: plan.datasetName,
            modelName: plan.modelName,
            taskCount: plan.predictions.length,
            summary: plan.summary,
          },
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    console.error(
      `Evaluation publication stopped: ${error instanceof Error ? error.name : "UnknownError"}. Inspect local evidence and receipts before retrying. Provider error text is withheld.`,
    );
    process.exitCode = 1;
  });
}
