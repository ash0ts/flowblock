import './env';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { TakeAnalysisSchema, type PlanVersion, type TakeAnalysis } from '../src/domain';
import type { RevisionProposal } from '../src/server/revision-planner';

const base = process.env.APP_URL || 'http://127.0.0.1:3037';
const started = new Date().toISOString();
const saved = JSON.parse(await readFile('.data/smoke-media.json', 'utf8')) as { plan: PlanVersion; analysis: TakeAnalysis };
const first = TakeAnalysisSchema.parse(saved.analysis);
const video = await readFile('worker/artifacts/synthetic/synthetic-bottle.mp4');
const requests: { operation: string; status: number; elapsedMs: number }[] = [];
const privateRecord: Record<string, unknown> = { started, label: 'Synthetic replay timing correction; not a real creator improvement', originalPlan: saved.plan, firstAnalysis: first };
await mkdir('.data', { recursive: true });
async function save() { await writeFile('.data/smoke-loop.json', JSON.stringify(privateRecord, null, 2)); }
async function call(route: string, body?: unknown, method = 'POST', expected = 200) {
  const at = performance.now();
  const response = await fetch(`${base}/api/${route}`, { method, headers: { Origin: base, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  requests.push({ operation: route.replace(/[a-f0-9-]{36}/g, ':id'), status: response.status, elapsedMs: Math.round(performance.now() - at) });
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(value)}`);
  return value;
}
async function binary(url: string, headers: Record<string, string>, expected: number, operation: string) {
  const at = performance.now(), response = await fetch(url, { headers });
  const bytes = new Uint8Array(await response.arrayBuffer());
  requests.push({ operation, status: response.status, elapsedMs: Math.round(performance.now() - at) });
  assert.equal(response.status, expected, operation);
  return { status: response.status, bytes: bytes.byteLength, contentType: response.headers.get('Content-Type'), contentRange: response.headers.get('Content-Range'), firstBytes: [...bytes.slice(0, 3)] };
}

try {
  assert.equal(first.video.durationSeconds, 5);
  assert.equal(saved.plan.durationSeconds, 8);
  assert.ok(first.findings.some(f => f.kind === 'duration'));
  console.log(JSON.stringify({ stage: 'requesting-real-revision', modelSourceWillBeReported: true }));
  const proposal = await call('revisions', { plan: saved.plan, analysis: { jobId: first.jobId } }) as RevisionProposal & { revisionId: string; parentPlanId: string };
  const keys = new Set([...Object.keys(saved.plan.overrides), ...Object.keys(proposal.plan.overrides)]);
  const changed = [...keys].filter(key => JSON.stringify(saved.plan.overrides[key as keyof typeof saved.plan.overrides]) !== JSON.stringify(proposal.plan.overrides[key as keyof typeof proposal.plan.overrides]));
  assert.deepEqual(changed, ['durationSeconds']);
  assert.equal(proposal.plan.durationSeconds, 5);
  assert.equal(proposal.plan.recipeId, saved.plan.recipeId);
  assert.deepEqual(proposal.plan.scene, saved.plan.scene);
  assert.deepEqual(proposal.plan.gear, saved.plan.gear);
  assert.deepEqual(proposal.plan.intent, saved.plan.intent);
  assert.equal(proposal.findingIds.length, 1);
  assert.ok(proposal.findingIds[0].startsWith('duration:take:'));
  assert.equal(proposal.plan.validation.valid, true);
  privateRecord.proposal = proposal; await save();
  const acceptance = await call(`revisions/${proposal.revisionId}/accept`, { currentPlanId: saved.plan.id });
  assert.equal(acceptance.accepted, true);
  assert.equal(acceptance.plan.id, proposal.plan.id);
  privateRecord.acceptance = acceptance;
  console.log(JSON.stringify({ stage: 'revision-accepted', source: proposal.source, model: proposal.model ?? null, change: changed, beforeSeconds: 8, afterSeconds: 5, findingIds: proposal.findingIds }));

  const upload = await call('uploads', { fileName: 'synthetic-replay-timing-correction.mp4', contentType: 'video/mp4', sizeBytes: video.byteLength, plan: proposal.plan, trainingConsent: false });
  const at = performance.now();
  const uploadResponse = await fetch(upload.uploadUrl, { method: 'PUT', headers: { ...upload.headers, Origin: base }, body: video });
  requests.push({ operation: 'takes/:id/upload', status: uploadResponse.status, elapsedMs: Math.round(performance.now() - at) });
  assert.equal(uploadResponse.status, 200);
  await call(`uploads/${upload.takeId}/complete`, {});
  const annotation = { seed: { timeSeconds: 2.466666666666667, box: { x: 0.43125, y: 0.2388888888888889, width: 0.128125, height: 0.5555555555555556 } }, expectedVisible: { startSeconds: 0, endSeconds: 5 } };
  const job = await call(`takes/${upload.takeId}/analyze`, annotation, 'POST', 202);
  privateRecord.secondUpload = upload; privateRecord.secondJob = job; privateRecord.annotation = annotation; await save();
  console.log(JSON.stringify({ stage: 'second-analysis-running', takeId: upload.takeId, jobId: job.jobId, sameSyntheticBytes: true }));
  let second: TakeAnalysis | undefined;
  for (let attempt = 0; attempt < 180; attempt++) {
    const response = await fetch(`${base}/api/jobs/${job.jobId}`);
    assert.equal(response.status, 200);
    const state = await response.json();
    if (state.status === 'failed' || state.status === 'cancelled') throw new Error(`Second analysis ${state.status}: ${state.error}`);
    if (state.result) { second = TakeAnalysisSchema.parse(state.result); break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(second, 'Second analysis timed out');
  assert.equal(second.provenance.realInference, true);
  assert.equal(second.video.durationSeconds, 5);
  assert.equal(second.planId, proposal.plan.id);
  assert.equal(second.findings.some(f => f.kind === 'duration'), false);
  privateRecord.secondAnalysis = second; await save();

  const evidence = first.findings.flatMap(f => f.evidence ?? [])[0];
  assert.ok(evidence, 'The first duration finding must have an evidence JPEG');
  const jpeg = await binary(`${base}/api/takes/${first.takeId}/media?artifact=${encodeURIComponent(evidence.objectKey)}`, {}, 200, 'first-evidence-jpeg');
  assert.equal(jpeg.contentType, 'image/jpeg'); assert.deepEqual(jpeg.firstBytes.slice(0, 2), [255, 216]);
  const proxy = await binary(`${base}/api/takes/${upload.takeId}/media?artifact=proxy`, { Range: 'bytes=0-1023' }, 206, 'second-proxy-range');
  assert.equal(proxy.bytes, 1024); assert.ok(proxy.contentRange?.startsWith('bytes 0-1023/'));
  privateRecord.media = { jpeg, proxy };

  const share = await call('shares', { plan: proposal.plan });
  privateRecord.share = share; await save();
  const shareBefore = await fetch(share.url); await shareBefore.text(); assert.equal(shareBefore.status, 200);
  await call(`shares/${share.token}`, undefined, 'DELETE');
  const shareAfter = await fetch(share.url); await shareAfter.text(); assert.equal(shareAfter.status, 404);
  const project = await call('projects', { name: `Synthetic API verification ${randomUUID().slice(0, 8)}`, plan: saved.plan });
  const updated = await call('projects', { name: 'Synthetic API verification', projectId: project.projectId, expectedVersionId: project.versionId, plan: proposal.plan });
  const stale = await call('projects', { name: 'Synthetic API verification', projectId: project.projectId, expectedVersionId: project.versionId, plan: saved.plan }, 'POST', 409);
  privateRecord.project = { project, updated, stale }; privateRecord.requests = requests; privateRecord.completedAt = new Date().toISOString(); await save();

  const report = {
    schemaVersion: '1.0', startedAt: started, completedAt: privateRecord.completedAt,
    scope: 'Actual local HTTP API, PostgreSQL, real Forge revision request, and real SAM 2.1 Small MPS inference. No remote app deployment.',
    fixture: { label: 'SYNTHETIC PIPELINE FIXTURE', sameVideoReplayed: true, sha256: createHash('sha256').update(video).digest('hex'), durationSeconds: 5, sampledFrames: 75, creatorFootage: false },
    interpretation: 'The same synthetic video was analyzed twice. Changing planned duration from 8 seconds to 5 seconds removed the duration mismatch. This validates a timing-correction workflow, not improved filming or a real creator outcome.',
    revision: { source: proposal.source, model: proposal.model ?? null, changedParameters: changed, beforeSeconds: saved.plan.durationSeconds, afterSeconds: proposal.plan.durationSeconds, citedFindingIds: proposal.findingIds, feasible: proposal.plan.validation.valid, accepted: acceptance.accepted, actions: proposal.events.map(e => {
      const action = e.action;
      assert.ok(typeof action === 'object' && action !== null && 'action' in action && typeof action.action === 'string', 'Revision event has no action name');
      return action.action;
    }), modelFallbackUsed: proposal.source !== 'forge' },
    firstAnalysis: { device: first.provenance.device, realInference: first.provenance.realInference, coverage: first.coverage, findingKinds: first.findings.map(f => f.kind) },
    secondAnalysis: { device: second.provenance.device, realInference: second.provenance.realInference, coverage: second.coverage, findingKinds: second.findings.map(f => f.kind), durationFindingRemoved: !second.findings.some(f => f.kind === 'duration'), targetTimeBasis: second.provenance.targetTimeBasis },
    media: { evidenceJpegStatus: jpeg.status, evidenceJpegBytes: jpeg.bytes, proxyRangeStatus: proxy.status, proxyRangeBytes: proxy.bytes, proxyContentRange: proxy.contentRange },
    sharing: { createdStatus: 200, publicReadStatus: shareBefore.status, revokedReadStatus: shareAfter.status, tokensOmitted: true },
    projects: { createStatus: 200, updateStatus: 200, staleVersionStatus: 409 },
    privacy: { rawFootageCommitted: false, objectKeysAndIdentifiersOmitted: true, privateRecord: '.data/smoke-loop.json', takesPreservedForScreenshots: true },
    limitations: ['Synthetic replay is not a field evaluation.', 'MPS uses CPU fallback for unsupported PyTorch operations; no CUDA run was performed.', 'The response source above explicitly distinguishes Forge from the deterministic fallback.'],
  };
  await mkdir('docs', { recursive: true });
  await writeFile('docs/verification-api.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ stage: 'complete', revisionSource: proposal.source, secondCoverage: second.coverage, secondFindings: second.findings.map(f => f.kind), evidenceJpeg: jpeg.status, proxyRange: proxy.status, shareAfterRevocation: shareAfter.status, staleProjectVersion: 409, report: 'docs/verification-api.json' }));
} catch (error) {
  privateRecord.error = error instanceof Error ? error.message : String(error); privateRecord.requests = requests; await save(); throw error;
}
