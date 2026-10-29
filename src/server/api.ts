import { randomUUID, randomBytes, createHash } from "node:crypto";
import { z } from "zod";
import { db, transaction, consumeQuota } from "./db";
import { HttpError, jsonBody, owner, sameOrigin, isLocal } from "./security";
import {
  localStorage,
  signedUpload,
  saveLocalUpload,
  objectSize,
  mediaResponse,
  deletePrefix,
} from "./storage";
import {
  PlanningInputSchema,
  recompilePlan,
  runPlanner,
  systemPrompt,
} from "./planner";
import {
  OverridesSchema,
  TakeAnalysisSchema,
  type PlanVersion,
} from "@/domain";
import { proposeRevision } from "./revision-planner";
import { AnalyzeSchema, UploadSchema, ProjectSchema } from "./api-contracts";
import { readTrainingSummary } from "./showcase";
const uuid = z.string().uuid();
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
const prefix = (ownerId: string, takeId: string) =>
  `owners/${ownerId}/takes/${takeId}/`;
async function take(id: string, ownerId: string) {
  uuid.parse(id);
  const r = await db().query(
    "SELECT * FROM takes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now()",
    [id, ownerId],
  );
  if (!r.rows[0]) throw new HttpError(404, "Take not found.");
  return r.rows[0];
}
async function workerReady() {
  try {
    const r = await db().query(
      "SELECT EXISTS(SELECT 1 FROM worker_health WHERE ready AND heartbeat_at>now()-interval '90 seconds') AS ready",
    );
    return !!r.rows[0]?.ready;
  } catch {
    return false;
  }
}
function idempotencyKey(request: Request) {
  const value = request.headers.get("Idempotency-Key");
  return value === null ? null : z.string().min(1).max(200).parse(value);
}
async function reserveJob(
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
export async function handleApi(request: Request): Promise<Response> {
  try {
    sameOrigin(request);
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/api\/?/, "");
    const method = request.method;
    if (pathname === "status" && method === "GET") {
      let database = false;
      let worker = false;
      try {
        if (process.env.DATABASE_URL) {
          await db().query("SELECT 1");
          database = true;
          worker = await workerReady();
        }
      } catch {}
      return json({
        inference: !!process.env.WANDB_API_KEY,
        storage: !!process.env.S3_BUCKET || localStorage(),
        database,
        worker,
        auth: !!process.env.AUTH_GOOGLE_ID,
        mode: isLocal(request) ? "local" : "connected",
        model: process.env.FLOWBLOCK_MODEL || "openai/gpt-oss-20b",
        training: { status: (await readTrainingSummary()).status },
        limitations: [
          ...(!worker ? ["Video analysis worker is not ready."] : []),
          ...(!process.env.S3_BUCKET
            ? ["Media is stored on this development machine."]
            : []),
          ...(!process.env.AUTH_GOOGLE_ID
            ? ["Google sign-in is not configured."]
            : []),
        ],
      });
    }
    if (pathname === "health" && method === "GET") return json({ ok: true });
    const ownerId = await owner(request);
    if (pathname === "plans" && method === "POST") {
      const input = PlanningInputSchema.parse(await jsonBody(request));
      const key = idempotencyKey(request),
        inputHash = createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex");
      const jobId = randomUUID(),
        reserved = await reserveJob(
          ownerId,
          key,
          inputHash,
          "plan",
          { input },
          jobId,
        );
      if (!reserved.created)
        return reserved.job.result
          ? json({ ...reserved.job.result, jobId: reserved.job.id })
          : json(
              {
                jobId: reserved.job.id,
                status: reserved.job.status,
                error: reserved.job.error,
              },
              reserved.job.status === "running" ? 202 : 409,
            );
      try {
        const result = await runPlanner(input);
        const published = await transaction(async (client) => {
          const update = await client.query(
            "UPDATE jobs SET status='succeeded',result=$2,updated_at=now() WHERE id=$1 AND status='running' AND cancelled_at IS NULL RETURNING id",
            [jobId, result],
          );
          if (!update.rowCount) return false;
          for (const plan of result.plans)
            await client.query(
              "INSERT INTO plan_versions(id,owner_id,plan,provenance) VALUES($1,$2,$3,$4)",
              [
                randomUUID(),
                ownerId,
                plan,
                {
                  jobId,
                  source: result.source,
                  model: result.model || null,
                  plannerVersion: result.plannerVersion,
                  engineVersion: plan.validation.model,
                  promptHash: createHash("sha256")
                    .update(systemPrompt)
                    .digest("hex"),
                  traceId: result.traceId || null,
                },
              ],
            );
          return true;
        });
        if (!published)
          throw new HttpError(409, "Planning was cancelled before completion.");
        return json({ ...result, jobId });
      } catch (error) {
        await db().query(
          "UPDATE jobs SET status='failed',error='Planning did not complete. Retry with a new request key.',updated_at=now() WHERE id=$1 AND status='running'",
          [jobId],
        );
        throw error;
      }
    }
    if (pathname === "uploads" && method === "POST") {
      const body = UploadSchema.parse(await jsonBody(request));
      const plan = recompilePlan(body.plan);
      if (!plan.validation.valid)
        throw new HttpError(
          422,
          "Fix the plan constraints before associating a rehearsal.",
        );
      if (!(await consumeQuota(ownerId, "upload", 20)))
        throw new HttpError(429, "Daily upload allowance reached.");
      const takeId = randomUUID();
      const objectKey = `${prefix(ownerId, takeId)}original`;
      const uploadUrl = await signedUpload(
        objectKey,
        body.contentType,
        body.sizeBytes,
        takeId,
        url.origin,
      );
      await db().query(
        "INSERT INTO takes(id,owner_id,object_key,file_name,size_bytes,mime_type,plan,training_consent) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          takeId,
          ownerId,
          objectKey,
          body.fileName,
          body.sizeBytes,
          body.contentType,
          plan,
          body.trainingConsent,
        ],
      );
      return json({
        takeId,
        uploadUrl,
        method: "PUT",
        headers: {
          "Content-Type": body.contentType,
          ...(!localStorage() ? { "If-None-Match": "*" } : {}),
        },
      });
    }
    let match: RegExpMatchArray | null;
    if (
      (match = pathname.match(/^takes\/([^/]+)\/upload$/)) &&
      method === "PUT"
    ) {
      if (!localStorage())
        throw new HttpError(404, "Direct local uploads are disabled.");
      const row = await take(match[1], ownerId);
      if (row.status !== "uploading")
        throw new HttpError(409, "This upload has already completed.");
      await saveLocalUpload(
        row.object_key,
        request,
        Number(row.size_bytes),
        async (commit) =>
          transaction(async (client) => {
            const locked = (
              await client.query(
                "SELECT status FROM takes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now() FOR UPDATE",
                [row.id, ownerId],
              )
            ).rows[0];
            if (!locked)
              throw new HttpError(
                410,
                "This take was deleted or expired during upload.",
              );
            if (locked.status !== "uploading")
              throw new HttpError(409, "This upload has already completed.");
            await commit();
            await client.query(
              "UPDATE takes SET status='uploaded' WHERE id=$1",
              [row.id],
            );
          }),
      );
      return json({ uploaded: true });
    }
    if (
      (match = pathname.match(/^uploads\/([^/]+)\/complete$/)) &&
      method === "POST"
    ) {
      const row = await take(match[1], ownerId);
      const size = await objectSize(row.object_key).catch(() => undefined);
      if (size !== Number(row.size_bytes))
        throw new HttpError(
          409,
          "Video upload is incomplete. Retry the upload before analysis.",
        );
      const completed = await db().query(
        "UPDATE takes SET status='uploaded' WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now() AND status IN ('uploading','uploaded') RETURNING id",
        [row.id, ownerId],
      );
      if (!completed.rowCount)
        throw new HttpError(
          409,
          "The take changed before upload could complete.",
        );
      return json({ takeId: row.id });
    }
    if (
      (match = pathname.match(/^takes\/([^/]+)\/analyze$/)) &&
      method === "POST"
    ) {
      const row = await take(match[1], ownerId);
      if (row.status === "uploading")
        throw new HttpError(409, "Complete the upload first.");
      const input = AnalyzeSchema.parse(await jsonBody(request));
      const inputHash = createHash("sha256")
        .update(JSON.stringify({ takeId: row.id, input }))
        .digest("hex");
      const idempotency = idempotencyKey(request) || inputHash;
      const jobId = randomUUID();
      const plan = row.plan as PlanVersion;
      const payload = {
        ...input,
        jobId,
        takeId: row.id,
        planId: plan.id,
        planVersion: plan.schemaVersion,
        videoObjectKey: row.object_key,
        outputPrefix: `${prefix(ownerId, row.id)}analyses/${jobId}/`,
        plannedDurationSeconds: plan.durationSeconds,
        ...(!input.target && !input.targetKeyframes
          ? {
              targetTimeBasis: "normalized-phase",
              targetKeyframes: plan.keyframes.map((k) => ({
                timeSeconds: k.timeSeconds,
                ...k.framingBox,
              })),
            }
          : {}),
      };
      const reserved = await reserveJob(
        ownerId,
        idempotency,
        inputHash,
        "analysis",
        payload,
        jobId,
        row.id,
      );
      return json(
        { jobId: reserved.job.id, status: reserved.job.status },
        reserved.created ? 202 : 200,
      );
    }
    if ((match = pathname.match(/^jobs\/([^/]+)$/))) {
      uuid.parse(match[1]);
      const row = (
        await db().query(
          "SELECT id,status,result,error,kind,created_at FROM jobs WHERE id=$1 AND owner_id=$2",
          [match[1], ownerId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "Job not found.");
      if (method === "GET") return json(row);
      if (method === "DELETE") {
        await db().query(
          "UPDATE jobs SET status='cancelled',cancelled_at=now(),lease_token=NULL,updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
          [row.id],
        );
        return json({ cancelled: true });
      }
    }
    if (
      (match = pathname.match(/^takes\/([^/]+)\/media$/)) &&
      (method === "GET" || method === "HEAD")
    ) {
      const row = await take(match[1], ownerId);
      const artifact = url.searchParams.get("artifact");
      if (!artifact || artifact === "original")
        return mediaResponse(row.object_key, row.mime_type, request);
      const jobs = await db().query(
        "SELECT result FROM jobs WHERE owner_id=$1 AND kind='analysis' AND payload->>'takeId'=$2 AND status IN ('succeeded','needs_review') ORDER BY created_at DESC",
        [ownerId, row.id],
      );
      for (const job of jobs.rows) {
        const a = TakeAnalysisSchema.safeParse(job.result);
        if (!a.success) continue;
        const analysis = a.data;
        const allowed = [
          analysis.artifacts.proxyObjectKey,
          ...analysis.findings.flatMap(
            (f) => f.evidence?.map((e) => e.objectKey) || [],
          ),
        ];
        const key =
          artifact === "proxy" ? analysis.artifacts.proxyObjectKey : artifact;
        if (allowed.includes(key) && key.startsWith(prefix(ownerId, row.id)))
          return mediaResponse(
            key,
            key.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
            request,
          );
      }
      throw new HttpError(404, "Media artifact not found.");
    }
    if ((match = pathname.match(/^takes\/([^/]+)$/)) && method === "DELETE") {
      const row = await take(match[1], ownerId);
      await transaction(async (client) => {
        await client.query(
          "UPDATE takes SET deleted_at=now(),file_name='deleted',plan='{}'::jsonb,training_consent=false WHERE id=$1",
          [row.id],
        );
        await client.query(
          "UPDATE jobs SET status='cancelled',cancelled_at=now(),lease_token=NULL,result=NULL,error=NULL,payload=jsonb_build_object('takeId',$2::text,'deleted',true),updated_at=now() WHERE owner_id=$1 AND payload->>'takeId'=$2",
          [ownerId, row.id],
        );
      });
      await deletePrefix(prefix(ownerId, row.id));
      return json({ deleted: true });
    }
    if (pathname === "revisions" && method === "POST") {
      const body = z
        .object({
          plan: z.unknown(),
          analysis: z.object({ jobId: z.string().uuid() }).passthrough(),
          overrides: OverridesSchema.optional(),
          findingIds: z.array(z.string()).optional(),
        })
        .strict()
        .parse(await jsonBody(request));
      const plan = recompilePlan(body.plan);
      const row = (
        await db().query(
          "SELECT result FROM jobs WHERE id=$1 AND owner_id=$2 AND kind='analysis' AND status IN ('succeeded','needs_review')",
          [body.analysis.jobId, ownerId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "Saved analysis not found.");
      const analysis = TakeAnalysisSchema.parse(row.result);
      const sourceTake = await take(analysis.takeId, ownerId);
      if (
        analysis.planId !== plan.id ||
        JSON.stringify(recompilePlan(sourceTake.plan)) !== JSON.stringify(plan)
      )
        throw new HttpError(
          409,
          "This analysis belongs to a different plan version.",
        );
      if (!analysis.findings.length)
        throw new HttpError(422, "There is no measured finding to revise.");
      let proposal;
      try {
        proposal = await proposeRevision(plan, analysis, {
          overrides: body.overrides,
          findingIds: body.findingIds,
        });
      } catch (error) {
        throw new HttpError(
          422,
          error instanceof Error
            ? error.message
            : "No feasible revision was found.",
        );
      }
      const revisionId = randomUUID();
      await db().query(
        "INSERT INTO revisions(id,owner_id,parent_plan_id,plan,finding_ids,reason,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          revisionId,
          ownerId,
          plan.id,
          proposal.plan,
          JSON.stringify(proposal.findingIds),
          proposal.reason,
          {
            source: proposal.source,
            model: proposal.model || null,
            traceId: proposal.traceId || null,
            analysisJobId: analysis.jobId,
            engineVersion: proposal.plan.validation.model,
            revisionVersion: "revision-v1",
            events: proposal.events,
          },
        ],
      );
      return json({ ...proposal, revisionId, parentPlanId: plan.id });
    }
    if (
      (match = pathname.match(/^revisions\/([^/]+)\/accept$/)) &&
      method === "POST"
    ) {
      uuid.parse(match[1]);
      const body = z
        .object({ currentPlanId: z.string() })
        .parse(await jsonBody(request));
      const row = (
        await db().query(
          "SELECT * FROM revisions WHERE id=$1 AND owner_id=$2",
          [match[1], ownerId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "Revision not found.");
      if (row.parent_plan_id !== body.currentPlanId)
        throw new HttpError(
          409,
          "The plan changed after this revision was proposed.",
        );
      await db().query("UPDATE revisions SET accepted_at=now() WHERE id=$1", [
        row.id,
      ]);
      return json({ plan: row.plan, accepted: true });
    }
    if (pathname === "shares" && method === "POST") {
      const body = z
        .object({ plan: z.unknown() })
        .parse(await jsonBody(request));
      const plan = recompilePlan(body.plan);
      const token = randomBytes(24).toString("base64url");
      await db().query(
        "INSERT INTO shares(token,owner_id,plan) VALUES($1,$2,$3)",
        [token, ownerId, plan],
      );
      return json({
        token,
        url: `${process.env.APP_URL || url.origin}/s/${token}`,
      });
    }
    if (
      (match = pathname.match(/^shares\/([A-Za-z0-9_-]+)$/)) &&
      method === "DELETE"
    ) {
      await db().query(
        "UPDATE shares SET revoked_at=now() WHERE token=$1 AND owner_id=$2",
        [match[1], ownerId],
      );
      return json({ revoked: true });
    }
    if (pathname === "projects" && method === "POST") {
      const body = ProjectSchema.parse(await jsonBody(request));
      if (!body.projectId && body.expectedVersionId != null)
        throw new HttpError(
          400,
          "A new project cannot reference an existing parent version.",
        );
      const plan = recompilePlan(body.plan);
      const projectId = body.projectId || randomUUID(),
        versionId = randomUUID();
      await transaction(async (client) => {
        if (body.projectId) {
          const r = await client.query(
            "SELECT current_version_id FROM projects WHERE id=$1 AND owner_id=$2 FOR UPDATE",
            [projectId, ownerId],
          );
          if (!r.rows[0]) throw new HttpError(404, "Project not found.");
          if (r.rows[0].current_version_id !== body.expectedVersionId)
            throw new HttpError(
              409,
              "This project has a newer version. Keep your draft and reload.",
            );
        } else
          await client.query(
            "INSERT INTO projects(id,owner_id,name) VALUES($1,$2,$3)",
            [projectId, ownerId, body.name],
          );
        await client.query(
          "INSERT INTO plan_versions(id,project_id,owner_id,parent_id,plan) VALUES($1,$2,$3,$4,$5)",
          [versionId, projectId, ownerId, body.expectedVersionId || null, plan],
        );
        await client.query(
          "UPDATE projects SET current_version_id=$2,updated_at=now() WHERE id=$1",
          [projectId, versionId],
        );
      });
      return json({ projectId, versionId });
    }
    if (pathname === "projects" && method === "GET") {
      const result = await db().query(
        "SELECT p.id,p.name,p.current_version_id,p.updated_at,v.plan FROM projects p LEFT JOIN plan_versions v ON v.id=p.current_version_id WHERE p.owner_id=$1 ORDER BY p.updated_at DESC LIMIT 100",
        [ownerId],
      );
      return json({ projects: result.rows });
    }
    throw new HttpError(404, "Endpoint not found.");
  } catch (error) {
    if (error instanceof z.ZodError)
      return json(
        {
          error: "Invalid request.",
          details: error.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        },
        400,
      );
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    const message = error instanceof Error ? error.message : "";
    if (message === "DATABASE_NOT_CONFIGURED")
      return json(
        {
          error:
            "Connected storage is not configured. Local planning remains available.",
        },
        503,
      );
    console.error(
      "FlowBlock request failed:",
      error instanceof Error ? error.name : "UnknownError",
    );
    return json(
      {
        error: "The request could not complete. Your local draft is preserved.",
      },
      500,
    );
  }
}
