import type { PlanningResult } from './planner';
import { AgentActionSchema, validatePlan } from './domain';
import type { Fixture } from './fixtures';

export const checkerVersion = 'flowblock-planner-checker-v2';
export type Grade = { schemaValidity: number; geometryValidity: number; familyMatch: boolean; feasibilityOutcome: 'candidate' | 'bounded-search-abstention' | 'failure'; success: boolean; invalidCandidateCount: number; compileCount: number; toolCalls: number; error?: string };
export function gradeResult(fixture: Fixture, result: PlanningResult, arm: string, rawResponses?: string[]): Grade {
  const credited = result.source === 'forge' || arm === 'library';
  const plans = credited ? result.plans : [];
  const validation = plans.map(plan => validatePlan(plan));
  const valid = plans.filter((_, index) => validation[index].valid);
  const familyMatch = valid.some(plan => plan.family === fixture.expectedFamily);
  const compileEvents = result.events.filter(event => (event.action as { action?: string })?.action === 'compile_candidate');
  const invalidCandidateCount = compileEvents.filter(event => !(event.observation as { validation?: { valid?: boolean } })?.validation?.valid).length;
  const abstention = credited && plans.length === 0 && !fixture.oracle.feasible && result.events.some(event => (event.action as { action?: string })?.action === 'finish');
  return {
    schemaValidity: rawResponses?.length ? rawResponses.filter(content => { try { return AgentActionSchema.safeParse(JSON.parse(content)).success; } catch { return false; } }).length / rawResponses.length : result.events.length ? result.events.filter(event => AgentActionSchema.safeParse(event.action).success).length / result.events.length : arm === 'library' ? 1 : 0,
    geometryValidity: plans.length ? valid.length / plans.length : abstention ? 1 : 0,
    familyMatch, feasibilityOutcome: familyMatch ? 'candidate' : abstention ? 'bounded-search-abstention' : 'failure',
    success: familyMatch || abstention, invalidCandidateCount, compileCount: compileEvents.length, toolCalls: result.events.length,
    ...(!credited ? { error: 'Model execution fell back to the recipe library; library results are not credited to the model.' } : {}),
  };
}
