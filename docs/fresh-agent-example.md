# Fresh plan, analysis, and revision example

On October 30, 2026, FlowBlock completed a designed integration example with hosted inference, local SAM segmentation, an accepted plan revision, and same-media reanalysis. The successful path used GPT-OSS 20B for planning and a separately declared GPT-OSS 120B revision after the 20B revision failed. The default application model remains 20B. This is development evidence on an exposed case, not a held-out evaluation or a creator outcome.

The [summary receipt](../training/results/fresh-agent-loop-2026-10-30.json) contains the versions, identifiers, measurements, preserved failures, and hashes of the local source receipts.

## Follow the decisions

Open the [successful planning conversation](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/273834a4-0b66-4be7-b167-a6c009f3e74e), then the [successful revision conversation](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/08ea0bbb-472b-4174-a16e-571d893d50d0).

| Step | Recorded behavior | What to inspect |
| --- | --- | --- |
| Brief | Keep a rightward 45° orbit, five seconds, 1.3 m camera height, fixed equipment, and wide framing. | The planning model's initial input. |
| Rejection | The default quarter-orbit intersects the fixed equipment case with the supplied operator envelope. | First `compile_candidate`: `operator_obstacle`, rejected action. |
| Search | The deterministic engine checks ten bearing alternatives and returns three valid suggestions: −45°, −60°, and −90°. | `repairSearch.trials`, `options`, and their viewing-side tradeoffs. These are internal tool work, not model actions. |
| Choice | The model chooses −45°, explicitly compiles it, then selects its candidate ID. | Second `compile_candidate`, then `finish`. Radius is recomputed to 2.082 m; sweep, duration, height, scene, gear, and intent are preserved. |
| Measurement | Fresh SAM 2.1 Small inference on Apple MPS measures all 75 frames of a five-second synthetic clip. | Analysis job `53c2c315-29a0-447d-882d-1d59cca4c98d`. The ending size ratio is 1.854 at 4.933 s, outside the rule's 0.75–1.25 range. |
| Correction | The 120B revision agent reads the findings and proposes `distance: 2.5`, citing `size:ending:0`. | `read_take_findings`, then `propose_revision`. The revised path passes geometry validation and retains the 45° sweep. |
| Acceptance | The driver accepts the proposal against its parent plan and saves a new immutable project version. | Acceptance and project readback receipts. This is automated demo acceptance, not an observed creator decision. |
| Reanalysis | Fresh SAM inference processes the same bytes against the revised plan. The ending ratio is 2.241 and remains a finding. | Replay job `a9f54627-a072-431e-ac03-a231aba19d30`. A smaller projected target does not change existing footage. |

The size metric is the square root of the product bounding-box area relative to the projected target. It is not a measured physical distance or a calibrated segmentation confidence. The synthetic clip was not filmed along the generated orbit.

The model's proposed increase in distance is an experiment. Its raw explanation says it will bring the size within the allowed range, which the evidence does not establish. The application replaces that claim with its constrained explanation: try the planned distance and compare another take; the footage does not establish the physical cause.

## Read the trace accurately

The planning root reports `flowblock.outcome=completed`, `flowblock.result_source=forge`, one rejected action, two requested compiles, and ten additional repair-search compiles. It contains three model spans and three tool spans. The revision root reports `revised`, `forge`, and `completed`, with two model spans and two tool spans.

Both successful conversations were read back from Agent Lens and compared with the application's recorded provider requests, responses, usage, tool arguments, tool results, versions, and final outputs. All those checks passed. The source plan ID and analysis job ID link the revision to the actual measured evidence. A separate project readback confirmed the accepted revised plan was persisted.

This is not one continuous Agent Lens trace. Worker processing, acceptance, persistence, and replay have application receipts, but no Agent Lens spans. The two agent conversations are connected through their recorded IDs. The browser dashboard stalled during inspection, so the remote records were verified through the API; no dashboard screenshot is offered as proof of rendering.

## Preserved failures

The successful path followed these recorded failures:

- Planner v1.3 exhausted repairs with both [20B](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/132106f4-da76-4090-97e5-d3a5139ccb0c) and [120B](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/5a81fb63-d6fe-4947-89ab-70aab488d7cc). Planner v1.4 added bounded bearing-search feedback afterward.
- The first [v1.4 attempt](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/bb1ce01b-93ac-40d2-8cfa-a71d17d81a2b) reached its 30-second deadline after its first provider response took 27.2 seconds. The unresolved second request retains its budget reservation. A separately recorded attempt with the same runtime then completed planning.
- The demo driver stopped before uploading bytes because the local API returned `localhost` while the driver used `127.0.0.1`. A recorded continuation used the documented owned upload endpoint and retained the same saved plan, project, and take. This was not an uninterrupted run.
- The [20B revision](https://forge.coreweave.com/agent-lens/wandb/flowblock/conversations/517e9daa-ddb1-4a16-83d9-e08a035f69af) proposed a duration change against size evidence, then emitted invalid actions. The validator rejected them. Its 2.33 m library fallback was not used or credited as an agent correction. The subsequent 120B revision reused the same plan and measurements.

After the recorded workflow finished, local upload URLs were changed to relative endpoints so the browser retains its current origin. Regression checks cover loopback origins and preservation of absolute signed S3 URLs. The recorded demonstration used the documented continuation; it did not execute this later upload fix.

The failed 20B revision's readback remains `needs_review`: two validation tool inputs emitted as `{}` were stored as empty strings. All eleven spans, model messages, usage, tool outputs, and root attributes otherwise reconcile. The original mismatch receipt is preserved; exact tool-input verification is not claimed for that conversation.

The complete sequence used eighteen new inference requests. Estimated charges plus the retained unknown-usage reservation total $0.00440277, using conservative rates for 120B. This is not an invoice amount and excludes prior training.

## What this establishes

The agent can select a solver-discovered alternative after a real rejection and propose one cited, feasible experiment after reading real measurements. The tools enforce geometry and citation relevance. Tracing makes both the successful choices and the failed attempts inspectable.

This single case does not establish reliable default-model revisions, superiority of 120B, improved footage, or faster usable takes. The [workflow guide](agent-workflow.md) describes the implementation boundaries; the [creator study](../training/experiments/next/creator-study.md) describes the separate outcome test still needed.
