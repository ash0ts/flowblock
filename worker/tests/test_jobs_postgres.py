"""Actual PostgreSQL lease tests in a disposable, uniquely named schema."""

import os
import uuid

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


def enqueue(queue):
    take_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
    with queue.connect() as connection:
        connection.execute(
            "INSERT INTO takes VALUES(%s,'fixture-owner','private/video',NULL,now()+interval '1 hour')",
            (take_id,),
        )
        connection.execute(
            "INSERT INTO jobs(id,owner_id,kind,status,payload) VALUES(%s,'fixture-owner','analysis','queued',%s)",
            (job_id, Jsonb({"takeId": take_id, "videoObjectKey": "private/video"})),
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


def test_retry_limit_terminates_expired_work(queue):
    enqueue(queue)
    with queue.connect() as connection:
        connection.execute(
            "UPDATE jobs SET status='running',attempt=3,lease_expires_at=now()-interval '1 second'"
        )
    assert queue.claim() is None
    with queue.connect() as connection:
        assert connection.execute("SELECT status FROM jobs").fetchone()["status"] == "failed"


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
