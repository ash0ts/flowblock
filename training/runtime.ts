import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export async function loadEvaluationRuntime(selection: string) {
  if (selection !== 'product' && selection !== 'frozen-v1') throw new Error('Runtime must be product or frozen-v1.');
  const sourcePath = selection === 'frozen-v1' ? 'training/frozen/runtime.ts' : 'src/server/planner.ts';
  const sourceSha256 = hash(await readFile(resolve(sourcePath), 'utf8'));
  if (selection === 'frozen-v1') {
    const manifest = JSON.parse(await readFile(resolve('training/frozen/runtime-manifest.json'), 'utf8')) as { snapshotSha256: string; dependencies: Record<string, string> };
    if (sourceSha256 !== manifest.snapshotSha256) throw new Error('Frozen planner snapshot failed its content hash.');
    for (const [path, expected] of Object.entries(manifest.dependencies)) {
      if (hash(await readFile(resolve(path), 'utf8')) !== expected) throw new Error(`Frozen runtime dependency changed: ${path}. Restore its evaluated version or create a new experiment.`);
    }
  }
  const runtime = selection === 'frozen-v1' ? await import('./frozen/runtime') : await import('../src/server/planner');
  return { runtime, selection, sourcePath, sourceSha256 };
}
