import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readTrainingSummary(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path.join(process.cwd(), 'training/results/summary.json'), 'utf8'));
  } catch {
    return { status: 'not_available', message: 'No recorded training summary is installed.' };
  }
}

export function weaveProjectUrl(): string | undefined {
  const entity = process.env.WANDB_ENTITY;
  if (!entity) return undefined;
  return `https://forge.coreweave.com/wandb/${encodeURIComponent(entity)}/${encodeURIComponent(process.env.WANDB_PROJECT || 'flowblock')}/weave`;
}
