"""Actual PostgreSQL lease tests in a disposable, uniquely named schema."""

import os
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from flowblock_worker.jobs import Lease, LeaseLost, Queue, publish_result
from flowblock_worker.storage import ObjectStore


@pytest.fixture
def queue():
    dsn = os.environ.get("FLOWBLOCK_TEST_DATABASE_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        pytest.skip("Set FLOWBLOCK_TEST_DATABASE_URL to run PostgreSQL integration checks")
    schema = f"worker_test_{uuid.uuid4().hex}"
    with psycopg.connect(dsn) as connection:
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
    queue = Queue(dsn)
    queue.connect = lambda: psycopg.connect(
        dsn, options=f"-csearch_path={schema}", row_factory=dict_row
    )
    with queue.connect() as connection:
        connection.execute("""
            CREATE TABLE workflows(id uuid PRIMARY KEY,owner_id text,created_at timestamptz DEFAULT now());
            CREATE TABLE workflow_attempts(id uuid PRIMARY KEY,workflow_id uuid REFERENCES workflows(id),stage text,
                attempt int,parent_attempt_id uuid,job_id uuid,plan_id text,take_id uuid,status text,
                started_at timestamptz DEFAULT now(),ended_at timestamptz,summary jsonb DEFAULT '{}'::jsonb);
            CREATE TABLE takes(id uuid PRIMARY KEY,owner_id text,object_key text,deleted_at timestamptz,expires_at timestamptz);
            CREATE TABLE jobs(id uuid PRIMARY KEY, owner_id text, kind text,status text,payload jsonb,result jsonb,error text,
                attempt int DEFAULT 0,lease_token uuid,lease_expires_at timestamptz,heartbeat_at timestamptz,
                created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),cancelled_at timestamptz);
            CREATE TABLE worker_health(worker_id text PRIMARY KEY,device text,model text,ready bool,heartbeat_at timestamptz,details jsonb);
        """)
    try:
        yield queue
    finally:
        with psycopg.connect(dsn) as connection:
            connection.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def enqueue(queue, workflow=False):
    take_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    with queue.connect() as connection:
        payload = {"takeId": take_id, "videoObjectKey": "private/video"}
        if workflow:
            workflow_id = str(uuid.uuid4())
            connection.execute(
                "INSERT INTO workflows(id,owner_id) VALUES(%s,'fixture-owner')", (workflow_id,)
            )
            payload["workflowTrace"] = {
                "schemaVersion": "1.0",
                "workflowId": workflow_id,
                "stage": "analysis",
                "attemptId": str(uuid.uuid4()),
                "attempt": 1,
                "parentAttemptId": str(uuid.uuid4()),
                "takeId": take_id,
                "planId": "plan-fixture",
            }
        connection.execute(
            "INSERT INTO takes VALUES(%s,'fixture-owner','private/video',NULL,now()+interval '1 hour')",
            (take_id,),
        )
        connection.execute(
            "INSERT INTO jobs(id,owner_id,kind,status,payload) VALUES(%s,'fixture-owner','analysis','queued',%s)",
            (job_id, Jsonb(payload)),
        )
    return take_id, job_id


def test_claim_is_exclusive_and_expired_lease_is_reclaimed(queue):
    enqueue(queue)
    first = queue.claim()
    assert first["attempt"] == 1
    assert queue.claim() is None
    with queue.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at=now()-interval '1 second'")
    second = queue.claim()
    assert second["attempt"] == 2
    assert first["lease_token"] != second["lease_token"]
    assert not queue.renew(first)
    assert queue.renew(second)


def test_expired_worker_cannot_requeue_or_fail_a_job(queue):
    enqueue(queue)
    stale = queue.claim()
    with queue.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at=now()-interval '1 second'")
    queue.fail(stale, "stale failure", retryable=True)
    with queue.connect() as connection:
        row = connection.execute("SELECT status,error FROM jobs").fetchone()
        assert row == {"status": "running", "error": None}
    current = queue.claim()
    queue.fail(stale, "superseded failure", retryable=False)
    assert queue.renew(current)
    queue.fail(current, "current failure", retryable=True)
    with queue.connect() as connection:
        row = connection.execute("SELECT status,error FROM jobs").fetchone()
        assert row == {"status": "queued", "error": "current failure"}


@pytest.mark.parametrize("change", ["cancel", "delete", "expire", "owner", "object"])
def test_changed_take_or_cancelled_job_blocks_publication(queue, change):
    enqueue(queue)
    job = queue.claim()
    with queue.connect() as connection:
        statements = {
            "cancel": "UPDATE jobs SET status='cancelled',cancelled_at=now()",
            "delete": "UPDATE takes SET deleted_at=now()",
            "expire": "UPDATE takes SET expires_at=now()-interval '1 second'",
            "owner": "UPDATE takes SET owner_id='someone-else'",
            "object": "UPDATE takes SET object_key='different/video'",
        }
        connection.execute(statements[change])
    assert not queue.renew(job)
    assert not queue.finish(job, {"coverage": {"needsReview": False}})
    with queue.connect() as connection:
        assert connection.execute("SELECT result FROM jobs").fetchone()["result"] is None


def test_review_needed_result_and_worker_health(queue):
    enqueue(queue)
    job = queue.claim()
    assert queue.finish(job, {"coverage": {"needsReview": True}})
    with queue.connect() as connection:
        assert connection.execute("SELECT status FROM jobs").fetchone()["status"] == "needs_review"
    health = {"device": "cpu", "model": "fixture-health-only", "ready": True}
    queue.worker_heartbeat("test-worker", health)
    with queue.connect() as connection:
        assert connection.execute("SELECT ready FROM worker_health").fetchone()["ready"] is True


def test_publication_readback_waits_for_an_in_progress_commit(queue):
    enqueue(queue)
    job = queue.claim()
    with queue.connect() as connection, ThreadPoolExecutor(max_workers=1) as executor:
        connection.execute("UPDATE jobs SET status='succeeded', result='{}'::jsonb")
        readback = executor.submit(queue.published, job)
        try:
            with pytest.raises(TimeoutError):
                readback.result(timeout=0.1)
        finally:
            connection.commit()
        assert readback.result(timeout=2)


def test_retry_limit_terminates_expired_work(queue):
    enqueue(queue)
    with queue.connect() as connection:
        connection.execute(
            "UPDATE jobs SET status='running',attempt=3,lease_expires_at=now()-interval '1 second'"
        )
    assert queue.claim() is None
    with queue.connect() as connection:
        assert connection.execute("SELECT status FROM jobs").fetchone()["status"] == "failed"


def test_workflow_attempt_is_created_at_claim_and_committed_with_result(queue):
    take_id, job_id = enqueue(queue, workflow=True)
    with queue.connect() as connection:
        assert (
            connection.execute("SELECT count(*) AS n FROM workflow_attempts").fetchone()["n"] == 0
        )
    job = queue.claim()
    with queue.connect() as connection:
        attempt = connection.execute("SELECT * FROM workflow_attempts").fetchone()
        assert str(attempt["id"]) == str(job["lease_token"])
        assert str(attempt["job_id"]) == job_id and str(attempt["take_id"]) == take_id
        assert attempt["status"] == "running" and attempt["ended_at"] is None
    assert queue.finish(
        job,
        {
            "coverage": {"needsReview": True, "measuredFrames": 40, "expectedFrames": 75},
            "findings": [],
        },
    )
    with queue.connect() as connection:
        attempt = connection.execute("SELECT * FROM workflow_attempts").fetchone()
        assert attempt["status"] == "needs_review" and attempt["ended_at"] is not None
        assert attempt["summary"]["measuredFrames"] == 40


def test_reclaimed_workflow_keeps_expired_attempt_and_stale_writer_cannot_close_retry(queue):
    enqueue(queue, workflow=True)
    first = queue.claim()
    with queue.connect() as connection:
        connection.execute("UPDATE jobs SET lease_expires_at=now()-interval '1 second'")
    second = queue.claim()
    queue.fail(first, "stale error", retryable=True)
    queue.record_attempt_loss(first)
    with queue.connect() as connection:
        attempts = connection.execute("SELECT * FROM workflow_attempts ORDER BY attempt").fetchall()
        assert len(attempts) == 2
        assert (
            attempts[0]["status"] == "failed"
            and attempts[0]["summary"]["reason"] == "lease_expired"
        )
        assert attempts[1]["status"] == "running" and attempts[1]["ended_at"] is None
        assert attempts[0]["id"] != attempts[1]["id"]
        assert attempts[0]["workflow_id"] == attempts[1]["workflow_id"]
    assert queue.finish(second, {"coverage": {"needsReview": False}})


def test_cancelled_workflow_attempt_cannot_publish_success(queue):
    enqueue(queue, workflow=True)
    job = queue.claim()
    with queue.connect() as connection:
        connection.execute("UPDATE jobs SET status='cancelled', cancelled_at=now()")
    assert not queue.finish(job, {"coverage": {"needsReview": False}})
    assert queue.record_attempt_loss(job) == "cancelled"
    with queue.connect() as connection:
        assert (
            connection.execute("SELECT status FROM workflow_attempts").fetchone()["status"]
            == "cancelled"
        )


def test_foreign_workflow_is_not_traced_or_modified(queue):
    enqueue(queue, workflow=True)
    with queue.connect() as connection:
        connection.execute("UPDATE workflows SET owner_id='another-owner'")
    job = queue.claim()
    assert "workflowTrace" not in job["payload"]
    assert queue.finish(job, {"coverage": {"needsReview": False}})
    with queue.connect() as connection:
        assert (
            connection.execute("SELECT count(*) AS n FROM workflow_attempts").fetchone()["n"] == 0
        )


def test_retryable_failure_preserves_attempt_before_requeue(queue):
    enqueue(queue, workflow=True)
    first = queue.claim()
    assert queue.fail(first, "temporary failure", retryable=True)
    with queue.connect() as connection:
        attempt = connection.execute("SELECT * FROM workflow_attempts").fetchone()
        assert attempt["status"] == "failed" and attempt["summary"]["reason"] == "retryable_failure"
    second = queue.claim()
    assert second["attempt"] == 2


@pytest.mark.parametrize("delete_after_upload", [1, 2])
def test_delete_during_artifact_upload_reclaims_only_this_attempt(
    queue, tmp_path, monkeypatch, delete_after_upload
):
    """Real DB and filesystem race check; arbitrary bytes test publication, not inference."""
    enqueue(queue)
    job = queue.claim()
    monkeypatch.setenv("FLOWBLOCK_STORAGE_DIR", str(tmp_path / "private"))
    monkeypatch.delenv("S3_BUCKET", raising=False)
    monkeypatch.delenv("FLOWBLOCK_S3_BUCKET", raising=False)
    store = ObjectStore()
    source = tmp_path / "artifact.txt"
    source.write_text("publication-race-fixture")
    prefix = "fixture/analysis/attempt-one"
    sibling = "fixture/analysis/other-attempt/keep.txt"
    store.upload(source, sibling, "text/plain")
    files = [(source, f"{prefix}/{i}.txt", "text/plain") for i in range(2)]
    original_upload = store.upload
    count = 0

    def upload_then_delete(path, key, content_type):
        nonlocal count
        original_upload(path, key, content_type)
        count += 1
        if count == delete_after_upload:
            with queue.connect() as connection:
                connection.execute("UPDATE takes SET deleted_at=now()")

    store.upload = upload_then_delete
    with Lease(queue, job) as lease:
        with pytest.raises(LeaseLost):
            publish_result(
                queue, job, {"coverage": {"needsReview": False}}, files, store, lease, prefix
            )
    assert not store.local_path(prefix).exists()
    assert store.local_path(sibling).exists()
    with queue.connect() as connection:
        assert connection.execute("SELECT result FROM jobs").fetchone()["result"] is None


def test_failed_partial_upload_is_removed(queue, tmp_path, monkeypatch):
    enqueue(queue)
    job = queue.claim()
    monkeypatch.setenv("FLOWBLOCK_STORAGE_DIR", str(tmp_path / "private"))
    monkeypatch.delenv("S3_BUCKET", raising=False)
    monkeypatch.delenv("FLOWBLOCK_S3_BUCKET", raising=False)
    store = ObjectStore()
    source = tmp_path / "artifact.txt"
    source.write_text("partial-upload-fixture")
    prefix = "fixture/analysis/attempt-partial"

    def fail_after_partial(path, key, content_type):
        target = store.local_path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.with_suffix(target.suffix + ".part").write_text("partial")
        raise OSError("injected partial-write failure")

    store.upload = fail_after_partial
    with Lease(queue, job) as lease:
        with pytest.raises(OSError):
            publish_result(
                queue,
                job,
                {"coverage": {"needsReview": False}},
                [(source, f"{prefix}/one.txt", "text/plain")],
                store,
                lease,
                prefix,
            )
    assert not store.local_path(prefix).exists()


@pytest.mark.parametrize("outcome", ["before-commit", "after-commit", "readback-unavailable"])
def test_publication_connection_failure_does_not_delete_committed_evidence(
    queue, tmp_path, monkeypatch, outcome
):
    enqueue(queue)
    job = queue.claim()
    monkeypatch.setenv("FLOWBLOCK_STORAGE_DIR", str(tmp_path / "private"))
    monkeypatch.delenv("S3_BUCKET", raising=False)
    monkeypatch.delenv("FLOWBLOCK_S3_BUCKET", raising=False)
    store = ObjectStore()
    source = tmp_path / "artifact.txt"
    source.write_text("commit-acknowledgement-fixture")
    prefix = "fixture/analysis/commit-attempt"
    key = f"{prefix}/evidence.txt"
    finish = queue.finish

    def failed_acknowledgement(job, result):
        if outcome != "before-commit":
            assert finish(job, result)
        raise ConnectionError("injected commit acknowledgement failure")

    def unavailable_readback(job):
        raise ConnectionError("injected database outage")

    monkeypatch.setattr(queue, "finish", failed_acknowledgement)
    if outcome == "readback-unavailable":
        monkeypatch.setattr(queue, "published", unavailable_readback)
    with Lease(queue, job) as lease:
        args = (
            queue,
            job,
            {"coverage": {"needsReview": False}},
            [(source, key, "text/plain")],
            store,
            lease,
            prefix,
        )
        if outcome == "after-commit":
            publish_result(*args)
        else:
            with pytest.raises(ConnectionError, match="acknowledgement"):
                publish_result(*args)
    assert store.local_path(key).exists() == (outcome != "before-commit")
    with queue.connect() as connection:
        status = connection.execute("SELECT status FROM jobs").fetchone()["status"]
        assert status == ("running" if outcome == "before-commit" else "succeeded")
