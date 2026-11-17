import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import * as weave from "weave";
import {
  loadRecordedEvaluation,
  publicationVersionFromReceipt,
  verifyRecordedPredictions,
} from "./evaluation-publication";

const args = process.argv.slice(2);
const publish = args.includes("--publish");
const readbackOnly = args.includes("--readback");
if (publish && readbackOnly) throw new Error("Choose --publish or --readback.");
const directories = args.filter((arg) => !arg.startsWith("--"));
if (
  args.some(
    (arg) => arg.startsWith("--") && !["--publish", "--readback"].includes(arg),
  ) ||
  !directories.length
)
  throw new Error(
    "Usage: tsx training/publish-evaluations.ts [--publish | --readback] ATTEMPT_DIRECTORY...",
  );
const outputDirectory = resolve("training/results/weave-publications");
const plans = await Promise.all(
  directories.map(async (directory) => {
    const plan = await loadRecordedEvaluation(directory);
    let receipt;
    try {
      receipt = JSON.parse(
        await readFile(
          resolve(outputDirectory, `${plan.manifest.attempt}.json`),
          "utf8",
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return plan;
      throw error;
    }
    const version = publicationVersionFromReceipt(receipt);
    const selected =
      version === plan.publicationVersion
        ? plan
        : await loadRecordedEvaluation(directory, version);
    if (receipt.publicationId !== selected.publicationId)
      throw new Error(
        "Publication receipt does not match the source evidence.",
      );
    return selected;
  }),
);
if (!publish && !readbackOnly) {
  console.log(
    JSON.stringify(
      plans.map((plan) => ({
        attempt: plan.manifest.attempt,
        publicationId: plan.publicationId,
        publicationVersion: plan.publicationVersion,
        rows: plan.predictions.length,
        summary: plan.summary,
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}
const entity = process.env.WANDB_ENTITY;
const project = process.env.WANDB_PROJECT || "flowblock";
if (!entity || !process.env.WANDB_API_KEY)
  throw new Error("WANDB_ENTITY and WANDB_API_KEY are required.");
const client = await weave.init(`${entity}/${project}`);
const base = `https://forge.coreweave.com/wandb/${encodeURIComponent(entity)}/${encodeURIComponent(project)}/weave`;
await mkdir(outputDirectory, { recursive: true });

for (const plan of plans) {
  const receiptPath = resolve(outputDirectory, `${plan.manifest.attempt}.json`);
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
    throw new Error(
      "Duplicate remote publication roots; inspect before continuing.",
    );
  let receiptExists = false;
  try {
    await readFile(receiptPath);
    receiptExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!roots.length && !readbackOnly) {
    if (receiptExists)
      throw new Error(
        "Publication has a prior receipt but no visible root. Use --readback; do not blindly retry.",
      );
    await writeFile(
      receiptPath,
      `${JSON.stringify({ status: "publishing", publicationVersion: plan.publicationVersion, publicationId: plan.publicationId, attempt: plan.manifest.attempt, startedAt: new Date().toISOString() }, null, 2)}\n`,
      { flag: "wx" },
    );
    const dataset = new weave.Dataset({
      name: `flowblock-${plan.manifest.fixtureVersion}-${plan.datasetRows.length}-tasks`,
      rows: plan.datasetRows,
    });
    const evaluation = new weave.EvaluationLogger({
      name: `flowblock-recorded-${plan.manifest.arm}-${plan.publicationId.slice(0, 10)}`,
      description:
        "Imported historical qualification. No new inference. Latencies on these import calls are not model execution latencies; use recorded_latency_ms. Quality scores exclude unavailable requests.",
      dataset,
      model: {
        name: plan.modelName,
      },
      scorers: [
        "available",
        "productive_plan",
        "accepted_abstention",
        "schema_validity",
        "compile_actions",
        "rejected_compile_actions",
      ],
      attributes: {
        flowblock_publication_id: plan.publicationId,
        source_attempt: plan.manifest.attempt,
        import_only: true,
        recorded_at: plan.manifest.startedAt,
      },
      publicationVersion: plan.publicationVersion,
      sourceManifest: plan.manifest,
      sourceFileHashes: plan.sourceHashes,
    });
    for (const row of plan.predictions) {
      const prediction = await evaluation.logPredictionAsync(
        row.input,
        row.output,
      );
      for (const [name, score] of Object.entries(row.scores))
        await prediction.logScore(name, score);
      await prediction.finish();
    }
    await evaluation.logSummary(plan.summary);
    await weave.flush();
    roots = await findRoots();
  }
  if (roots.length !== 1)
    throw new Error(
      "No evaluation root visible; outcome remains unverified. Read back before retrying publication.",
    );
  const root = roots[0];
  const children = await client.getCalls({
    filter: { parent_ids: [root.id] },
    limit: 100,
  });
  const predictions = children.filter((call) =>
    call.op_name.includes("Evaluation.predict_and_score"),
  );
  const allFinished = predictions.every(
    (call) => call.ended_at && !call.exception,
  );
  const predictionScoresMatch = verifyRecordedPredictions(
    plan.predictions,
    predictions,
  );
  const summaryMatches = isDeepStrictEqual(root.output, plan.summary);
  const verified = Boolean(
    root.ended_at &&
      !root.exception &&
      predictions.length === plan.predictions.length &&
      allFinished &&
      predictionScoresMatch &&
      summaryMatches,
  );
  const receipt = {
    status: verified ? "verified" : "needs_review",
    publicationVersion: plan.publicationVersion,
    publicationId: plan.publicationId,
    attempt: plan.manifest.attempt,
    readAt: new Date().toISOString(),
    importedHistoricalResults: true,
    evaluationCallId: root.id,
    evaluationRef: root.inputs.self,
    modelRef: root.inputs.model,
    evaluationUrl: `${base}/calls/${root.id}`,
    evaluationsUrl: `${base}/evaluations`,
    observedPredictionCount: predictions.length,
    expectedPredictionCount: plan.predictions.length,
    allFinished,
    predictionScoresMatch,
    summaryMatches,
    summary: plan.summary,
    sourceFileHashes: plan.sourceHashes,
  };
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
  if (!verified)
    throw new Error(
      "Remote evaluation did not reconcile. The receipt preserves the partial state.",
    );
}
