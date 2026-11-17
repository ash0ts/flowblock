import { z } from "zod";
import { db, transaction } from "./db";
import { beginWorkflowAttempt, ownedWorkflow } from "./workflows";
import { createWorkflowTraceContext } from "./workflow-telemetry";
import { HttpError } from "./security";

export async function workerReady() {
  try {
    const r = await db().query(
      "SELECT EXISTS(SELECT 1 FROM worker_health WHERE ready AND heartbeat_at>now()-interval '90 seconds') AS ready",
    );
    return !!r.rows[0]?.ready;
  } catch {
    return false;
  }
}
export function idempotencyKey(request: Request) {
  const value = request.headers.get("Idempotency-Key");
  return value === null ? null : z.string().min(1).max(200).parse(value);
}
export async function reserveJob(
  ownerId: string,
  key: string | null,
  inputHash: string,
  kind: "plan" | "analysis",
  payload: Record<string, unknown>,
  jobId: string,
  takeId?: string,
) {
  return transaction(async (client) => {
    if (key) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `idempotency:${ownerId}:${key}`,
      ]);
      const existing = (
        await client.query(
          "SELECT * FROM jobs WHERE owner_id=$1 AND idempotency_key=$2",
          [ownerId, key],
        )
      ).rows[0];
      if (existing) {
        if (existing.kind !== kind || existing.payload.inputHash !== inputHash)
          throw new HttpError(
            409,
            "Idempotency key was already used with different inputs.",
          );
        return { job: existing, created: false };
      }
    }
    if (kind === "analysis") {
      const ready = (
        await client.query(
          "SELECT EXISTS(SELECT 1 FROM worker_health WHERE ready AND heartbeat_at>now()-interval '90 seconds') AS ready",
        )
      ).rows[0]?.ready;
      if (!ready)
        throw new HttpError(
          503,
          "The analysis worker is unavailable. Your uploaded take is saved; retry when the worker is ready.",
        );
    }
    let takeRow;
    if (takeId) {
      const live = (
        await client.query(
          "SELECT id,workflow_id,plan FROM takes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now() AND status='uploaded' FOR UPDATE",
          [takeId, ownerId],
        )
      ).rows[0];
      takeRow = live;
      if (!live)
        throw new HttpError(
          409,
          "The take changed before analysis could be queued.",
        );
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `${ownerId}:${kind}`,
    ]);
    const usage = (
      await client.query(
        "SELECT count(*) FROM usage_events WHERE owner_id=$1 AND kind=$2 AND created_at>now()-interval '1 day'",
        [ownerId, kind],
      )
    ).rows[0];
    if (Number(usage.count) >= 30)
      throw new HttpError(
        429,
        `Daily ${kind === "plan" ? "planning" : "analysis"} allowance reached.`,
      );
    await client.query(
      "INSERT INTO usage_events(owner_id,kind) VALUES($1,$2)",
      [ownerId, kind],
    );
    let workflowTrace;
    if (kind === "plan") {
      workflowTrace = await beginWorkflowAttempt(client, ownerId, {
        stage: "planning",
        jobId,
      });
    } else {
      const workflowId = await ownedWorkflow(
        client,
        ownerId,
        takeRow?.workflow_id ?? undefined,
      );
      if (takeRow && !takeRow.workflow_id)
        await client.query("UPDATE takes SET workflow_id=$2 WHERE id=$1", [
          takeId,
          workflowId,
        ]);
      const parent = (
        await client.query(
          `SELECT a.id FROM workflow_attempts a WHERE a.workflow_id=$1 AND a.status IN ('succeeded','needs_review') AND (
             (a.stage IN ('analysis','replay') AND a.take_id=$2) OR
             (a.stage='acceptance' AND a.summary->>'resultPlanId'=$3) OR
             (a.stage='planning' AND EXISTS (SELECT 1 FROM jobs j WHERE j.id=a.job_id AND j.result->'plans' @> $4::jsonb))
           ) ORDER BY a.started_at DESC LIMIT 1`,
          [
            workflowId,
            takeId,
            takeRow?.plan?.id,
            JSON.stringify([{ id: takeRow?.plan?.id }]),
          ],
        )
      ).rows[0];
      // Scheduling metadata is not an executed attempt. The worker allocates the
      // real attempt from its lease UUID when it claims this job.
      workflowTrace = createWorkflowTraceContext({
        workflowId,
        stage: "analysis",
        attempt: 1,
        jobId,
        takeId,
        planId: takeRow?.plan?.id,
        ...(parent ? { parentAttemptId: parent.id } : {}),
      });
    }
    const job = (
      await client.query(
        "INSERT INTO jobs(id,owner_id,kind,status,payload,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          jobId,
          ownerId,
          kind,
          kind === "plan" ? "running" : "queued",
          { ...payload, inputHash, workflowTrace },
          key,
        ],
      )
    ).rows[0];
    return { job, created: true };
  });
}
