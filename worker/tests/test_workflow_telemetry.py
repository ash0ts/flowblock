import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from flowblock_worker import workflow_telemetry as telemetry


@pytest.fixture
def job():
    created = datetime(2026, 10, 30, tzinfo=timezone.utc)
    return {
        "id": str(uuid4()),
        "lease_token": str(uuid4()),
        "attempt": 1,
        "created_at": created,
        "heartbeat_at": created + timedelta(seconds=3),
        "payload": {
            "workflowTrace": {
                "schemaVersion": "1.0",
                "workflowId": str(uuid4()),
                "stage": "analysis",
                "attemptId": str(uuid4()),
                "attempt": 1,
                "parentAttemptId": str(uuid4()),
                "takeId": str(uuid4()),
                "planId": "plan-fixture",
            },
            "videoObjectKey": "private/path",
            "signedUrl": "https://private?token=secret",
        },
    }


@pytest.fixture
def exporter(monkeypatch):
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    monkeypatch.setattr(telemetry, "_tracer", lambda: provider.get_tracer("test"))
    monkeypatch.setattr(telemetry, "_provider", None)
    yield exporter
    provider.shutdown()


def test_same_conversation_new_lease_attempt_and_real_child_spans(job, exporter):
    with telemetry.analysis_trace(job) as handle:
        assert not exporter.get_finished_spans()
        with handle.step("processing"):
            assert not exporter.get_finished_spans()
        handle.finish(
            "needs_review", measured_frames=40, expected_frames=75, finding_count=2, device="mps"
        )
    first = exporter.get_finished_spans()
    assert len(first) == 2
    child, root = first
    assert child.parent.span_id == root.context.span_id
    assert child.context.trace_id == root.context.trace_id
    assert root.attributes["flowblock.stage_outcome"] == "needs_review"
    assert root.attributes["flowblock.attempt_id"] == job["lease_token"]
    assert root.attributes["flowblock.queue_time_ms"] == 3000
    assert (
        root.attributes["gen_ai.conversation.id"] == job["payload"]["workflowTrace"]["workflowId"]
    )
    job["lease_token"], job["attempt"] = str(uuid4()), 2
    with telemetry.analysis_trace(job) as handle:
        handle.finish("succeeded", measured_frames=75, expected_frames=75, finding_count=1)
    retry = exporter.get_finished_spans()[-1]
    assert retry.attributes["gen_ai.conversation.id"] == root.attributes["gen_ai.conversation.id"]
    assert retry.context.trace_id != root.context.trace_id
    assert retry.attributes["flowblock.attempt_id"] != root.attributes["flowblock.attempt_id"]
    assert (
        retry.attributes["flowblock.parent_attempt_id"]
        == root.attributes["flowblock.parent_attempt_id"]
    )
    assert "flowblock.queue_time_ms" not in retry.attributes


def test_unhandled_error_has_no_private_message_or_traceback(job, exporter):
    failure = RuntimeError("https://private?token=secret")
    with pytest.raises(RuntimeError) as caught:
        with telemetry.analysis_trace(job) as handle:
            with handle.step("download"):
                raise failure
    assert caught.value is failure
    spans = exporter.get_finished_spans()
    assert len(spans) == 2
    assert all(span.status.status_code == StatusCode.ERROR for span in spans)
    serialized = json.dumps([dict(span.attributes) for span in spans])
    assert "secret" not in serialized and "private/path" not in serialized
    assert all(not span.events for span in spans)
    assert spans[-1].attributes["flowblock.stage_outcome"] == "failed"


def test_no_implicit_success(job, exporter):
    with telemetry.analysis_trace(job):
        pass
    assert exporter.get_finished_spans()[0].attributes["flowblock.stage_outcome"] == "unknown"


def test_missing_or_untrusted_metadata_does_not_initialize_exporter(job, monkeypatch):
    def unexpected():
        pytest.fail("Old or invalid jobs must not initialize a tracer")

    monkeypatch.setattr(telemetry, "_tracer", unexpected)
    with telemetry.analysis_trace({"payload": {}}) as handle:
        handle.finish("succeeded")
    job["payload"]["workflowTrace"]["signedUrl"] = "private"
    with telemetry.analysis_trace(job) as handle:
        assert handle.span is None


def test_trace_failure_does_not_fail_analysis(job, monkeypatch):
    def broken():
        raise RuntimeError("Exporter configuration failed")

    monkeypatch.setattr(telemetry, "_tracer", broken)
    with telemetry.analysis_trace(job) as handle:
        with handle.step("processing"):
            result = 75
        handle.finish("succeeded", measured_frames=result)
    assert result == 75


def test_export_configuration_uses_explicit_base_without_query_credentials(monkeypatch):
    monkeypatch.setenv("WANDB_BASE_URL", "https://api.forge.coreweave.com")
    monkeypatch.setenv("WF_TRACE_SERVER_URL", "https://forge.coreweave.com/api/trace")
    assert telemetry._endpoint() == "https://forge.coreweave.com/api/trace/agents/otel/v1/traces"
    monkeypatch.setenv("WF_TRACE_SERVER_URL", "https://user:secret@host/trace")
    with pytest.raises(ValueError):
        telemetry._endpoint()


def test_counts_and_device_allowlist_does_not_accept_arbitrary_metadata(job, exporter):
    with telemetry.analysis_trace(job) as handle:
        handle.finish("succeeded", measured_frames=True, finding_count=8, device="private-path")
    output = json.loads(exporter.get_finished_spans()[0].attributes["gen_ai.output.messages"])
    assert json.loads(output[0]["parts"][0]["content"]) == {"status": "succeeded"}


def test_flush_is_bounded_and_failure_is_optional(monkeypatch):
    class FailedProvider:
        def force_flush(self, timeout_millis):
            assert timeout_millis == 200
            raise RuntimeError("Network unavailable")

    monkeypatch.setattr(telemetry, "_provider", FailedProvider())
    assert telemetry.flush_workflow_telemetry() is False
