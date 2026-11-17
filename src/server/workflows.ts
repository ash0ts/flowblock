import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { db } from "./db";
import { HttpError } from "./security";
import {
  createWorkflowTraceContext,
  WorkflowCompletionSchema,
  type WorkflowCompletion,
  type WorkflowTraceContext,
} from "./workflow-telemetry";

export async function ownedWorkflow(
  client: PoolClient,
  ownerId: string,
  id?: string,
) {
  if (id) {
    const row = await client.query(
      "SELECT id FROM workflows WHERE id=$1 AND owner_id=$2 FOR UPDATE",
      [id, ownerId],
    );
    if (!row.rowCount) throw new HttpError(404, "Workflow not found.");
    return id;
  }
  const created = randomUUID();
  await client.query("INSERT INTO workflows(id,owner_id) VALUES($1,$2)", [
    created,
    ownerId,
  ]);
  return created;
}

/** Call inside the same transaction as the operation reservation. */
export async function beginWorkflowAttempt(
  client: PoolClient,
  ownerId: string,
  input: Pick<WorkflowTraceContext, "stage"> &
    Partial<
      Pick<
        WorkflowTraceContext,
        "workflowId" | "parentAttemptId" | "jobId" | "planId" | "takeId"
      >
    >,
) {
  const workflowId = await ownedWorkflow(client, ownerId, input.workflowId);
  const count = await client.query(
    "SELECT count(*)::int AS n FROM workflow_attempts WHERE workflow_id=$1 AND stage=$2",
    [workflowId, input.stage],
  );
  const context = createWorkflowTraceContext({
    ...input,
    workflowId,
    attempt: count.rows[0].n + 1,
  });
  await client.query(
    "INSERT INTO workflow_attempts(id,workflow_id,stage,attempt,parent_attempt_id,job_id,plan_id,take_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      context.attemptId,
      workflowId,
      context.stage,
      context.attempt,
      context.parentAttemptId ?? null,
      context.jobId ?? null,
      context.planId ?? null,
      context.takeId ?? null,
    ],
  );
  return context;
}

export async function finishWorkflowAttempt(
  context: WorkflowTraceContext,
  completion: WorkflowCompletion,
  client?: PoolClient,
) {
  const summary = WorkflowCompletionSchema.parse(completion);
  await (client ?? db()).query(
    "UPDATE workflow_attempts SET status=$2,summary=$3,ended_at=now() WHERE id=$1 AND status='running'",
    [context.attemptId, summary.status, summary],
  );
}

/** Only non-sensitive execution metadata; ownership is enforced by the join. */
export async function readWorkflow(ownerId: string, workflowId: string) {
  const workflow = await db().query(
    "SELECT id,created_at FROM workflows WHERE id=$1 AND owner_id=$2",
    [workflowId, ownerId],
  );
  if (!workflow.rowCount) throw new HttpError(404, "Workflow not found.");
  const attempts = await db().query(
    "SELECT a.id,a.stage,a.attempt,a.parent_attempt_id,a.job_id,a.plan_id,a.take_id,a.status,a.started_at,a.ended_at,a.summary FROM workflow_attempts a JOIN workflows w ON w.id=a.workflow_id WHERE a.workflow_id=$1 AND w.owner_id=$2 ORDER BY a.started_at,a.id",
    [workflowId, ownerId],
  );
  return { ...workflow.rows[0], attempts: attempts.rows };
}
