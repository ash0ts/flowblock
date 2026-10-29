import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("@/auth", () => ({ auth: vi.fn() }));
import * as storage from "../src/server/storage";
import * as revisionPlanner from "../src/server/revision-planner";
import { cleanupMedia } from "../src/server/maintenance";
import { handleApi } from "../src/server/api";
import {
  defaultGear,
  defaultIntent,
  defaultScene,
  planShots,
  type TakeAnalysis,
} from "../src/domain";
const dsn = process.env.FLOWBLOCK_TEST_DATABASE_URL || process.env.DATABASE_URL;
const suite = dsn ? describe : describe.skip;
const owner = "local-developer",
  plan = planShots(defaultScene, defaultGear, defaultIntent).find(
    (p) => p.validation.valid,
  )!;
const input = {
  scene: defaultScene,
  gear: defaultGear,
  intent: defaultIntent,
  prompt: "API transaction fixture",
};
const annotation = {
  seed: { timeSeconds: 2, box: { x: 0.4, y: 0.3, width: 0.2, height: 0.4 } },
  expectedVisible: { startSeconds: 0, endSeconds: 5 },
};
const request = (route: string, body: unknown, key?: string) =>
  new Request(`http://localhost:3037/api/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });

suite("API transactions against disposable PostgreSQL schema", () => {
  let admin: Pool, pool: Pool, schema: string, directory: string;
  const globalDb = globalThis as unknown as { flowblockPool?: Pool };
  beforeAll(async () => {
    admin = new Pool({ connectionString: dsn });
    schema = `api_test_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({
      connectionString: dsn,
      options: `-csearch_path=${schema}`,
      max: 8,
    });
    globalDb.flowblockPool = pool;
    await pool.query(await readFile("migrations/001_initial.sql", "utf8"));
    directory = await mkdtemp(path.join(tmpdir(), "flowblock-api-db-"));
    vi.stubEnv("DATABASE_URL", dsn!);
    vi.stubEnv("FLOWBLOCK_LOCAL_MODE", "1");
    vi.stubEnv("FLOWBLOCK_STORAGE_DIR", directory);
    vi.stubEnv("S3_BUCKET", "");
    vi.stubEnv("WANDB_API_KEY", "");
  });
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE jobs,takes,usage_events,plan_versions,worker_health,projects,revisions,shares CASCADE",
    );
    await pool.query(
      "INSERT INTO worker_health(worker_id,device,model,ready) VALUES('test-health','cpu','health-fixture-only',true)",
    );
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    delete globalDb.flowblockPool;
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    await rm(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function take(takeOwner = owner, status = "uploaded") {
    const id = randomUUID(),
      key = `owners/${takeOwner}/takes/${id}/original`;
    await pool.query(
      "INSERT INTO takes(id,owner_id,object_key,file_name,size_bytes,mime_type,status,plan) VALUES($1,$2,$3,'fixture.mp4',10,'video/mp4',$4,$5)",
      [id, takeOwner, key, status, plan],
    );
    return { id, key };
  }

  async function completedAnalysis(takeId: string) {
    const id = randomUUID();
    const analysis: TakeAnalysis = {
      schemaVersion: "1.0",
      analysisSpace: "upright-normalized-image",
      jobId: id,
      takeId,
      planId: plan.id,
      planVersion: "1.0",
      summary: "Synthetic API fixture, not a model run.",
      provenance: {
        model: "SAM 2.1 Small",
        repositoryCommit: "fixture",
        checkpointSha256: "fixture",
        device: "cpu",
        realInference: true,
        rulesVersion: "framing-v1",
        generatedAt: "2026-10-29T00:00:00Z",
      },
      video: {
        durationSeconds: 5,
        sourceWidth: 640,
        sourceHeight: 360,
        rotationDegrees: 0,
        width: 640,
        height: 360,
        codec: "h264",
        fps: 15,
        sampledFrames: 75,
        sourceStartPtsSeconds: 0,
        timestampMapping: "nearest-source-presentation-timestamp",
        timeMap: [],
      },
      tracks: [],
      coverage: {
        expectedFrames: 75,
        measuredFrames: 75,
        missingFrames: 0,
        uncertainFrames: 0,
        intentionallyHiddenFrames: 0,
        measuredFraction: 1,
        needsReview: false,
      },
      findings: [
        {
          kind: "duration",
          phase: "whole",
          title: "Timing differs",
          detail: "Synthetic duration mismatch.",
          evidenceTimestamps: [4.9],
          affectedFrames: 75,
          measuredPhaseFrames: 75,
          suggestion: "Try the measured duration.",
        },
      ],
      artifacts: {
        proxyObjectKey: "fixture/proxy",
        timestampsObjectKey: "fixture/timestamps",
        analysisObjectKey: "fixture/analysis",
      },
      limitations: ["Unit-test evidence only."],
    };
    await pool.query(
      "INSERT INTO jobs(id,owner_id,kind,status,payload,result) VALUES($1,$2,'analysis','succeeded',$3,$4)",
      [id, owner, { takeId }, analysis],
    );
    return analysis;
  }
  it("returns JSON 404 when a recorded media object is missing", async () => {
    const row = await take();
    const response = await handleApi(
      new Request(`http://localhost:3037/api/takes/${row.id}/media`),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "Media is no longer available.",
    });
  });
  it("saves project renames and rejects a stale rename without losing the current name", async () => {
    const created = await (
      await handleApi(request("projects", { name: "Original", plan }))
    ).json();
    expect(
      (
        await handleApi(
          request("projects", {
            name: "Renamed",
            plan,
            projectId: created.projectId,
            expectedVersionId: created.versionId,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleApi(
          request("projects", {
            name: "Stale",
            plan,
            projectId: created.projectId,
            expectedVersionId: created.versionId,
          }),
        )
      ).status,
    ).toBe(409);
    const projects = await (
      await handleApi(new Request("http://localhost:3037/api/projects"))
    ).json();
    expect(projects.projects[0].name).toBe("Renamed");
  });
  it("does not expose expired analysis before the retention sweep runs", async () => {
    const row = await take();
    const analysis = await completedAnalysis(row.id);
    await pool.query(
      "UPDATE takes SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [row.id],
    );
    const response = await handleApi(
      new Request(`http://localhost:3037/api/jobs/${analysis.jobId}`),
    );
    expect(response.status).toBe(404);
    expect(
      (
        await pool.query("SELECT result FROM jobs WHERE id=$1", [
          analysis.jobId,
        ])
      ).rows[0].result,
    ).not.toBeNull();
  });
  it("does not report cancelling an already completed job", async () => {
    const row = await take();
    const analysis = await completedAnalysis(row.id);
    const response = await handleApi(
      new Request(`http://localhost:3037/api/jobs/${analysis.jobId}`, {
        method: "DELETE",
      }),
    );
    expect(await response.json()).toEqual({
      cancelled: false,
      status: "succeeded",
    });
    expect(
      (
        await pool.query("SELECT result FROM jobs WHERE id=$1", [
          analysis.jobId,
        ])
      ).rows[0].result,
    ).toEqual(analysis);
  });
  it("deletes copied evidence from revisions and supports deletion retries", async () => {
    const row = await take();
    const analysis = await completedAnalysis(row.id);
    await pool.query(
      "INSERT INTO revisions(id,owner_id,parent_plan_id,plan,finding_ids,reason,provenance) VALUES($1,$2,$3,$4,'[]','fixture',$5)",
      [
        randomUUID(),
        owner,
        plan.id,
        plan,
        { analysisJobId: analysis.jobId, events: analysis.findings },
      ],
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(
        (
          await handleApi(
            new Request(`http://localhost:3037/api/takes/${row.id}`, {
              method: "DELETE",
            }),
          )
        ).status,
      ).toBe(200);
    }
    expect((await pool.query("SELECT * FROM revisions")).rows).toEqual([]);
    expect(
      (await pool.query("SELECT result FROM jobs")).rows[0].result,
    ).toBeNull();
  });
  it("continues retention cleanup after one storage failure and retries the failed prefix", async () => {
    const first = await take();
    const second = await take();
    await pool.query("UPDATE takes SET expires_at=now()-interval '1 hour'");
    await pool.query(
      "INSERT INTO jobs(id,owner_id,kind,payload,error) VALUES($1,$2,'analysis',$3,'private worker error')",
      [randomUUID(), owner, { takeId: first.id }],
    );
    const deletion = vi
      .spyOn(storage, "deletePrefix")
      .mockRejectedValueOnce(new Error("Injected storage outage"));
    await expect(cleanupMedia()).rejects.toThrow(
      "Some media could not be removed",
    );
    expect(deletion).toHaveBeenCalledTimes(2);
    const records = (
      await pool.query(
        "SELECT deleted_at,cleanup_checked_at,file_name FROM takes ORDER BY id",
      )
    ).rows;
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.deleted_at).not.toBeNull();
      expect(record.cleanup_checked_at).not.toBeNull();
      expect(record.file_name).toBe("deleted");
    }
    expect(
      (await pool.query("SELECT error FROM jobs")).rows[0].error,
    ).toBeNull();
    await expect(cleanupMedia()).resolves.toBe(2);
    expect(deletion).toHaveBeenCalledWith(
      `owners/${owner}/takes/${second.id}/`,
    );
  });
  it("rejects revision publication if its source take is deleted while inference is pending", async () => {
    const row = await take();
    const analysis = await completedAnalysis(row.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const proposing = vi
      .spyOn(revisionPlanner, "proposeRevision")
      .mockImplementation(async () => {
        await gate;
        return {
          plan,
          findingIds: ["duration:whole:0"],
          reason: "Test proposal",
          source: "library",
          events: [],
        };
      });
    const pending = handleApi(
      request("revisions", { plan, analysis: { jobId: analysis.jobId } }),
    );
    await vi.waitFor(() => expect(proposing).toHaveBeenCalledOnce());
    await handleApi(
      new Request(`http://localhost:3037/api/takes/${row.id}`, {
        method: "DELETE",
      }),
    );
    release();
    expect((await pending).status).toBe(410);
    expect((await pool.query("SELECT * FROM revisions")).rows).toEqual([]);
  });
  it("accepts a live revision idempotently but refuses it once its source expires", async () => {
    const row = await take();
    const analysis = await completedAnalysis(row.id);
    const revisionId = randomUUID();
    await pool.query(
      "INSERT INTO revisions(id,owner_id,parent_plan_id,plan,finding_ids,reason,provenance) VALUES($1,$2,$3,$4,'[]','fixture',$5)",
      [revisionId, owner, plan.id, plan, { analysisJobId: analysis.jobId }],
    );
    expect(
      (
        await handleApi(
          request(`revisions/${revisionId}/accept`, { currentPlanId: plan.id }),
        )
      ).status,
    ).toBe(200);
    const acceptedAt = (
      await pool.query("SELECT accepted_at FROM revisions WHERE id=$1", [
        revisionId,
      ])
    ).rows[0].accepted_at;
    expect(
      (
        await handleApi(
          request(`revisions/${revisionId}/accept`, { currentPlanId: plan.id }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await pool.query("SELECT accepted_at FROM revisions WHERE id=$1", [
          revisionId,
        ])
      ).rows[0].accepted_at,
    ).toEqual(acceptedAt);
    await pool.query(
      "UPDATE takes SET expires_at=now()-interval '1 minute' WHERE id=$1",
      [row.id],
    );
    expect(
      (
        await handleApi(
          request(`revisions/${revisionId}/accept`, { currentPlanId: plan.id }),
        )
      ).status,
    ).toBe(409);
  });
  it("cannot accept a cached revision while source deletion commits", async () => {
    const row = await take();
    const analysis = await completedAnalysis(row.id);
    const revisionId = randomUUID();
    await pool.query(
      "INSERT INTO revisions(id,owner_id,parent_plan_id,plan,finding_ids,reason,provenance) VALUES($1,$2,$3,$4,'[]','fixture',$5)",
      [revisionId, owner, plan.id, plan, { analysisJobId: analysis.jobId }],
    );
    const deleting = await pool.connect();
    await deleting.query("BEGIN");
    try {
      await deleting.query("UPDATE takes SET deleted_at=now() WHERE id=$1", [
        row.id,
      ]);
      const pending = handleApi(
        request(`revisions/${revisionId}/accept`, { currentPlanId: plan.id }),
      );
      await vi.waitFor(async () => {
        const waiting = await pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT t.id FROM takes t JOIN jobs j%'",
        );
        expect(waiting.rows[0].n).toBeGreaterThan(0);
      });
      await deleting.query("DELETE FROM revisions WHERE id=$1", [revisionId]);
      await deleting.query("COMMIT");
      expect((await pending).status).toBe(409);
    } finally {
      await deleting.query("ROLLBACK");
      deleting.release();
    }
  });
  it("enforces the revision quota before invoking a model", async () => {
    const row = await take();
    const analysis = await completedAnalysis(row.id);
    await pool.query(
      "INSERT INTO usage_events(owner_id,kind) SELECT $1,'revision' FROM generate_series(1,30)",
      [owner],
    );
    const proposing = vi.spyOn(revisionPlanner, "proposeRevision");
    const response = await handleApi(
      request("revisions", { plan, analysis: { jobId: analysis.jobId } }),
    );
    expect(response.status).toBe(429);
    expect(proposing).not.toHaveBeenCalled();
  });
  it("atomically deduplicates concurrent planning and consumes quota once", async () => {
    const responses = await Promise.all([
      handleApi(request("plans", input, "same-plan")),
      handleApi(request("plans", input, "same-plan")),
    ]);
    expect(responses.every((r) => [200, 202].includes(r.status))).toBe(true);
    const payloads = await Promise.all(responses.map((r) => r.json()));
    expect(payloads[0].jobId).toBe(payloads[1].jobId);
    expect(
      Number((await pool.query("SELECT count(*) FROM jobs")).rows[0].count),
    ).toBe(1);
    expect(
      Number(
        (await pool.query("SELECT count(*) FROM usage_events")).rows[0].count,
      ),
    ).toBe(1);
    const changed = await handleApi(
      request("plans", { ...input, prompt: "different" }, "same-plan"),
    );
    expect(changed.status).toBe(409);
  });
  it("rejects a reused analysis key when input or take changes", async () => {
    const first = await take(),
      second = await take();
    const concurrent = await Promise.all([
      handleApi(
        request(`takes/${first.id}/analyze`, annotation, "analysis-key"),
      ),
      handleApi(
        request(`takes/${first.id}/analyze`, annotation, "analysis-key"),
      ),
    ]);
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 202]);
    expect(
      (await pool.query("SELECT payload FROM jobs")).rows[0].payload
        .targetTimeBasis,
    ).toBe("normalized-phase");
    expect(
      (
        await handleApi(
          request(
            `takes/${first.id}/analyze`,
            { ...annotation, seed: { ...annotation.seed, timeSeconds: 3 } },
            "analysis-key",
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await handleApi(
          request(`takes/${second.id}/analyze`, annotation, "analysis-key"),
        )
      ).status,
    ).toBe(409);
    await pool.query("UPDATE worker_health SET ready=false");
    expect(
      (
        await handleApi(
          request(`takes/${first.id}/analyze`, annotation, "analysis-key"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleApi(
          request(`takes/${first.id}/analyze`, annotation, "new-key"),
        )
      ).status,
    ).toBe(503);
    expect(
      Number((await pool.query("SELECT count(*) FROM jobs")).rows[0].count),
    ).toBe(1);
    expect(
      Number(
        (await pool.query("SELECT count(*) FROM usage_events")).rows[0].count,
      ),
    ).toBe(1);
  });
  it("denies another owner media and take operations", async () => {
    const other = await take("someone-else");
    expect(
      (
        await handleApi(
          new Request(`http://localhost:3037/api/takes/${other.id}/media`),
        )
      ).status,
    ).toBe(404);
    expect(
      (await handleApi(request(`takes/${other.id}/analyze`, annotation)))
        .status,
    ).toBe(404);
    expect(
      (
        await handleApi(
          new Request(`http://localhost:3037/api/takes/${other.id}`, {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(404);
  });
  it("rejects a parent version on a new project before reaching the foreign key", async () => {
    const response = await handleApi(
      request("projects", {
        name: "New project",
        plan,
        expectedVersionId: randomUUID(),
      }),
    );
    expect(response.status).toBe(400);
    expect(
      Number((await pool.query("SELECT count(*) FROM projects")).rows[0].count),
    ).toBe(0);
  });
  it("serializes concurrent uploads and keeps only one accepted body", async () => {
    const row = await take(owner, "uploading");
    const responses = await Promise.all(
      ["abcdefghij", "0123456789"].map((body) =>
        handleApi(
          new Request(`http://localhost:3037/api/takes/${row.id}/upload`, {
            method: "PUT",
            body,
          }),
        ),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const bytes = await readFile(path.join(directory, row.key), "utf8");
    expect(["abcdefghij", "0123456789"]).toContain(bytes);
    expect(await readdir(path.dirname(path.join(directory, row.key)))).toEqual([
      "original",
    ]);
  });
  it("does not publish an upload when deletion occurs during streaming", async () => {
    const row = await take(owner, "uploading");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("abcde"));
        await gate;
        controller.enqueue(new TextEncoder().encode("fghij"));
        controller.close();
      },
    });
    const pending = handleApi(
      new Request(`http://localhost:3037/api/takes/${row.id}/upload`, {
        method: "PUT",
        body: stream,
        duplex: "half",
      } as RequestInit),
    );
    await vi.waitFor(
      async () =>
        expect(
          await readdir(path.dirname(path.join(directory, row.key))),
        ).toHaveLength(1),
      { interval: 10, timeout: 2000 },
    );
    await pool.query(
      "INSERT INTO jobs(id,owner_id,kind,payload,result) VALUES($1,$2,'analysis',$3,$4)",
      [
        randomUUID(),
        owner,
        { takeId: row.id, privateAnnotation: "test-data" },
        { privateTestValue: "scrub-me" },
      ],
    );
    expect(
      (
        await handleApi(
          new Request(`http://localhost:3037/api/takes/${row.id}`, {
            method: "DELETE",
          }),
        )
      ).status,
    ).toBe(200);
    release();
    expect((await pending).status).toBe(410);
    await expect(readFile(path.join(directory, row.key))).rejects.toThrow();
    const saved = (
      await pool.query(
        "SELECT file_name,plan,training_consent FROM takes WHERE id=$1",
        [row.id],
      )
    ).rows[0];
    expect(saved).toEqual({
      file_name: "deleted",
      plan: {},
      training_consent: false,
    });
    const job = (
      await pool.query("SELECT payload,result,error,status FROM jobs")
    ).rows[0];
    expect(job).toEqual({
      payload: { takeId: row.id, deleted: true },
      result: null,
      error: null,
      status: "cancelled",
    });
  });
});
