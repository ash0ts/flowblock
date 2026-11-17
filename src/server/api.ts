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
import {
  proposeRevision,
  revisionVersion,
  RevisionAbstainedError,
} from "./revision-planner";
import { AnalyzeSchema, UploadSchema, ProjectSchema } from "./api-contracts";
import { readTrainingSummary } from "./showcase";
import { idempotencyKey, reserveJob, workerReady } from "./jobs";
import { getTake as take, takePrefix as prefix, deleteTake } from "./takes";
import {
  beginWorkflowAttempt,
  finishWorkflowAttempt,
  ownedWorkflow,
  readWorkflow,
} from "./workflows";
import {
  runWorkflowStage,
  WorkflowTraceContextSchema,
  type WorkflowTraceContext,
} from "./workflow-telemetry";
const uuid = z.string().uuid();
const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
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
                workflowId:
                  reserved.job.payload.workflowTrace?.workflowId ?? null,
              },
              reserved.job.status === "running" ? 202 : 409,
            );
      try {
        const workflowTrace = WorkflowTraceContextSchema.parse(
          reserved.job.payload.workflowTrace,
        );
        const result = {
          ...(await runPlanner(input, { workflowTrace })),
          workflowId: workflowTrace.workflowId,
        };
        const published = await transaction(async (client) => {
          const update = await client.query(
            "UPDATE jobs SET status='succeeded',result=$2,updated_at=now() WHERE id=$1 AND status='running' AND cancelled_at IS NULL RETURNING id",
            [jobId, result],
          );
          if (!update.rowCount) return false;
          await finishWorkflowAttempt(
            workflowTrace,
            {
              status:
                result.source === "forge" && result.outcome === "completed"
                  ? "succeeded"
                  : "needs_review",
              source: result.source,
            },
            client,
          );
          for (const plan of result.plans)
            await client.query(
              "INSERT INTO plan_versions(id,owner_id,plan,provenance) VALUES($1,$2,$3,$4)",
              [
                randomUUID(),
                ownerId,
                plan,
                {
                  jobId,
                  workflowId: workflowTrace.workflowId,
                  source: result.source,
                  model: result.model || null,
                  plannerVersion: result.plannerVersion,
                  engineVersion: plan.engineVersion,
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
        await finishWorkflowAttempt(reserved.job.payload.workflowTrace, {
          status:
            error instanceof HttpError && error.status === 409
              ? "cancelled"
              : "failed",
        });
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
      );
      const workflowId = await transaction(async (client) => {
        const workflowId = await ownedWorkflow(
          client,
          ownerId,
          body.workflowId,
        );
        await client.query(
          "INSERT INTO takes(id,owner_id,object_key,file_name,size_bytes,mime_type,plan,training_consent,workflow_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            takeId,
            ownerId,
            objectKey,
            body.fileName,
            body.sizeBytes,
            body.contentType,
            plan,
            body.trainingConsent,
            workflowId,
          ],
        );
        return workflowId;
      });
      return json({
        takeId,
        workflowId,
        uploadUrl,
        method: "PUT",
        headers: {
          "Content-Type": body.contentType,
          ...(!localStorage() ? { "If-None-Match": "*" } : {}),
        },
      });
    }
    let match: RegExpMatchArray | null;
    if ((match = pathname.match(/^workflows\/([^/]+)$/)) && method === "GET") {
      return json(await readWorkflow(ownerId, uuid.parse(match[1])));
    }
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
        {
          jobId: reserved.job.id,
          status: reserved.job.status,
          workflowId: reserved.job.payload.workflowTrace?.workflowId ?? null,
        },
        reserved.created ? 202 : 200,
      );
    }
    if ((match = pathname.match(/^jobs\/([^/]+)$/))) {
      uuid.parse(match[1]);
      const row = (
        await db().query(
          "SELECT id,status,result,error,kind,created_at,payload->>'takeId' AS take_id,payload->'workflowTrace'->>'workflowId' AS \"workflowId\" FROM jobs WHERE id=$1 AND owner_id=$2",
          [match[1], ownerId],
        )
      ).rows[0];
      if (!row) throw new HttpError(404, "Job not found.");
      if (method === "GET") {
        if (row.kind === "analysis" && row.result)
          await take(row.take_id, ownerId);
        const { take_id: _takeId, ...publicJob } = row;
        void _takeId;
        return json(publicJob);
      }
      if (method === "DELETE") {
        const result = await transaction(async (client) => {
          const current = (
            await client.query(
              "SELECT status FROM jobs WHERE id=$1 AND owner_id=$2 FOR UPDATE",
              [row.id, ownerId],
            )
          ).rows[0];
          if (!["queued", "running"].includes(current.status))
            return {
              cancelled: current.status === "cancelled",
              status: current.status,
            };
          await client.query(
            "UPDATE jobs SET status='cancelled',cancelled_at=now(),lease_token=NULL,updated_at=now() WHERE id=$1",
            [row.id],
          );
          await client.query(
            "UPDATE workflow_attempts SET status='cancelled',ended_at=now(),summary=jsonb_build_object('status','cancelled') WHERE job_id=$1 AND status='running'",
            [row.id],
          );
          return { cancelled: true, status: "cancelled" };
        });
        return json(result);
      }
    }
    if (
      (match = pathname.match(/^takes\/([^/]+)\/media$/)) &&
      (method === "GET" || method === "HEAD")
    ) {
      const row = await take(match[1], ownerId);
      const artifact = url.searchParams.get("artifact");
      if (!artifact || artifact === "original")
        return await mediaResponse(row.object_key, row.mime_type, request);
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
          return await mediaResponse(
            key,
            key.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
            request,
          );
      }
      throw new HttpError(404, "Media artifact not found.");
    }
    if ((match = pathname.match(/^takes\/([^/]+)$/)) && method === "DELETE") {
      await deleteTake(match[1], ownerId);
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
          "SELECT result,payload FROM jobs WHERE id=$1 AND owner_id=$2 AND kind='analysis' AND status IN ('succeeded','needs_review')",
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
      if (!(await consumeQuota(ownerId, "revision", 30)))
        throw new HttpError(429, "Daily revision allowance reached.");
      const workflowTrace = await transaction(async (client) => {
        const live = (
          await client.query(
            "SELECT workflow_id FROM takes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now() FOR UPDATE",
            [sourceTake.id, ownerId],
          )
        ).rows[0];
        if (!live)
          throw new HttpError(410, "The source take is no longer available.");
        const workflowId = await ownedWorkflow(
          client,
          ownerId,
          live.workflow_id ?? undefined,
        );
        if (!live.workflow_id)
          await client.query("UPDATE takes SET workflow_id=$2 WHERE id=$1", [
            sourceTake.id,
            workflowId,
          ]);
        const parent = (
          await client.query(
            "SELECT id FROM workflow_attempts WHERE job_id=$1 AND stage IN ('analysis','replay') AND status IN ('succeeded','needs_review') ORDER BY started_at DESC LIMIT 1",
            [analysis.jobId],
          )
        ).rows[0];
        return beginWorkflowAttempt(client, ownerId, {
          workflowId,
          stage: "revision",
          jobId: analysis.jobId,
          takeId: sourceTake.id,
          planId: plan.id,
          ...(parent ? { parentAttemptId: parent.id } : {}),
        });
      });
      let proposal;
      try {
        proposal = await proposeRevision(plan, analysis, {
          overrides: body.overrides,
          findingIds: body.findingIds,
          workflowTrace,
        });
      } catch (error) {
        await finishWorkflowAttempt(workflowTrace, {
          status:
            error instanceof RevisionAbstainedError ? "needs_review" : "failed",
          ...(error instanceof RevisionAbstainedError
            ? { source: "forge" as const }
            : {}),
        });
        if (error instanceof RevisionAbstainedError)
          return json(
            {
              error: error.message,
              outcome: "abstained",
              reason: error.reason,
              findingIds: error.findingIds,
              source: error.source,
              model: error.model,
              traceId: error.traceId,
              workflowId: workflowTrace.workflowId,
            },
            422,
          );
        throw new HttpError(
          422,
          error instanceof Error
            ? error.message
            : "No feasible revision was found.",
        );
      }
      const revisionId = randomUUID();
      try {
        await transaction(async (client) => {
          const live = await client.query(
            "SELECT id FROM takes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now() FOR UPDATE",
            [sourceTake.id, ownerId],
          );
          if (!live.rowCount)
            throw new HttpError(
              410,
              "The take was deleted or expired while its revision was being prepared.",
            );
          await client.query(
            "INSERT INTO revisions(id,owner_id,parent_plan_id,plan,finding_ids,reason,provenance) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              revisionId,
              ownerId,
              plan.id,
              proposal.plan,
              JSON.stringify(proposal.findingIds),
              proposal.reason,
              {
                workflowTrace,
                source: proposal.source,
                model: proposal.model || null,
                traceId: proposal.traceId || null,
                analysisJobId: analysis.jobId,
                engineVersion: proposal.plan.engineVersion,
                revisionVersion,
                events: proposal.events,
              },
            ],
          );
          await finishWorkflowAttempt(
            workflowTrace,
            {
              status:
                proposal.source === "library" ? "needs_review" : "succeeded",
              source: proposal.source,
              resultPlanId: proposal.plan.id,
            },
            client,
          );
        });
      } catch (error) {
        await finishWorkflowAttempt(workflowTrace, { status: "failed" });
        throw error;
      }
      return json({
        ...proposal,
        revisionId,
        parentPlanId: plan.id,
        workflowId: workflowTrace.workflowId,
      });
    }
    if (
      (match = pathname.match(/^revisions\/([^/]+)\/accept$/)) &&
      method === "POST"
    ) {
      uuid.parse(match[1]);
      const body = z
        .object({ currentPlanId: z.string() })
        .parse(await jsonBody(request));
      const revisionId = match[1];
      const prior = (
        await db().query(
          "SELECT provenance,accepted_at FROM revisions WHERE id=$1 AND owner_id=$2",
          [revisionId, ownerId],
        )
      ).rows[0];
      const proposalContext = WorkflowTraceContextSchema.safeParse(
        prior?.provenance?.workflowTrace,
      );
      const workflowTrace: WorkflowTraceContext | undefined =
        proposalContext.success && !prior?.accepted_at
          ? await transaction(async (client) => {
              const live = await client.query(
                "SELECT id FROM takes WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL AND expires_at>now() FOR UPDATE",
                [proposalContext.data.takeId, ownerId],
              );
              if (!live.rowCount)
                throw new HttpError(
                  409,
                  "The source take is no longer available.",
                );
              return beginWorkflowAttempt(client, ownerId, {
                ...proposalContext.data,
                stage: "acceptance",
                parentAttemptId: proposalContext.data.attemptId,
              });
            })
          : undefined;
      const accept = () =>
        transaction(async (client) => {
          const row = (
            await client.query(
              "SELECT * FROM revisions WHERE id=$1 AND owner_id=$2",
              [revisionId, ownerId],
            )
          ).rows[0];
          if (!row) throw new HttpError(404, "Revision not found.");
          if (row.parent_plan_id !== body.currentPlanId)
            throw new HttpError(
              409,
              "The plan changed after this revision was proposed.",
            );
          const analysisJobId = uuid.safeParse(row.provenance.analysisJobId);
          if (!analysisJobId.success)
            throw new HttpError(
              409,
              "The source evidence for this revision is unavailable.",
            );
          // Use the same take-before-revision lock order as deletion. Acceptance
          // cannot return a cached revision after its evidence has been removed.
          const live = await client.query(
            "SELECT t.id FROM takes t JOIN jobs j ON j.payload->>'takeId'=t.id::text WHERE j.id=$1 AND j.owner_id=$2 AND t.owner_id=$2 AND t.deleted_at IS NULL AND t.expires_at>now() AND j.status IN ('succeeded','needs_review') FOR UPDATE OF t",
            [analysisJobId.data, ownerId],
          );
          if (!live.rowCount)
            throw new HttpError(
              409,
              "The take was deleted or expired. This revision can no longer be accepted.",
            );
          const accepted = await client.query(
            "UPDATE revisions SET accepted_at=COALESCE(accepted_at,now()) WHERE id=$1 AND owner_id=$2 RETURNING plan",
            [row.id, ownerId],
          );
          if (!accepted.rowCount)
            throw new HttpError(404, "Revision not found.");
          if (workflowTrace)
            await finishWorkflowAttempt(
              workflowTrace,
              { status: "succeeded", resultPlanId: accepted.rows[0].plan.id },
              client,
            );
          return accepted.rows[0].plan;
        });
      let acceptedPlan;
      try {
        acceptedPlan = workflowTrace
          ? await runWorkflowStage(workflowTrace, accept, (plan) => ({
              status: "succeeded",
              resultPlanId: plan.id,
            }))
          : await accept();
      } catch (error) {
        if (workflowTrace)
          await finishWorkflowAttempt(workflowTrace, { status: "failed" });
        throw error;
      }
      return json({
        plan: acceptedPlan,
        accepted: true,
        workflowId: proposalContext.success
          ? proposalContext.data.workflowId
          : null,
      });
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
          "UPDATE projects SET current_version_id=$2,name=$3,updated_at=now() WHERE id=$1",
          [projectId, versionId, body.name],
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
