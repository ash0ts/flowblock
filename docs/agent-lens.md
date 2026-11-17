# Agent Lens

FlowBlock sends planner and revision conversations, turns, model calls, tool calls, token usage, and errors through the Weave Conversation SDK. Agent Lens reads this same Agents data. It does not need a second exporter or duplicate conversations. The newer Forge SDK is another supported ingestion path; this app retains its pinned Weave dependency because it also supports evaluation publication.

- [Overview](https://forge.coreweave.com/agent-lens/wandb/flowblock)
- [Conversations](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations)
- [Insights](https://forge.coreweave.com/agent-lens/wandb/flowblock/insights)
- [Agent Lens documentation](https://docs.coreweave.com/products/agent-lens)

## Instrumentation

Both coordinators execute inside `weave.runIsolated`. The SDK otherwise shares active conversation state across concurrent requests. In that state, a second request can fail to start its conversation and the optional telemetry wrapper suppresses the error. Request isolation keeps each request's turns and model calls attached to its own conversation.

Provider failures and deadline failures mark the model span and invocation as failed, with distinct stop reasons. Expected invalid actions and geometry rejections remain tool observations that the agent can use to repair its next action. Turns record the final response shown to the creator, including fallback results. Planner output includes its source and plan count; revision output includes the revised plan ID. `flowblock.telemetry_version=agent-lens-v1` identifies the conversation instrumentation. The agent versions `flowblock-planner-v1.5` and `revision-v1.4` identify the current behavior described in [the workflow guide](agent-workflow.md). Frozen research runtimes and their prompts remain unchanged.

Optional initialization and flushing remain bounded by the coordinator deadline. A telemetry outage cannot discard an otherwise completed result. Trace failure counts describe execution failures; they are not scores for shot quality or semantic failure classifications.

## Workflow continuity

New API operations share one owned workflow ID across planning, upload, analysis, revision, and acceptance. Upload itself is not presented as agent reasoning. The worker exports actual download, SAM processing, and publication spans; acceptance wraps the actual database transaction. Each stage retains its own OpenTelemetry trace ID and the shared conversation ID. Retries keep distinct attempt IDs. There is no long-running synthetic root span spanning time when the creator is away.

The developer page shows the local execution ledger and a conversation link. A persisted attempt proves local execution, not successful remote trace delivery. Use authenticated readback to verify ingestion. Failed or disabled telemetry never turns an application result into a failure. [The telemetry contract](workflow-telemetry.md) documents fields, retry semantics, privacy, and limits.

The v1.4 reviewer reads evidence before receiving its next-action schema. Size-only evidence cannot authorize a duration edit. A typed abstention produces no revision; a provider or budget fallback remains explicitly labeled `library`. Invalid arguments are wrapped as `received`, preserving an empty object in Agent Lens while local raw events remain unchanged.

## Reading a conversation

Start with the agent version and final output, then inspect model/tool pairs in order. Read a rejected compile's validation codes, actual movement, and repair guidance before the next action. A later `no_progress` observation means the same rejected parameters were attempted again. A valid compile is an intermediate candidate; check whether the final response selects it, abstains, or reports incomplete planning.

Since v1.4, a collision rejection can include `repairSearch`. Its trials and options come from a deterministic bearing search inside that tool execution. They are not additional model turns or model-selected plans. Read the option's actual motion and viewing-side tradeoff, then check whether the model issues a new `compile_candidate` for its choice. Search suggestions have no candidate IDs and cannot be selected directly by `finish`.

| Attribute | Interpretation |
| --- | --- |
| `flowblock.action_outcome` | `accepted` or `rejected` tool action; rejection is still evidence even when the span has no exception |
| `flowblock.outcome` | Planner: `completed`, `checked_abstention`, `partial`, or `fallback`. Revision: `revised`, `fallback`, or `abstained`. |
| `flowblock.stop_reason` | `completed`, `repair_budget`, `action_budget`, `provider_error`, `deadline`, `not_configured`, or `unexpected_error`, as applicable |
| `flowblock.result_source` | `forge` or `library`; a library result is not model-success credit |
| `flowblock.rejected_actions` | Number of rejected actions, including the terminal rejection |
| `flowblock.compile_checks` | Compiles requested by the planner's actions; a duplicate rejected action does not trigger another compile |
| `flowblock.repair_search_compile_checks` | Additional internal deterministic compiles across bearing searches; separate from model actions and requested compiles |

In v1.5, `motion.orbit` names camera-right or camera-left traversal while facing the product, signed sweep after reversal, and actual start/end bearings. Search options also state whether they preserve the rejected candidate's signed sweep. A negative viewing bearing changes placement; it does not reverse traversal. The model must still compile its selection.

An Errors count of zero does not establish a useful plan. It can accompany a checked abstention, exhausted repair budget, or fallback. Conversely, an execution failure can still leave a usable library option. Judge task success from the returned plan and brief, then consult the matched Weave evaluation. Historical conversations retain their historical exception semantics and may not contain the new attributes.

Model messages include the submitted scene, gear, and brief. Revision tools include measured finding summaries and identifiers. Raw footage, storage URLs, and credentials are excluded. Setting `FLOWBLOCK_TRACE=0` disables export. Keep credentials server-side, as described in [operations](operations.md).

A bearing search checks at most twelve alternatives and stops after three valid suggestions. Up to three rejected compile actions can therefore add thirty-six internal checks within the six-action invocation budget. The two compile counters cover requested and repair-search work; recipe-library fallback compilation is separate. The search records actual trial counts and elapsed time, so inspect those values before comparing invocations with earlier runtimes that had no search.

## Readback

The [2026-10-29 receipt](../training/results/agent-lens-readback-2026-10-29.json) verified existing project data through authenticated read-only requests. Its window contains 50 conversations and 50 turns, with 49 planner invocations and one revision invocation. A representative candidate conversation has an invocation root, a model span carrying the trained checkpoint identifier, and a `finish` tool span. The receipt excludes messages, media, and credentials.

That readback verifies historical ingestion. [The broader campaign report](../training/experiments/next/results/campaign-report.md) links later per-arm readback and unresolved coverage. Two designed v1.3 smoke invocations, [20B](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/132106f4-da76-4090-97e5-d3a5139ccb0c) and [120B](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/5a81fb63-d6fe-4947-89ab-70aab488d7cc), have verified actions, outputs, usage, and outcome attributes. Both returned a library fallback after exhausting repairs. Verified ingestion did not make either demonstration successful.

The [October 30 example](fresh-agent-example.md) verifies a fresh v1.4 planning conversation and a v1.3 revision conversation, including exact provider messages, usage, tool observations, and outcome attributes. It also preserves the failed attempts, the interrupted upload handoff, and the separate 120B revision after 20B failed. Its synthetic same-media replay is not evidence of creator improvement.

The later [public-video workflow](public-video-workflow.md) verifies all four stages in one conversation with the default 20B model: 17 spans, including real local SAM processing and sandbox acceptance. Its preserved v1.4 failure led to planner v1.5. The successful rerun is a development diagnostic on the same exposed scenario, not a fresh confirmation result.

Local regressions exercise the installed SDK's async context and trace lifecycle without exporting spans or invoking a model. Each runtime change requires a fresh invocation and readback to establish its remote behavior. Historical failures are not rewritten.

## Insights

Insights classifications are a separate service from trace ingestion. The readback returned an empty clustering-status list. No Insights run was observed.

At the original readback, the documented classification schedule was twice daily after at least 1,000 new turns and required the organization's AI features setting. That window's 50 observed turns were below the threshold; they are not a current total for the project. An empty Insights page is compatible with working conversations and overview metrics. No classification was forced, no extra traffic was manufactured, and no organization setting was changed. Verify current service requirements before relying on a future batch schedule.

Weave evaluation scores remain distinct from Insights: deterministic qualification scores should be published through Weave evaluations, while Agent Lens shows execution traces and service-generated classifications when those are available.
