import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [comparisonPath, libraryDirectory, baselineDirectory] = process.argv.slice(2);
if (!comparisonPath || !libraryDirectory || !baselineDirectory) throw new Error('Usage: tsx training/summarize.ts COMPARISON_JSON LIBRARY_DIRECTORY BASELINE_DIRECTORY');
const comparison = JSON.parse(await readFile(resolve(comparisonPath), 'utf8'));
const training = JSON.parse(await readFile(resolve('training/results/training-receipt.json'), 'utf8'));
const readback = JSON.parse(await readFile(resolve('training/results/training-readback.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve('training/frozen/manifest.json'), 'utf8'));
async function arm(directory: string, label: string) {
  const summary = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8'));
  const actor = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  const results = (await readFile(resolve(directory, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const available = results.filter(row => row.available);
  const compiles = available.reduce((sum, row) => sum + (row.grade?.compileCount || 0), 0);
  return {
    arm: summary.arm, label, model: summary.model, attempt: summary.attempt,
    inferenceBaseUrl: actor.inferenceBaseUrl || (summary.arm === 'library' ? null : 'https://api.inference.wandb.ai/v1'),
    requested: summary.requestedTasks, attempted: summary.attemptedTasks, available: summary.availableTasks,
    unavailable: summary.unavailableTasks, unattempted: summary.unattemptedTasks,
    successes: summary.successCount, successDenominator: summary.availableTasks,
    productiveCandidates: available.filter(row => row.grade?.feasibilityOutcome === 'candidate').length,
    boundedSearchAbstentions: available.filter(row => row.grade?.feasibilityOutcome === 'bounded-search-abstention').length,
    meanTaskSchemaValidity: available.length ? available.reduce((sum, row) => sum + (row.grade?.schemaValidity || 0), 0) / available.length : null,
    compileActions: compiles, invalidCompileActions: available.reduce((sum, row) => sum + (row.grade?.invalidCandidateCount || 0), 0),
    medianLatencyMs: summary.medianLatencyMs, inputTokens: summary.inputTokens, outputTokens: summary.outputTokens,
    dollarCost: null, costStatus: 'unknown; no invoice readback',
  };
}
const arms = await Promise.all([
  arm(libraryDirectory, 'Recipe library'), arm(baselineDirectory, 'Product baseline: GPT-OSS 20B'),
  arm(resolve('training/artifacts', comparison.beforeAttempt), 'Untrained Llama 3.1 8B, matched gateway'),
  arm(resolve('training/artifacts', comparison.afterAttempt), 'SFT Llama 3.1 8B, checkpoint 1'),
]);
const summary = {
  schemaVersion: '1.0', status: 'trained_evaluated', createdAt: new Date().toISOString(),
  headline: 'Training completed; the candidate learned to abstain and did not improve useful shot planning.',
  modelId: training.modelId, inferenceModel: training.inferenceModel,
  checkpointId: readback.checkpoints.find((checkpoint: { step: number }) => checkpoint.step === training.trainedStep)?.id,
  checkpointStep: training.trainedStep, datasetHash: training.datasetSha256,
  runUrl: readback.canonicalRunUrl, traceProjectUrl: 'https://forge.coreweave.com/wandb/wandb/flowblock/weave',
  dataset: { ...manifest.counts, labelSource: 'Synthetic scenes, deterministic solver-reviewed action labels', splitUnit: 'scene geometry' },
  training: { rows: training.rows, epochs: training.epochs, gradientUpdates: readback.gradientUpdates, processedTokens: readback.totalReportedTokens, lossBearingTokens: readback.totalLossBearingTokens, firstLoss: readback.firstLoss, lastLoss: readback.lastLoss, checkpointSelection: 'Single predeclared final checkpoint; no development-set selection or test-driven checkpoint choice.', telemetryRecovery: 'Final SDK telemetry failed. Independent completed-job and positive-checkpoint readback verified training success. Original failure receipt was preserved.' },
  evaluation: { scope: 'qualification', tasksPerArm: 12, sceneGroups: 2, trialsPerTask: 1, frozenFullCampaignTasks: 72, fullCampaignCompleted: false, arms, comparison: { controlsMatched: comparison.controlsMatched, exactSourceHashesMatch: comparison.exactSourceHashesMatch, sourceEquivalenceAudit: 'runtime-equivalence.json', pairedAvailableTasks: comparison.pairedAvailableTasks, aggregateGains: comparison.gains, aggregateLosses: comparison.losses, productiveCandidatesBefore: comparison.beforeProductiveCandidates, productiveCandidatesAfter: comparison.afterProductiveCandidates, boundedSearchAbstentionsBefore: comparison.beforeBoundedSearchAbstentions, boundedSearchAbstentionsAfter: comparison.afterBoundedSearchAbstentions, interpretation: 'All six aggregate gains are abstentions on a scene where the bounded recipe search found no candidate. The trained model returned no useful matching shots on the feasible scene. This is not evidence of improved planning quality.' } },
  promotionDecision: { promote: false, selectedModel: 'openai/gpt-oss-20b', reason: 'No improvement in productive planning; retain the configured baseline and deterministic validation.' },
  limitations: ['Two held-out synthetic scenes with six dependent intents each; one trial per task.', 'The frozen 72-task full campaign and development-set model selection were not run.', 'The finite recipe oracle is not proof of global infeasibility.', 'One baseline transport failure is unavailable, not a scored actor failure.', 'Actual billed cost is unknown; token usage is provider reported.', 'A telemetry export-only source change was exactly reconstructed and hash-verified; both original hashes and the initial strict comparison are retained.'],
  nextExperiment: 'Use development-only diagnosis to rebalance action labels and penalize empty final answers on feasible tasks before considering another separately authorized training run.',
};
await writeFile(resolve('training/results/summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: summary.status, headline: summary.headline, arms, promotionDecision: summary.promotionDecision }, null, 2)}\n`);
