# Public-video workflow, October 30, 2026

FlowBlock completed planning, real SAM analysis, an evidence-linked revision, and automated sandbox acceptance with the default `openai/gpt-oss-20b`. [The Agent Lens conversation](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/3ef6be86-63d5-424b-93d9-09a67be94135) contains all four stages. Authenticated readback reconciled 17 spans, five model calls, their exact provider messages and usage, tool arguments and results, and the persisted attempt chain. The four stages have distinct real trace IDs under one conversation.

This is an integration and development check. The five-second public Objectron bottle recording was made independently of FlowBlock. Its room, equipment, and intended framing are unknown. The test uses an authored room and framing targets; it does not reconstruct the recorded scene or measure whether guidance helped a creator.

## Read the trace in this order

| Stage | What actually happened | What to inspect |
| --- | --- | --- |
| Planning | The model compiled a 45° camera-right orbit at bearing +45°. The engine rejected a collision with the light stand. After inspecting deterministic search suggestions, the model compiled and selected bearing −45°, preserving the 45° sweep, five-second duration, 1.3 m height, and wide framing. | The rejected compile, `repairSearch`, the next model-selected compile, and the final selected ID. The twelve internal search checks are deterministic work, not twelve agent decisions. |
| Analysis | The local SAM 2.1 Small worker processed 75 frames from Objectron `bottle/batch-40/29`, returning two size findings and no heuristic-uncertain frames in this execution. | Actual download, processing, and publication spans; the source take and plan IDs. Media and storage URLs are excluded from traces. |
| Revision | The model read the findings and cited `size:middle:0`: at 2.47 seconds, the square root of tracked bounding-box area was 3.07 times the authored target. It proposed increasing planned radius from 2.082 m to 2.5 m. | `read_take_findings`, then `propose_revision`, its cited finding, and successful revalidation. The video does not establish physical distance or why the framing differs. |
| Acceptance | The test harness explicitly accepted that revision through the application API. The immutable revised plan and terminal attempt record were committed together. | The acceptance span's result plan ID and its matching local ledger entry. This was automated sandbox acceptance, not a creator's judgment. |

The agent chose the repair and the evidence-linked parameter change; application code bounded the available actions and validated both plans. Both planning and revision used the default 20B model without a library fallback or a larger-model retry. The revision is a proposed next experiment. No second take was recorded or evaluated in this workflow.

There is still a procedural miss: the brief asked to check the default front-centered orbit first, but the model's first compile used bearing +45°. The returned plan preserves the specified movement and permitted viewing-side compromise, but this run is not a perfect instruction-following result.

## Fixes behind this execution

Planner v1.5 separates viewing bearing from orbit traversal in tool observations and repair suggestions. A negative bearing does not reverse a positive camera-right sweep. The model still has to choose and compile an alternative; suggestions cannot be passed straight to `finish`.

Revision v1.4 reads measured findings before receiving its permitted revision schema. Size evidence authorizes a distance experiment, not an unrelated duration change. Explicit abstention creates no revision, and repeated rejected proposals terminate without fabricated progress. Empty invalid arguments survive trace normalization as `received` values.

Owned workflow IDs now connect API jobs, real worker attempts, revisions, and acceptance. Retries keep separate attempts; cancellation and deletion guard publication; edits that change the plan clear stale workflow attribution. The developer page distinguishes local execution records from verified remote ingestion. See [the telemetry contract](workflow-telemetry.md).

## Preserved failed attempt

The preceding [v1.4 conversation](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/b1bf7f85-83fe-46c4-96c6-80e6fcf6fdf2) returned a checked abstention despite feasible search suggestions. The model confused negative viewing bearing with reversed traversal. Its five spans and two model calls were read back and preserved. That failure prompted v1.5; the later success uses the same exposed scenario and is a diagnostic, not a held-out improvement score.

Before that model execution, the temporary harness had an incorrect `APP_URL` and received HTTP 403. No planning job or model call ran. The continuation corrected the harness origin without changing application origin checks. The infrastructure failure, failed model attempt, frozen runtimes, and successful diagnostic all remain separate artifacts.

## Public-video cohort

A separate run processed all eight available clips from the existing ten-sequence Objectron selection. The two original exclusions remain: a recording shorter than five seconds and an unavailable annotation. These recordings had already been inspected, so this is a development regression check.

Of 592 non-seed observations, 591 passed the worker's tracking heuristics. The remaining bottle observation was marked uncertain. This is **99.83% heuristic usable coverage**, not segmentation accuracy or usable-take rate. Projected 3D cuboids provide discrepancy proxies, not visible-mask ground truth. Sampled overlays still show possible background leakage and omitted product regions.

- [Models benchmark](https://forge.coreweave.com/wandb/wandb/flowblock/runs/benchmark-15a84f079fb00539cb9d7e94): all 12 metrics and every cell in the ten-row, nineteen-column results table were read back and matched.
- [Weave evaluation](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a18ecd-e40d-775b-a817-1a570fc3c840): all ten rows, scores, aggregates, dataset references, and model configuration matched. This imports completed local processing; evaluation import duration is not SAM latency.
- [Cohort receipt](../training/experiments/field-validation/results/public-video-repeat-2026-10-30.json): exclusions, denominators, proxies, hashes, qualitative observations, and publication readbacks.

The separate API workflow's 75/75 coverage and the cohort's 591/592 non-seed coverage have different executions and denominators. They must not be combined. Neither establishes calibrated tracking confidence or creator benefit.

## Reproduction and remaining evidence

[The workflow receipt](../training/results/public-video-workflow-2026-10-30.json) records versions, source hashes, remote verification, and local artifact paths. Raw trace records and public media remain in ignored local storage. The successful runtime readback matched all 63 frozen source files.

This round added seven hosted inference calls across the failed and successful diagnostics, with a combined rate-based estimate of $0.00079008. The estimate is not an invoice. No training or remote infrastructure was provisioned. Local app, database, and SAM processing remain local.

Public videos exercise segmentation and the evidence-to-revision integration. A fresh, frozen planner confirmation set is still required to assess generalization after these fixes. Time to a usable take, correction usefulness, and voluntary reuse still require a creator study; these public recordings cannot supply that treatment comparison.
