import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { PlanningResult } from "../../../src/server/planner";
import type { Fixture } from "../../fixtures";
import { loadEvaluationRuntime } from "../../runtime";

export const diagnosticsVersion = "flowblock-raw-reply-diagnostics-v1";
export type RecordedAttempt = {
  fixtureId?: string;
  calls: { response?: { content: string } | null }[];
  result?: PlanningResult;
  entry?: { arm?: string; grade?: unknown };
};

type RecomputedCompile = {
  provenance: "offline-recomputation";
  candidateId: string;
  valid: boolean;
  violationCodes: string[];
};
export type ReplyDiagnostic = {
  callIndex: number;
  status: "no-response" | "invalid-json" | "invalid-action" | "valid-action";
  contentSha256?: string;
  actionName?: string;
  schemaErrors?: { path: string; message: string }[];
  recordedEventIndex?: number;
  recordedExecution: "event-recorded" | "not-recorded";
  recomputedCompile?: RecomputedCompile;
};

/** Diagnoses recorded replies without making model calls or changing the original grades. */
export async function diagnoseRecordedAttempt(
  fixture: Fixture,
  record: RecordedAttempt,
  selection: "product" | "frozen-v1" = "frozen-v1",
) {
  if (record.fixtureId && record.fixtureId !== fixture.id)
    throw new Error("Diagnostic fixture and recorded attempt do not match.");
  const loaded = await loadEvaluationRuntime(selection);
  const events = record.result?.events ?? [];
  const matchedEventIndices = new Set<number>();
  const replies: ReplyDiagnostic[] = [];
  let rawCompileReplies = 0;
  let emptyFinishReplies = 0;
  let revisionActionsWithoutTake = 0;
  for (const [callIndex, call] of record.calls.entries()) {
    const content = call.response?.content;
    if (typeof content !== "string") {
      replies.push({
        callIndex,
        status: "no-response",
        recordedExecution: "not-recorded",
      });
      continue;
    }
    const base = {
      callIndex,
      contentSha256: createHash("sha256").update(content).digest("hex"),
      recordedExecution: "not-recorded" as const,
    };
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      replies.push({ ...base, status: "invalid-json" });
      continue;
    }
    const actionName =
      raw !== null &&
      typeof raw === "object" &&
      "action" in raw &&
      typeof raw.action === "string"
        ? raw.action
        : undefined;
    rawCompileReplies += Number(actionName === "compile_candidate");
    const parsed = loaded.domain.AgentActionSchema.safeParse(raw);
    if (!parsed.success) {
      replies.push({
        ...base,
        actionName,
        status: "invalid-action",
        schemaErrors: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      continue;
    }
    const action = parsed.data;
    const eventIndex = events.findIndex(
      (event, index) =>
        !matchedEventIndices.has(index) &&
        isDeepStrictEqual(event.action, action),
    );
    if (eventIndex !== -1) matchedEventIndices.add(eventIndex);
    const reply: ReplyDiagnostic = {
      ...base,
      status: "valid-action",
      actionName: action.action,
      recordedExecution: eventIndex === -1 ? "not-recorded" : "event-recorded",
      ...(eventIndex === -1 ? {} : { recordedEventIndex: eventIndex }),
    };
    if (action.action === "compile_candidate") {
      const plan = loaded.domain.compilePlan(
        fixture.input.scene,
        fixture.input.gear,
        fixture.input.intent,
        action.recipeId,
        action.overrides,
      );
      reply.recomputedCompile = {
        provenance: "offline-recomputation",
        candidateId: plan.id,
        valid: plan.validation.valid,
        violationCodes: [
          ...new Set(plan.validation.violations.map((issue) => issue.code)),
        ].sort(),
      };
    }
    emptyFinishReplies += Number(
      action.action === "finish" && action.candidateIds.length === 0,
    );
    revisionActionsWithoutTake += Number(
      action.action === "propose_revision" ||
        action.action === "read_take_findings",
    );
    replies.push(reply);
  }
  const recomputedCompiles = replies.filter((reply) => reply.recomputedCompile);
  const violations: Record<string, number> = {};
  for (const reply of recomputedCompiles)
    for (const code of reply.recomputedCompile!.violationCodes)
      violations[code] = (violations[code] ?? 0) + 1;
  return {
    diagnosticsVersion,
    fixtureId: fixture.id,
    runtime: {
      selection,
      plannerVersion: loaded.runtime.plannerVersion,
      checkerVersion: loaded.checker.checkerVersion,
      sourceHashes: loaded.sourceHashes,
      sourceManifestSha256: loaded.sourceManifestSha256 ?? null,
    },
    replies,
    counts: {
      rawCalls: record.calls.length,
      noResponse: replies.filter((reply) => reply.status === "no-response")
        .length,
      invalidJson: replies.filter((reply) => reply.status === "invalid-json")
        .length,
      invalidActions: replies.filter(
        (reply) => reply.status === "invalid-action",
      ).length,
      validActions: replies.filter((reply) => reply.status === "valid-action")
        .length,
      rawCompileReplies,
      schemaValidCompileReplies: recomputedCompiles.length,
      recordedCompileEvents: events.filter(
        (event) =>
          (event.action as { action?: string })?.action === "compile_candidate",
      ).length,
      compileRepliesWithoutRecordedEvent: recomputedCompiles.filter(
        (reply) => reply.recordedExecution === "not-recorded",
      ).length,
      recomputedValidCompiles: recomputedCompiles.filter(
        (reply) => reply.recomputedCompile!.valid,
      ).length,
      recomputedInvalidCompiles: recomputedCompiles.filter(
        (reply) => !reply.recomputedCompile!.valid,
      ).length,
      emptyFinishReplies,
      revisionActionsWithoutTake,
      unmatchedRecordedEvents: events.length - matchedEventIndices.size,
    },
    recomputedViolationCounts: violations,
    recordedGrade: structuredClone(record.entry?.grade ?? null),
    recomputedLegacyGrade: record.result
      ? {
          provenance: "offline-recomputation",
          runtime: selection,
          checkerVersion: loaded.checker.checkerVersion,
          value: loaded.checker.gradeResult(
            fixture,
            record.result,
            record.entry?.arm ?? "unknown",
            record.calls.flatMap((call) =>
              typeof call.response?.content === "string"
                ? [call.response.content]
                : [],
            ),
          ),
        }
      : null,
    disclosure:
      "Development diagnostics only. Original records and scores are unchanged. A missing event does not establish whether a tool executed. Offline recompilation is separately labeled and does not establish historical execution. The legacy checker measures family match, not full preservation of a creative brief.",
  };
}
