import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as weave from 'weave';

const attempt = process.argv[2];
if (!attempt) throw new Error('Usage: tsx training/read-traces.ts ATTEMPT_DIRECTORY');
const results = (await readFile(resolve(attempt, 'results.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)) as { fixtureId: string; traceId?: string; available: boolean; grade?: { success: boolean } }[];
const selected = [...results.filter(r => r.traceId && r.grade?.success).slice(0, 1), ...results.filter(r => r.traceId && !r.grade?.success).slice(0, 1)];
const client = await weave.init(`${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT || 'flowblock'}`);
const readbacks = [];
for (const result of selected) {
  try {
    const response = await client.getAgentTurns({ conversationId: result.traceId!, limit: 10 });
    const turns = response.data.turns || [];
    readbacks.push({ fixtureId: result.fixtureId, conversationId: result.traceId, status: response.status, totalTurns: response.data.total_turns, turns: turns.map(turn => ({ traceId: turn.trace_id, rootSpanName: turn.root_span_name })), verified: turns.length > 0, projectUrl: `https://forge.coreweave.com/wandb/${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT || 'flowblock'}/weave` });
  } catch (error) { readbacks.push({ fixtureId: result.fixtureId, conversationId: result.traceId, verified: false, error: error instanceof Error ? error.message : 'Readback failed' }); }
}
await mkdir(resolve('training/results'), { recursive: true });
const name = resolve(attempt).split('/').at(-1);
await writeFile(resolve('training/results', `${name}-trace-readback.json`), `${JSON.stringify({ attempt: name, readAt: new Date().toISOString(), readbacks }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(readbacks, null, 2)}\n`);
