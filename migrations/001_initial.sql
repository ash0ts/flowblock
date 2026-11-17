CREATE TABLE IF NOT EXISTS projects (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL,
 current_version_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS plan_versions (
 id UUID PRIMARY KEY, project_id UUID REFERENCES projects(id) ON DELETE CASCADE, owner_id TEXT NOT NULL,
 parent_id UUID REFERENCES plan_versions(id), plan JSONB NOT NULL, provenance JSONB NOT NULL DEFAULT '{}',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS takes (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL,
 size_bytes BIGINT NOT NULL CHECK(size_bytes > 0 AND size_bytes <= 104857600), mime_type TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'uploading', plan JSONB NOT NULL,
 training_consent BOOLEAN NOT NULL DEFAULT false,
 deleted_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE takes ADD COLUMN IF NOT EXISTS cleanup_checked_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS jobs (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('plan','analysis')),
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','needs_review','succeeded','failed','cancelled')),
 payload JSONB NOT NULL, result JSONB, error TEXT,
 attempt INTEGER NOT NULL DEFAULT 0, lease_token UUID, lease_expires_at TIMESTAMPTZ, heartbeat_at TIMESTAMPTZ,
 cancelled_at TIMESTAMPTZ, idempotency_key TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(owner_id,idempotency_key)
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(kind,status,lease_expires_at,created_at);
CREATE INDEX IF NOT EXISTS jobs_owner_idx ON jobs(owner_id,created_at DESC);
CREATE TABLE IF NOT EXISTS shares (
 token TEXT PRIMARY KEY, owner_id TEXT NOT NULL, plan JSONB NOT NULL,
 revoked_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS revisions (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL, parent_plan_id TEXT NOT NULL,
 plan JSONB NOT NULL, finding_ids JSONB NOT NULL, reason TEXT NOT NULL,
 accepted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS provenance JSONB NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS usage_events (
 id BIGSERIAL PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_owner_idx ON usage_events(owner_id,kind,created_at);
CREATE TABLE IF NOT EXISTS worker_health (
 worker_id TEXT PRIMARY KEY, device TEXT NOT NULL, model TEXT NOT NULL, ready BOOLEAN NOT NULL,
 heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(), details JSONB NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS workflows (
 id UUID PRIMARY KEY, owner_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workflows_owner_idx ON workflows(owner_id,created_at DESC);
ALTER TABLE takes ADD COLUMN IF NOT EXISTS workflow_id UUID REFERENCES workflows(id);
CREATE TABLE IF NOT EXISTS workflow_attempts (
 id UUID PRIMARY KEY, workflow_id UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
 stage TEXT NOT NULL CHECK(stage IN ('planning','analysis','revision','acceptance','replay')),
 attempt INTEGER NOT NULL CHECK(attempt > 0), parent_attempt_id UUID,
 job_id UUID, plan_id TEXT, take_id UUID,
 status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','needs_review','failed','cancelled')),
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ,
 summary JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS workflow_attempts_workflow_idx ON workflow_attempts(workflow_id,started_at);
