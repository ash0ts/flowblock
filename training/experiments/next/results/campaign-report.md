# FlowBlock: completed development and partial confirmation

The revised trained planner produced more brief-preserving plans than its matched base on development tasks. Confirmation produced a positive paired-available difference, but infrastructure failures left most base tasks and all GPT-OSS tasks without outcomes. The planned full comparison remains incomplete. The trained candidate is not promoted, and creator benefit has not been measured.

The [final analysis](../../../artifacts/v2-analysis-final/report.json), [readable analysis](../../../artifacts/v2-analysis-final/report.md), and [per-task CSV](../../../artifacts/v2-analysis-final/tasks.csv) preserve fourteen attempts separately: four completed development arms, an initial network pilot, five failed warmups, and four confirmation arms. The original twelve-task qualification experiment remains separate and unchanged.

## What counted as a plan

A productive task returns at least one plan that passes geometry validation and preserves the supplied scene, requested family, direction, minimum movement, height, duration, framing and supported effect. This is conditional on authored geometry and approximate optics. It is not human judgment of cinematic quality or physical field validation.

The corpus has 64 training, 12 development and 30 confirmation scene groups, with six dependent movement requests per group. Splits contain new instances from three shared room templates, not unseen room families. The frozen 1,032 next-action examples contain initial plans, finishes and repairs from 234 witnessed tasks, plus checked stops from 48 explicit unsupported tasks. The 102 unresolved searches were excluded from supervision rather than labeled impossible. Labels are automated solver/checker outputs, without attributed cinematographer review.

An execution-checker amendment removed an unstated 5% apparent-size threshold. All 468 positive compile targets passed the [independent replay](independent-teacher-replay-v4.json). Historical generation sources and results were preserved. No model, prompt or teacher labels changed after the development comparison.

## Recorded outcomes

“Available” means an assessable planner result, including protocol failures. It does not mean the model completed the task. Unavailable or unattempted requests receive no quality judgment.

| Scope | Setup | Scheduled | Attempted | Available | Productive / available | Unattempted |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Development | Bounded recipe search | 72 | 72 | 72 | 58 / 72 | 0 |
| Development | Base Llama | 72 | 72 | 72 | 17 / 72 | 0 |
| Development | Trained Llama | 72 | 72 | 72 | 36 / 72 | 0 |
| Development | GPT-OSS | 72 | 72 | 72 | 12 / 72 | 0 |
| Confirmation | Bounded recipe search | 180 | 180 | 180 | 103 / 180 | 0 |
| Confirmation | Base Llama | 180 | 64 | 61 | 13 / 61 | 116 |
| Confirmation | Trained Llama | 180 | 180 | 180 | 66 / 180 | 0 |
| Confirmation | GPT-OSS | 180 | 0 | 0 | Unavailable | 180 |

The recipe search receives the structured family and checker, making it a privileged reference. GPT-OSS uses the existing product coordinator; the Llama pair shares the research coordinator, prompt, endpoint, budgets, tasks and checker. Only the matched Llama pair estimates the effect of this training treatment. No general model ranking follows from these rows.

Development improved from 17/72 to 36/72: **+26.4 percentage points**, with a 95% scene-group bootstrap interval of **12.5–41.7 points**. All 72 task pairs across 12 groups were available. The trained model solved one task without a bounded-search witness; its known-witness score was 35/58. Search failure is therefore not a proof of infeasibility.

Confirmation base attempted 64 tasks: 61 were available, one hit the coordinator deadline and two had provider failures. The fixed infrastructure-stop rule left 116 unattempted. GPT-OSS failed read-only connection warmup, with zero model requests. These arms were not rerun.

On the **61 tasks available in both Llama arms**, trained Llama passed 24 and base passed 13: **+18.0 percentage points**, 95% scene-group bootstrap interval **4.9–32.9 points**. Eleven of 30 scheduled scene groups contributed eligible quality pairs. Resampling retains whole groups and their dependent tasks. This interval conditions on observed availability; it does not correct selection from missing service outcomes or establish the effect across all 180 planned tasks.

Successful delivery across all scheduled confirmation tasks was 13/180 for base and 66/180 for trained Llama. That operational difference includes missing execution and must not be presented as a model-quality effect. Neither arm admitted an invalid returned plan under the supplied geometry. Base had three false abstentions on witnessed tasks; the trained candidate had none. Zero observed invalid admissions does not establish safety outside this corpus.

The finite recipe search found feasible, brief-preserving witnesses for 103 of the 180 confirmation tasks. Trained Llama solved 66/103 witnessed tasks; all 66 of its productive results belonged to this set. Base solved 13/31 witnessed tasks with available model outcomes. These conditional rates describe coverage where the search established a solution. The other 77 tasks include explicit unsupported requests and unresolved searches; they are not all proven impossible. The main 180-task denominator keeps that mixture visible.

## Configured deadlines and observed latency

The 30-second coordinator deadline was a configured control, not an achieved wall-clock ceiling. The base confirmation task [confirmation-010-push-in](../../../artifacts/v2-runs/confirmation-llama-base/confirmation-010-push-in.json) records **1,024.372 seconds** of coordinator elapsed time (about 17.1 minutes), then a `deadline` termination and operational-failure status. Harness elapsed time was 1,024.374 seconds. The [read-only diagnostic](deadline-overrun-diagnostic.json) found no returned response, usage or tool events. Its cause remains unresolved; these receipts do not establish model computation time or identify whether network, tracing, process scheduling or clock behavior dominated.

