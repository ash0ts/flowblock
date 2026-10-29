import { z } from "zod";
import { db, transaction } from "./db";
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
    if (takeId) {
      const live = (
        await client.query(
          "SELECT id FROM takes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now() AND status='uploaded' FOR UPDATE",
          [takeId, ownerId],
        )
      ).rows[0];
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
    const job = (
      await client.query(
        "INSERT INTO jobs(id,owner_id,kind,status,payload,idempotency_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
        [
          jobId,
          ownerId,
          kind,
          kind === "plan" ? "running" : "queued",
          { ...payload, inputHash },
          key,
        ],
      )
    ).rows[0];
    return { job, created: true };
  });
}
