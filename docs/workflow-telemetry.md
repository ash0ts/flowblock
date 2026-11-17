# Workflow conversations and execution attempts

FlowBlock groups planning, analysis, revision, and acceptance under one persisted `workflowId`. That UUID is also the Agent Lens `conversationId`. The API owns the workflow and checks account ownership before attaching another operation. The telemetry contract also accepts an explicit `replay` stage, reserved for a trusted replay caller; the current upload API always schedules `analysis`. An accepted plan does not establish whether a later upload is a new take or the same media.

A conversation is a grouping key, not an open span. Weave 0.16.10 starts each turn at an OpenTelemetry root; the stages therefore have different trace IDs. Reopening the same conversation ID joins the stages without inventing a span covering idle time between requests. This follows the documented [Agent Lens conversation model](https://docs.coreweave.com/products/wandb/weave/guides/tracking/trace-agents-otel).

## Context and identity

The strict `WorkflowTraceContextSchema` in [workflow-telemetry.ts](../src/server/workflow-telemetry.ts) contains the workflow UUID, stage, attempt UUID, attempt number, and optional parent attempt, job, plan, and take IDs. It rejects extra fields and URL-shaped identifiers. The stable agent name is `FlowBlock workflow`; `flowblock.stage` distinguishes the operations. `flowblock.parent_attempt_id` records the causal connection across turns.

The TypeScript API creates and persists contexts transactionally. Allocating a context does not emit a span. A real execution uses a unique attempt ID; retries retain the earlier records. The UUID identifies an attempt unambiguously. A worker attempt number is the job's lease-attempt counter, so different analysis jobs can each have attempt number one.

Analysis enqueue stores scheduling context in `payload.workflowTrace` without inserting a running execution attempt. At claim, [jobs.py](../worker/flowblock_worker/jobs.py) uses the new lease token as the actual attempt ID and creates the attempt row in the same transaction as the claim. It closes a superseded running attempt as failed with reason `lease_expired`. Jobs without workflow context retain their existing behavior.

## What is recorded

The coordinators keep their model and tool spans. [runWorkflowStage](../src/server/workflow-telemetry.ts) wraps actual application operations in an isolated SDK context. Its completion callback supplies an explicit status and allowlisted counts or result IDs. A malformed completion summary produces `unknown`, and an exception produces a sanitized failure while preserving the original application exception. The helper never infers success from missing metadata.

The [worker helper](../worker/flowblock_worker/workflow_telemetry.py) emits an analysis or replay turn and child spans around download, processing, and publication. It sends no footage, masks, storage keys, signed URLs, arbitrary exception messages, or tracebacks. Counts, device names, operation names, and identifiers are allowlisted. Success is recorded only after publication is confirmed. Uncertain commit acknowledgement remains `publication_unknown`; it does not authorize artifact deletion or a success claim.

Worker completion and failure update the attempt row within the same transaction as the guarded job update. Cancellation and lease-loss handling can close only the matching attempt. A stale worker cannot change a newer attempt or publish a result. Existing artifact cleanup and publication readback rules still apply.

The worker records `flowblock.job_age_at_start_ms` from job creation to the claim timestamp. On the first attempt it also records `flowblock.queue_time_ms`. On retries the age includes earlier processing, so it is not reported as queue time. Span duration measures the actual attempt after instrumentation starts.

## Configuration and failure behavior

`WANDB_API_KEY`, `WANDB_ENTITY`, and `WANDB_PROJECT` configure export. `FLOWBLOCK_TRACE=0` disables it. The API uses the pinned Weave SDK; the worker uses the pinned OpenTelemetry SDK and protobuf HTTP exporter, both version 1.38.0. The [documented OTLP endpoint](https://docs.coreweave.com/products/wandb/weave/guides/tracking/trace-agents-otel) accepts these worker spans without installing Weave in the model environment.

`WF_TRACE_SERVER_URL` overrides the trace base in both processes. Without it, the cloud API host maps to `https://trace.wandb.ai`; a custom `WANDB_BASE_URL` maps to its `/traces` route. A Forge API override therefore needs an explicit working trace base, such as the configured Forge proxy. Credentials belong in exporter headers, never URLs or trace attributes.

API initialization and flush each have a one-second telemetry budget. Worker export runs in a bounded batch queue with a two-second exporter timeout; attempt cleanup waits at most 200 ms for a flush. Export failure cannot turn a successful operation into a failed job. Telemetry remains best effort: process termination or network loss can leave spans missing. The persisted attempt ledger is the execution record. Lease recovery may close an old database attempt, but it does not manufacture an ended remote span for the dead process.

Local tests use in-memory spans and isolated PostgreSQL schemas. They verify conversation reuse, attempt isolation, sanitized failures, cancellation, stale leases, publication, and queue-age semantics. Remote visibility requires a separate readback of the executed workflow; these tests do not establish export or dashboard rendering.

## Readback

[read-workflow.ts](../training/read-workflow.ts) queries the actual spans for one workflow and compares them with a saved response from `GET /api/workflows/:id`. Run it with the same project and trace endpoint configuration as the application:

```sh
node --env-file=.env.local --import tsx training/read-workflow.ts \
  --workflow WORKFLOW_UUID \
  --ledger training/artifacts/example/workflow-result.json \
  --output training/artifacts/example/readback
```

The reader checks attempt IDs, stage attributes, parent links, conversation identity, terminal status, and completeness. Distinct stage trace IDs are expected. A missing span, a truncated result, or an unknown outcome remains a discrepancy. The read is bounded to 30 seconds without retries; SDK initialization has a separate 30-second limit. It never changes a trace or runs a model.

Optional `--calls`, `--planner`, and `--revision` arguments reconcile model request and response snapshots with the model spans and local tool events. The calls directory must contain numbered `INDEX-request.json` and `INDEX-response.json` receipts from the recording proxy. Without those independent snapshots, the report explicitly leaves model input verification unclaimed. Span details are limited to the fields needed for reconciliation and redacted before writing; receipts go to ignored local artifacts by default. Existing receipts are never overwritten.
