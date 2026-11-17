import { randomUUID } from "node:crypto";
import * as weave from "weave";
import { z } from "zod";
import { boundedTelemetry, trace } from "./coordinator-runtime";

export const workflowAgentName = "FlowBlock workflow";
export const workflowTelemetryVersion = "flowblock-workflow-v1";
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** Persist this server-owned context with the operation before executing it. */
export const WorkflowTraceContextSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    workflowId: z.uuid(),
    stage: z.enum(["planning", "analysis", "revision", "acceptance", "replay"]),
    attemptId: z.uuid(),
    attempt: z.number().int().positive().max(1_000_000),
    parentAttemptId: z.uuid().optional(),
    jobId: z.uuid().optional(),
    planId: identifier.optional(),
    takeId: z.uuid().optional(),
  })
  .strict();
export type WorkflowTraceContext = z.infer<typeof WorkflowTraceContextSchema>;

/** Allocation is separate from execution; the caller owns DB atomicity and retries. */
export function createWorkflowTraceContext(
  input: Omit<
    WorkflowTraceContext,
    "schemaVersion" | "attemptId" | "workflowId"
  > & {
    workflowId?: string;
  },
): WorkflowTraceContext {
  return WorkflowTraceContextSchema.parse({
    ...input,
    schemaVersion: "1.0",
    workflowId: input.workflowId ?? randomUUID(),
    attemptId: randomUUID(),
  });
}

export function workflowAttributes(context: WorkflowTraceContext) {
  const parsed = WorkflowTraceContextSchema.parse(context);
  return {
    "flowblock.workflow_id": parsed.workflowId,
    "flowblock.stage": parsed.stage,
    "flowblock.attempt_id": parsed.attemptId,
    "flowblock.attempt": parsed.attempt,
    "flowblock.workflow_telemetry_version": workflowTelemetryVersion,
    ...(parsed.parentAttemptId
      ? { "flowblock.parent_attempt_id": parsed.parentAttemptId }
      : {}),
    ...(parsed.jobId ? { "flowblock.job_id": parsed.jobId } : {}),
    ...(parsed.planId ? { "flowblock.plan_id": parsed.planId } : {}),
    ...(parsed.takeId ? { "flowblock.take_id": parsed.takeId } : {}),
  };
}

// No free-form text, object keys, URLs, media, prompts, or provider errors.
export const WorkflowCompletionSchema = z
  .object({
    status: z.enum(["succeeded", "needs_review", "failed", "cancelled"]),
    source: z.enum(["forge", "library", "manual"]).optional(),
    resultPlanId: identifier.optional(),
    projectVersionId: z.uuid().optional(),
    measuredFrames: z.number().int().nonnegative().optional(),
    expectedFrames: z.number().int().nonnegative().optional(),
    findingCount: z.number().int().nonnegative().max(2).optional(),
  })
  .strict();
export type WorkflowCompletion = z.infer<typeof WorkflowCompletionSchema>;

let initialization: Promise<boolean> | undefined;
export async function initializeWorkflowTelemetry(): Promise<boolean> {
  if (
    !process.env.WANDB_API_KEY ||
    !process.env.WANDB_ENTITY ||
    process.env.FLOWBLOCK_TRACE === "0"
  )
    return false;
  initialization ??= weave
    .init(
      `${process.env.WANDB_ENTITY}/${process.env.WANDB_PROJECT || "flowblock"}`,
      { printCallLink: false },
    )
    .then(
      () => true,
      () => {
        initialization = undefined;
        return false;
      },
    );
  return initialization;
}

type StageOptions = {
  signal?: AbortSignal;
  initialize?: () => Promise<boolean>;
};

/** Trace an actual operation; telemetry never changes its result or original error. */
export async function runWorkflowStage<T>(
  context: WorkflowTraceContext,
  operation: () => Promise<T>,
  completion: (result: T) => WorkflowCompletion,
  options: StageOptions = {},
): Promise<T> {
  const parsed = WorkflowTraceContextSchema.safeParse(context);
  if (!parsed.success) return operation();
  return weave.runIsolated(async () => {
    const signal = options.signal ?? new AbortController().signal;
    const enabled = await boundedTelemetry(
      options.initialize ?? initializeWorkflowTelemetry,
      signal,
    );
    const conversation = enabled
      ? trace(() =>
          weave.startConversation({
            conversationId: parsed.data.workflowId,
            agentName: workflowAgentName,
            agentVersion: workflowTelemetryVersion,
            attributes: workflowAttributes(parsed.data),
          }),
        )
      : undefined;
    const turn = trace(() => conversation?.startTurn());
    try {
      const result = await operation();
      const summary = trace(() =>
        WorkflowCompletionSchema.parse(completion(result)),
      );
      trace(() => {
        turn?.setAttributes({
          "flowblock.stage_outcome": summary?.status ?? "unknown",
          ...(summary?.source
            ? { "flowblock.result_source": summary.source }
            : {}),
        });
        if (summary)
          turn?.record({
            outputMessages: [
              { role: "assistant", content: JSON.stringify(summary) },
            ],
          });
      });
      return result;
    } catch (error) {
      // Exception text can contain storage URLs, credentials, or media paths.
      const name = error instanceof Error ? error.name : "Error";
      const cancelled = name === "AbortError";
      const sanitized = new Error(
        cancelled ? "Workflow stage cancelled" : "Workflow stage failed",
      );
      sanitized.name = cancelled ? "AbortError" : "WorkflowStageError";
      trace(() => {
        turn?.setAttributes({
          "flowblock.stage_outcome": cancelled ? "cancelled" : "failed",
        });
        turn?.recordError(sanitized);
      });
      throw error;
    } finally {
      trace(() => turn?.end());
      trace(() => conversation?.end());
      if (enabled) await boundedTelemetry(() => weave.flushOTel(), signal);
    }
  });
}
