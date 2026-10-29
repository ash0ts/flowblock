import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentActionSchema, compilePlan, planShots } from '../src/domain';
import { plannerVersion, systemPrompt, type PlanningResult } from '../src/server/planner';
import { gradeResult } from '../training/evaluation';
import { digest, type Fixture } from '../training/fixtures';
import { loadEvaluationRuntime } from '../training/runtime';

const fixtures: Fixture[] = JSON.parse(readFileSync('training/frozen/fixtures.json', 'utf8'));
const manifest = JSON.parse(readFileSync('training/frozen/manifest.json', 'utf8'));
const rows: { messages: { role: string; content: string }[] }[] = readFileSync('training/frozen/train.jsonl', 'utf8').trim().split('\n').map(line => JSON.parse(line));
const baseResult = (fixture: Fixture): PlanningResult => ({ source: 'forge', plans: [], events: [], usage: { inputTokens: 0, outputTokens: 0 }, inputHash: digest(fixture.input), plannerVersion, latencyMs: 0, message: '' });

describe('frozen training and evaluation contract', () => {
  it('preserves the evaluated runtime independently of the product deadline fix', async () => {
    const frozen = await loadEvaluationRuntime('frozen-v1');
    expect(frozen.runtime.plannerVersion).toBe('flowblock-planner-v1');
    expect(frozen.sourceSha256).toBe('8b21e16f9fd9cb43cc9a01a0f30c138907765505f5ca102481ea7d2a729972e9');
    expect(plannerVersion).toBe('flowblock-planner-v1.1');
    expect(frozen.runtime.systemPrompt).toBe(systemPrompt);
  });
  it('uses disjoint scene geometry across train, dev and test', () => {
    const splits = ['train', 'dev', 'test'].map(split => new Set(fixtures.filter(f => f.split === split).map(f => f.geometryHash)));
    expect(splits.map(s => s.size)).toEqual([24, 6, 12]);
    for (let i = 0; i < splits.length; i++) for (let j = i + 1; j < splits.length; j++) expect([...splits[i]].filter(hash => splits[j].has(hash))).toEqual([]);
  });
  it('preserves exact content and runtime prompt hashes', () => {
    for (const [name, sha] of Object.entries(manifest.files)) expect(digest(readFileSync(`training/frozen/${name}`, 'utf8'))).toBe(sha);
    expect(digest(systemPrompt)).toBe(manifest.systemPromptSha256);
  });
  it('stays within the authorized example budget and plain-message action contract', () => {
    expect(rows.length).toBeLessThanOrEqual(400);
    expect(rows.length).toBe(manifest.counts.trainingRows);
    for (const row of rows) {
      expect(row.messages.at(-1)?.role).toBe('assistant');
      expect(AgentActionSchema.safeParse(JSON.parse(row.messages.at(-1)!.content)).success).toBe(true);
      expect(row.messages.every(message => ['system', 'user', 'assistant'].includes(message.role))).toBe(true);
      expect('tools' in row).toBe(false);
    }
  });
  it('independently recompiles every solver-approved training label', () => {
    for (const fixture of fixtures.filter(f => f.split === 'train' && f.oracle.feasible)) {
      const plan = compilePlan(fixture.input.scene, fixture.input.gear, fixture.input.intent, fixture.oracle.recipeId!, fixture.oracle.overrides);
      expect(plan.validation.valid).toBe(true);
      expect(plan.family).toBe(fixture.expectedFamily);
      expect(plan.id).toBe(fixture.oracle.candidateId);
    }
  });
  it('keeps qualification membership fixed to two held-out scene groups', () => {
    const tasks = fixtures.filter(f => manifest.qualificationTaskIds.includes(f.id));
    expect(tasks).toHaveLength(12);
    expect(tasks.every(f => f.split === 'test')).toBe(true);
    expect(new Set(tasks.map(f => f.sceneGroup)).size).toBe(2);
  });
});

describe('evaluation grading boundaries', () => {
  const fixture = fixtures.find(f => f.split === 'test' && f.oracle.feasible)!;
  const plan = compilePlan(fixture.input.scene, fixture.input.gear, fixture.input.intent, fixture.oracle.recipeId!, fixture.oracle.overrides);
  it('never credits local fallback candidates to an unavailable model', () => {
    const result = { ...baseResult(fixture), source: 'library' as const, plans: [plan] };
    expect(gradeResult(fixture, result, 'baseline').success).toBe(false);
    expect(gradeResult(fixture, result, 'library').success).toBe(true);
  });
  it('does not reward empty responses on feasible tasks', () => {
    expect(gradeResult(fixture, baseResult(fixture), 'baseline').success).toBe(false);
  });
  it('only counts explicit bounded-search abstention when the oracle found no candidate', () => {
    const impossible = fixtures.find(f => !f.oracle.feasible)!;
    const result = baseResult(impossible);
    expect(gradeResult(impossible, result, 'baseline').success).toBe(false);
    result.events = [{ action: { action: 'finish', candidateIds: [], explanation: 'No matching candidate in the checked search.' }, observation: {}, elapsedMs: 1 }];
    expect(gradeResult(impossible, result, 'baseline').feasibilityOutcome).toBe('bounded-search-abstention');
  });
  it('checks user-requested family separately from geometry validity', () => {
    const moving = fixtures.find(f => f.split === 'test' && f.expectedFamily === 'orbit' && f.oracle.feasible)!;
    const hold = planShots(moving.input.scene, moving.input.gear, moving.input.intent).find(p => p.family === 'hold' && p.validation.valid)!;
    expect(hold).toBeDefined();
    const grade = gradeResult(moving, { ...baseResult(moving), plans: [hold] }, 'baseline');
    expect(grade.geometryValidity).toBe(1); expect(grade.familyMatch).toBe(false); expect(grade.success).toBe(false);
  });
});
