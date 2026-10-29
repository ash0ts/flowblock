"""Lease-owned PostgreSQL jobs with cancellation-aware artifact publication."""

from __future__ import annotations

import json
import logging
import os
import tempfile
import threading
import time
import uuid
from pathlib import Path

from .pipeline import artifact_files, process
from .storage import ObjectStore, validate_key

LOG = logging.getLogger(__name__)
LEASE_SECONDS = 90


class LeaseLost(RuntimeError):
    pass


class Queue:
    def __init__(self, dsn: str):
        import psycopg
        from psycopg.rows import dict_row

        self.connect = lambda: psycopg.connect(dsn, row_factory=dict_row, connect_timeout=10)

    def ping(self):
        with self.connect() as connection:
            connection.execute("SELECT 1")

    def worker_heartbeat(self, worker_id: str, health: dict):
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO worker_health(worker_id,device,model,ready,heartbeat_at,details)
                VALUES (%s,%s,%s,%s,now(),%s::jsonb)
                ON CONFLICT(worker_id) DO UPDATE SET device=excluded.device, model=excluded.model,
                    ready=excluded.ready, heartbeat_at=now(), details=excluded.details
                """,
                (
                    worker_id,
                    health["device"],
                    health["model"],
                    health.get("ready", False),
                    json.dumps(health),
                ),
            )

    def claim(self) -> dict | None:
        token = str(uuid.uuid4())
        with self.connect() as connection:
            connection.execute(
                "UPDATE jobs SET status='failed', error='Analysis retry limit reached', updated_at=now() WHERE kind='analysis' AND status='running' AND lease_expires_at < now() AND attempt >= 3"
            )
            row = connection.execute(
                """
                WITH candidate AS (
                    SELECT id FROM jobs
                    WHERE kind='analysis' AND attempt < 3 AND cancelled_at IS NULL
                      AND (status='queued' OR (status='running' AND lease_expires_at < now()))
                    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
                )
                UPDATE jobs j SET status='running', attempt=j.attempt+1,
                    lease_token=%s, lease_expires_at=now() + make_interval(secs => %s),
                    heartbeat_at=now(), updated_at=now(), error=NULL
                FROM candidate c WHERE j.id=c.id RETURNING j.*
                """,
                (token, LEASE_SECONDS),
            ).fetchone()
        return row

    def renew(self, job: dict) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                """
                UPDATE jobs j SET lease_expires_at=now()+make_interval(secs => %s),
                    heartbeat_at=now(), updated_at=now()
                WHERE j.id=%s AND j.lease_token=%s AND j.status='running'
                  AND j.cancelled_at IS NULL AND j.lease_expires_at > now()
                  AND EXISTS (SELECT 1 FROM takes t WHERE t.id::text=j.payload->>'takeId'
                    AND t.owner_id=j.owner_id AND t.deleted_at IS NULL AND t.expires_at > now()
                    AND t.object_key=j.payload->>'videoObjectKey')
                RETURNING j.id
                """,
                (LEASE_SECONDS, job["id"], job["lease_token"]),
            ).fetchone()
        return row is not None

    def finish(self, job: dict, result: dict) -> bool:
        status = "needs_review" if result["coverage"]["needsReview"] else "succeeded"
        with self.connect() as connection:
            row = connection.execute(
                """
                UPDATE jobs j SET status=%s, result=%s::jsonb, error=NULL,
                    lease_expires_at=NULL, updated_at=now()
                WHERE j.id=%s AND j.lease_token=%s AND j.status='running'
                  AND j.cancelled_at IS NULL AND j.lease_expires_at > now()
                  AND EXISTS (SELECT 1 FROM takes t WHERE t.id::text=j.payload->>'takeId'
                    AND t.owner_id=j.owner_id AND t.deleted_at IS NULL AND t.expires_at > now()
                    AND t.object_key=j.payload->>'videoObjectKey')
                RETURNING j.id
                """,
                (status, json.dumps(result, allow_nan=False), job["id"], job["lease_token"]),
            ).fetchone()
        return row is not None

    def fail(self, job: dict, message: str, retryable: bool):
        status = "queued" if retryable and job["attempt"] < 3 else "failed"
        with self.connect() as connection:
            connection.execute(
                "UPDATE jobs SET status=%s, error=%s, lease_expires_at=NULL, updated_at=now() WHERE id=%s AND lease_token=%s AND status='running' AND cancelled_at IS NULL AND lease_expires_at > now()",
                (status, message[:2000], job["id"], job["lease_token"]),
            )

    def published(self, job: dict) -> bool:
        """Resolve an uncertain commit acknowledgement without trusting cached job state."""
        with self.connect() as connection:
            connection.execute("SET LOCAL statement_timeout = '10s'")
            row = connection.execute(
                "SELECT status, result IS NOT NULL AS has_result FROM jobs WHERE id=%s AND lease_token=%s FOR UPDATE",
                (job["id"], job["lease_token"]),
            ).fetchone()
        return bool(row and row["status"] in ("succeeded", "needs_review") and row["has_result"])


class Lease:
    def __init__(self, queue: Queue, job: dict):
        self.queue, self.job = queue, job
        self.stop = threading.Event()
        self.lost = threading.Event()
        self.thread = threading.Thread(target=self._heartbeat, daemon=True)

    def __enter__(self):
        if not self.queue.renew(self.job):
            raise LeaseLost(
                "Take was deleted, expired, cancelled, or no longer owned by this lease"
            )
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=15)

    def _heartbeat(self):
        while not self.stop.wait(15):
            try:
                if not self.queue.renew(self.job):
                    self.lost.set()
                    return
            except Exception:
                LOG.exception("Lease heartbeat failed")
                self.lost.set()
                return

    def check(self):
        if self.lost.is_set():
            raise LeaseLost("Lease was lost or take was cancelled, deleted, or expired")


def publish_result(
    queue: Queue,
    job: dict,
    result: dict,
    files: list,
    store: ObjectStore,
    lease: Lease,
    attempt_prefix: str,
):
    """Publish only under a live lease; reclaim even a partially written last object."""
    uploaded = []
    committed = False
    cleanup_allowed = True
    try:
        for path, key, content_type in files:
            lease.check()
            if not queue.renew(job):
                raise LeaseLost("Take or lease changed before artifact upload")
            uploaded.append(key)
            store.upload(path, key, content_type)
        lease.check()
        try:
            committed = queue.finish(job, result)
        except Exception:
            try:
                committed = queue.published(job)
            except Exception:
                cleanup_allowed = False
                LOG.exception(
                    "Publication outcome unknown; retaining private attempt for retention"
                )
            if not committed:
                raise
        if not committed:
            raise LeaseLost("Result publication rejected because the lease or take changed")
    finally:
        if not committed and cleanup_allowed:
            for key in uploaded:
                try:
                    store.delete(key)
                except Exception:
                    LOG.exception("Could not remove unpublished analysis artifact")
            try:
                store.delete_prefix(attempt_prefix)
            except Exception:
                LOG.exception("Could not remove unpublished analysis attempt prefix")


def process_job(queue: Queue, job: dict, segmenter, store: ObjectStore):
    try:
        payload = dict(job["payload"])
        payload["jobId"] = str(job["id"])
        prefix = validate_key(payload["outputPrefix"].rstrip("/"))
        expected_prefix = f"owners/{job['owner_id']}/takes/{payload['takeId']}/analyses/{job['id']}"
        if prefix != expected_prefix:
            raise ValueError("Analysis output prefix is not owned by this job and take")
        # Unique lease directory avoids stale-worker cleanup deleting a retry's artifacts.
        payload["outputPrefix"] = f"{prefix}/{job['lease_token']}"
        attempt_prefix = payload["outputPrefix"]
        with (
            Lease(queue, job) as lease,
            tempfile.TemporaryDirectory(prefix="flowblock-") as temporary,
        ):
            directory = Path(temporary)
            source = directory / "source.video"
            store.download(payload["videoObjectKey"], source)
            lease.check()
            result = process(source, payload, directory / "result", segmenter, lease.check)
            publish_result(
                queue,
                job,
                result,
                artifact_files(result, directory / "result"),
                store,
                lease,
                attempt_prefix,
            )
            LOG.info(
                "Analysis completed",
                extra={
                    "job_id": str(job["id"]),
                    "coverage": result["coverage"]["measuredFraction"],
                },
            )
    except LeaseLost:
        LOG.info("Analysis publication suppressed for cancelled, deleted, or expired work")
    except ValueError as error:
        queue.fail(job, str(error), retryable=False)
    except Exception as error:
        LOG.exception("Analysis failed")
        queue.fail(job, f"{type(error).__name__}: {error}", retryable=True)


def serve_queue(segmenter, health: dict, once: bool = False):
    queue = Queue(os.environ["DATABASE_URL"])
    store = ObjectStore()
    queue.ping()
    health["ready"] = True
    worker_id = os.environ.get("FLOWBLOCK_WORKER_ID", f"worker-{uuid.uuid4()}")
    heartbeat_stop = threading.Event()

    def report_health():
        while not heartbeat_stop.is_set():
            try:
                queue.worker_heartbeat(worker_id, health)
            except Exception:
                health["databaseAvailable"] = False
                LOG.exception("Worker readiness heartbeat failed")
            heartbeat_stop.wait(15)

    threading.Thread(target=report_health, daemon=True).start()
    while True:
        try:
            job = queue.claim()
            health["databaseAvailable"] = True
            if job:
                health["busy"] = True
                process_job(queue, job, segmenter, store)
                health["busy"] = False
            if once:
                heartbeat_stop.set()
                health["ready"] = False
                queue.worker_heartbeat(worker_id, health)
                return
            if not job:
                time.sleep(2)
        except Exception:
            health["databaseAvailable"] = False
            LOG.exception("Queue poll failed")
            if once:
                heartbeat_stop.set()
                raise
            time.sleep(5)
