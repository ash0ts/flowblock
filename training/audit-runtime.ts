import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest } from './fixtures';

const [beforeDirectory, afterDirectory] = process.argv.slice(2);
if (!beforeDirectory || !afterDirectory) throw new Error('Provide before and after attempt directories.');
const before = JSON.parse(await readFile(resolve(beforeDirectory, 'manifest.json'), 'utf8'));
const after = JSON.parse(await readFile(resolve(afterDirectory, 'manifest.json'), 'utf8'));
const path = 'src/server/planner.ts';
const current = await readFile(resolve('training/frozen/runtime.ts'), 'utf8');
const marker = 'export async function telemetry() {';
if (!current.includes(marker) || current.indexOf(marker) !== current.lastIndexOf(marker)) throw new Error('Expected exactly one exported telemetry declaration.');
const reconstructed = current.replace(marker, 'async function telemetry() {');
const verified = digest(current) === after.sourceHashes[path] && digest(reconstructed) === before.sourceHashes[path];
if (!verified) throw new Error('Removing the telemetry export did not reconstruct the exact before hash.');
const audit = {
  verifiedAt: new Date().toISOString(), path, beforeHash: digest(reconstructed), afterHash: digest(current), verified,
  exactTransformation: "Remove the single 'export ' prefix from 'export async function telemetry() {'.",
  effect: 'Makes the existing telemetry initializer importable by the separate revision planner. Function body, planner behavior, prompt, tool execution and scoring are unchanged.',
  beforeAttempt: before.attempt, afterAttempt: after.attempt,
};
await writeFile(resolve('training/results/runtime-equivalence.json'), `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx' });
process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
