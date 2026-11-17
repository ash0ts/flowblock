"""Optional metadata-only Agent Lens spans for actual leased analysis attempts."""

from __future__ import annotations

import json
import math
import os
import re
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from urllib.parse import urlsplit

from opentelemetry import trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status, StatusCode

AGENT_NAME = "FlowBlock workflow"
TELEMETRY_VERSION = "flowblock-workflow-v1"
_provider = None
_lock = threading.Lock()
_CONTEXT_KEYS = {
    "schemaVersion",
    "workflowId",
    "stage",
    "attemptId",
    "attempt",
    "parentAttemptId",
    "jobId",
    "planId",
    "takeId",
}
_OUTCOMES = {
    "succeeded",
    "needs_review",
    "failed",
    "cancelled",
    "lease_lost",
    "publication_unknown",
}
_STEPS = {"download", "processing", "publication"}


def _uuid(value):
    return str(uuid.UUID(str(value)))


def _timestamp(value):
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not isinstance(value, datetime):
        raise ValueError("Missing timestamp")
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


def workflow_attributes(job):
    context = job.get("payload", {}).get("workflowTrace")
    if not isinstance(context, dict) or set(context) - _CONTEXT_KEYS:
        return None
    try:
        if context.get("schemaVersion") != "1.0" or context.get("stage") not in {
            "analysis",
            "replay",
        }:
            return None
        attempt = job["attempt"]
        if type(attempt) is not int or not 1 <= attempt <= 1_000_000:
            return None
        workflow_id = _uuid(context["workflowId"])
        attrs = {
            "gen_ai.conversation.id": workflow_id,
            "gen_ai.agent.name": AGENT_NAME,
            "gen_ai.agent.version": TELEMETRY_VERSION,
            "flowblock.workflow_id": workflow_id,
            "flowblock.workflow_telemetry_version": TELEMETRY_VERSION,
            "flowblock.stage": context["stage"],
            "flowblock.attempt_id": _uuid(job["lease_token"]),
            "flowblock.attempt": attempt,
            "flowblock.job_id": _uuid(job["id"]),
        }
        for key, attr in [("parentAttemptId", "parent_attempt_id"), ("takeId", "take_id")]:
            value = context.get(key)
            if value is not None:
                attrs[f"flowblock.{attr}"] = _uuid(value)
        plan_id = context.get("planId")
        if plan_id is not None:
            if not isinstance(plan_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", plan_id):
                return None
            attrs["flowblock.plan_id"] = plan_id
        try:
            claimed = _timestamp(job.get("heartbeat_at") or job.get("updated_at"))
            age = (claimed - _timestamp(job["created_at"])).total_seconds() * 1000
            if math.isfinite(age) and age >= 0:
                attrs["flowblock.job_age_at_start_ms"] = int(age)
                if attempt == 1:
                    attrs["flowblock.queue_time_ms"] = int(age)
        except (ValueError, TypeError, KeyError):
            pass
        return attrs
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def _endpoint():
    # Match the JS SDK: a non-cloud W&B base needs its /traces route or an explicit override.
    base = os.environ.get("WANDB_BASE_URL", "https://api.wandb.ai").rstrip("/")
    endpoint = os.environ.get("WF_TRACE_SERVER_URL") or (
        "https://trace.wandb.ai" if base == "https://api.wandb.ai" else f"{base}/traces"
    )
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"https", "http"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or (parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"})
    ):
        raise ValueError("Invalid trace endpoint")
    return f"{endpoint.rstrip('/')}/agents/otel/v1/traces"


def _tracer():
    global _provider
    if os.environ.get("FLOWBLOCK_TRACE") == "0":
        return None
    key, entity = os.environ.get("WANDB_API_KEY"), os.environ.get("WANDB_ENTITY")
    project = os.environ.get("WANDB_PROJECT", "flowblock")
    if (
        not key
        or not entity
        or any(not re.fullmatch(r"[A-Za-z0-9_.-]+", s) for s in [entity, project])
    ):
        return None
    try:
        with _lock:
            if _provider is None:
                exporter = OTLPSpanExporter(
                    endpoint=_endpoint(), headers={"wandb-api-key": key}, timeout=2
                )
                provider = TracerProvider(
                    resource=Resource(
                        {
                            "wandb.entity": entity,
                            "wandb.project": project,
                            "service.name": "flowblock-worker",
                        }
                    )
                )
                provider.add_span_processor(
                    BatchSpanProcessor(
                        exporter,
                        max_queue_size=128,
                        max_export_batch_size=16,
                        schedule_delay_millis=500,
                        export_timeout_millis=2000,
                    )
                )
                _provider = provider
            return _provider.get_tracer("flowblock.workflow", TELEMETRY_VERSION)
    except Exception:
        return None


def flush_workflow_telemetry(timeout_millis=200):
    """Best-effort bounded flush; failure never changes the job's publication outcome."""
    try:
        return _provider is None or _provider.force_flush(timeout_millis=timeout_millis)
    except Exception:
        return False


class AnalysisTrace:
    def __init__(self, tracer=None, span=None, attributes=None):
        self.tracer, self.span, self.attributes = tracer, span, attributes or {}
        self.outcome = "unknown"

    def finish(
        self, status, *, measured_frames=None, expected_frames=None, finding_count=None, device=None
    ):
        if status not in _OUTCOMES:
            return
        summary = {"status": status}
        for name, value in [
            ("measuredFrames", measured_frames),
            ("expectedFrames", expected_frames),
            ("findingCount", finding_count),
        ]:
            if type(value) is int and value >= 0 and (name != "findingCount" or value <= 2):
                summary[name] = value
        if device in {"cpu", "mps", "cuda"}:
            summary["device"] = device
        self.outcome = status
        try:
            if self.span:
                self.span.set_attribute("flowblock.stage_outcome", status)
                self.span.set_attribute(
                    "gen_ai.output.messages",
                    json.dumps(
                        [
                            {
                                "role": "assistant",
                                "parts": [{"type": "text", "content": json.dumps(summary)}],
                            }
                        ]
                    ),
                )
                if status in {"failed", "publication_unknown"}:
                    self.span.set_status(Status(StatusCode.ERROR))
        except Exception:
            pass

    @contextmanager
    def step(self, name):
        child = None
        if self.tracer and self.span and name in _STEPS:
            try:
                child = self.tracer.start_span(
                    f"execute_tool {name}",
                    attributes={
                        **self.attributes,
                        "gen_ai.operation.name": "execute_tool",
                        "gen_ai.tool.name": name,
                    },
                    context=trace.set_span_in_context(self.span),
                )
            except Exception:
                pass
        try:
            yield
        except BaseException:
            try:
                if child:
                    child.set_status(Status(StatusCode.ERROR))
                    child.set_attribute("error.type", "WorkerStepError")
            except Exception:
                pass
            raise
        finally:
            try:
                if child:
                    child.end()
            except Exception:
                pass


@contextmanager
def analysis_trace(job):
    """A new real lease attempt joins its persisted conversation; old jobs are no-ops."""
    handle = AnalysisTrace()
    try:
        attrs = workflow_attributes(job)
        tracer = _tracer() if attrs else None
        if tracer:
            span = tracer.start_span(
                f"invoke_agent {AGENT_NAME}",
                attributes={
                    **attrs,
                    "gen_ai.operation.name": "invoke_agent",
                    "flowblock.stage_outcome": "running",
                },
                context=Context(),
            )
            handle = AnalysisTrace(tracer, span, attrs)
    except Exception:
        pass
    try:
        yield handle
    except BaseException:
        handle.finish("failed")
        try:
            if handle.span:
                handle.span.set_attribute("error.type", "WorkerStageError")
        except Exception:
            pass
        raise
    finally:
        try:
            if handle.span:
                handle.span.set_attribute("flowblock.stage_outcome", handle.outcome)
                handle.span.end()
                flush_workflow_telemetry()
        except Exception:
            pass