| Confirmation coordinator timing | Attempts | Median seconds | p95 seconds | Maximum seconds |
| --- | ---: | ---: | ---: | ---: |
| Base, all attempted | 64 | 2.711 | 8.467 | 1,024.372 |
| Base, available only | 61 | 2.715 | 8.244 | 12.554 |
| Trained, all attempted/available | 180 | 2.368 | 3.075 | 4.372 |

The available-only row excludes the operational failure and must not conceal its elapsed time. Median and p95 alone would miss this outlier. Neither the deadline setting nor these local timings establish a production latency promise. Read-only connection/telemetry warmups are recorded separately from task timing; the harness also includes scoring and persistence.

## What the diagnostics explain

[Base diagnostics](development-base-diagnostics.md) show 26 geometry-valid returned plans, only 17 preserving the brief; eight used the wrong family. Llama copied a descriptive recipe field into an unsupported override in 23 schema-invalid replies. [GPT diagnostics](development-gpt-diagnostics.md) show 61 unsupported revision calls without take evidence. Its 277 calls produced 242 logged events, so event-only error counts are incomplete. The 31 fallback tasks' 62 library plans receive no model-success credit.

Those observations motivate repair supervision, but they do not isolate which training example type caused the improvement. A valid intermediate compile also does not receive final-plan credit. Raw task receipts, provider responses and tool observations remain linked from the diagnostics.

## Training, service records and cost

One new SFT job completed 129 optimizer updates in 317.767618 seconds of reported service training time. [Independent Models reconciliation](../../../artifacts/next-training/flowblock-v2-20261029/native-models-independent-reconciliation.json) matched all 1,032 metric values, curated input artifact/digest, submitted configuration, and positive checkpoint identity. Per-update loss fell from 1.149452392 to 0.118977138. Training loss measures fitting the labels; it is not a product-outcome measure.

Native Weave records for the three completed development model arms and Objectron are verified. Native Models training and all three development model-result records have independent readback. The [Forge publication status](forge-publication-status.json) identifies exact verified receipts and other import states. Importing saved results does not execute the planner again. Agent Lens readback found token-matched conversations for 71/72 base, 41/72 GPT-OSS and 72/72 trained development tasks, with exact payload checks on representative records. Missing traces remain unresolved at those observations; no Agent Lens insights are claimed. Objectron's separate Models publication failed.

The [final budget receipt](budget-final.json) records 1,470 inference calls: 1,465 with token-derived estimates totaling **$0.74838072**, plus **$0.00964055** reserved for five unresolved calls. Their sum, $0.75802127, is not an invoice. One training job used a $170 reservation; physical GPU count and billed training dollars are unknown, and the reservation was not a provider-enforced cap. No further paid runs are scheduled.

## Video and the product question

The [Objectron diagnostic](dataset-report.md) ran the actual SAM 2.1 Small worker locally on eight real clips, preserving two exclusions from ten selected sequences. All 592 non-seed samples passed uncertainty heuristics, while inspection found apparent mask leakage and omissions. Projected cuboids support containment/extent proxies, not independent silhouette accuracy. None of this measures whether a creator finishes sooner.

The [prospective creator protocol](../creator-study.md) compares existing workflow, a recipe card and FlowBlock feedback, including an uncoached repeat for practice. It includes upload/annotation effort and blinded usable-take ratings. No creator outcomes have been collected. Complete missingness-aware confirmation and physical filming evidence are required before promoting a new default or claiming faster usable takes.

<!-- flowblock-native-publications:start -->
## Native publication readback

Snapshot: 2026-10-29T20:50:51.263Z. 13 native publications are verified below. Links require access to the private project. These are imported records or training artifacts, not additional planner executions.

| Record | Service | Verified native record |
| --- | --- | --- |
| Curated train dataset | Models | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/runs/dataset-b208f09c74df9dd36df81b06) |
| New planner SFT | Models | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/runs/flowblock-v2-20261029-sft) |
| Base development | Models | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/runs/benchmark-0a8b369afba595d3fa96f344) |
| GPT development | Models | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/runs/benchmark-45613265409bc847d764d262) |
| SFT development | Models | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/runs/benchmark-80d736fb442998b9852223ed) |
| Base development | Weave | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a188f8-5c07-7c9d-9a73-00449931dbdd) |
| GPT development | Weave | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a18954-d4ae-74ad-b063-498a3674cba4) |
| SFT development | Weave | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a18955-d3c3-7b93-bdb9-ac4abf2bae8c) |
| Library confirmation | Weave | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a1895b-f121-7f64-8b66-b896c0d30393) |
| Base confirmation | Weave | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a1895b-f49b-7c7b-baf0-64d3a849c47b) |
| SFT confirmation | Weave | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a1895d-6064-78c9-9d7a-c4cc2716aa61) |
| GPT confirmation | Weave | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a1895e-c6a3-70b1-af6c-1b7e27ecee03) |
| Objectron diagnostic | Weave | [Open](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a188e4-5291-75e8-be9f-642127d8a0f1) |

Other states remain explicit: Confirmation dataset recovery (Models): `partial`; Objectron diagnostic (Models): `failed`. The [publication status](forge-publication-status.json) hashes every source receipt.
<!-- flowblock-native-publications:end -->
