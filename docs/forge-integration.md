# Forge integration

FlowBlock uses Forge services for execution, inspection, and comparison. The application, PostgreSQL, media, and video worker stay local. The recorded campaigns demonstrate these integrations, with explicit gaps in execution and publication. They do not establish a successful creator study or justify promoting the trained planner.

| Service | Responsibility | Recorded evidence |
| --- | --- | --- |
| [W&B Inference](https://forge.coreweave.com/wandb/inference) | Hosted GPT-OSS planning and revision calls; trained checkpoints use the training gateway | Provider responses, token usage, and conversation spans |
| [Agent Lens](https://forge.coreweave.com/agent-lens/wandb/flowblock) | Inspect conversations, model calls, tool calls, errors, and token usage | Historical readback plus broader per-arm reconciliation, with missing traces explicitly retained; no automated Insights run observed |
| [Weave evaluations](https://forge.coreweave.com/wandb/wandb/flowblock/weave/evaluations) | Compare recorded planner outputs and video measurements | Native evaluation objects, per-task scores, and aggregate readback receipts; publication status varies by campaign |
| [W&B Models](https://forge.coreweave.com/wandb/wandb/flowblock/runs/flowblock-v2-20261029-sft) | Track datasets, optimizer metrics, and checkpoint artifacts | The broader campaign reconciled all 129 updates, input artifact, submitted configuration, and checkpoint |
| Forge Serverless Training | Run the recorded supervised LoRA training jobs | Independent completed-job and positive-checkpoint readback; neither candidate promoted |

The links above belong to the recorded FlowBlock project and require access. The local [developer view](http://127.0.0.1:3037/developer) links the currently configured project. Historical summaries remain identified as the recorded campaign when a different project is configured.

[The broader campaign report](../training/experiments/next/results/campaign-report.md) links verified Models and Weave records, partial confirmation coverage, and Agent Lens reconciliation. [The controlled follow-up](../training/experiments/validation-planner/results/report.md) preserves later planner and video diagnostics: its video evaluation is verified, while its planner imports remain unverified. Read each campaign's receipt before treating a dashboard row as a completed comparison.

[Agent decisions and evidence](agent-workflow.md) explains how these services support the product loop and which implementation failures have been addressed locally. Current code fixes do not change historical scores or create new remote evidence.

## Native evaluation publication

`training/publish-evaluations.ts` imports existing results using the pinned Weave SDK's `Dataset` and `EvaluationLogger`. It creates native evaluation and model objects and `Evaluation.evaluate` / `Evaluation.predict_and_score` calls. It makes no model requests and never runs the current product engine against historical results.

Each import retains the original attempt, frozen fixtures and prompt, source hashes, checkpoint configuration, conversation IDs, provider usage, and recorded latency. A source-derived publication ID plus a local receipt prevents blind duplicate publication. A partial or uncertain write requires readback before another attempt; the importer does not resume missing rows automatically.

The local dry run requires no credentials:

```sh
node --import tsx training/publish-evaluations.ts training/artifacts/ATTEMPT_DIRECTORY
```

Use `--publish` to upload the recorded evaluation to the configured private project. Use `--readback` to verify existing data without writing remotely:

```sh
node --env-file-if-exists=.env.local --import tsx training/publish-evaluations.ts --readback training/artifacts/ATTEMPT_DIRECTORY
```

`WANDB_ENTITY`, `WANDB_PROJECT`, and `WANDB_API_KEY` select the project. If overriding `WANDB_BASE_URL`, configure `WF_TRACE_SERVER_URL` explicitly for the matching trace service. The Forge trace proxy is `https://forge.coreweave.com/api/trace`. Do not change the running application's environment to repair a separate import process.

Readback requires one completed root, exactly the expected task IDs, completed predictions without exceptions, exact per-task outputs and scores, and the recorded aggregate summary. Receipts under [`training/results/weave-publications`](../training/results/weave-publications) distinguish `publishing`, `needs_review`, and `verified`. Only `verified` establishes a completed import. Import wall time is upload time; use `recorded_latency_ms` for the original experiment's measured latency.

Readback also compares the complete scene and gear inputs. Publication schema v2 identifies a model by its actual model/checkpoint, gateway, inference settings, and prompt hash. Existing v1 receipts preserve their original transform and IDs; reading them does not reupload a differently labeled evaluation.

## What the scores mean

Availability includes all attempted tasks. Productive-plan and accepted-abstention rates use available results; unavailable requests and unattempted tasks remain separately counted. The model receives no credit for deterministic fallback plans. An empty candidate list does not receive a vacuous geometry-validity score.

In v1, the `score_verification` label described checker compatibility even for the baseline's unavailable row. That row has a null grade and no quality scores: it was not graded. A [verified native feedback note](../training/results/weave-provenance-correction.json) corrects that label while preserving the original evidence. V2 makes this explicit with `not-scored; service-unavailable`. The historical scores and coverage are unchanged.

A productive plan matches the requested movement family and passes the recorded validator. An accepted abstention means the finite recipe search found no matching candidate; it does not prove that all camera paths are impossible. Neither score measures cinematic quality.

In the original qualification, the base, trained Llama, and GPT-OSS arms use the same archived checker. The earlier library attempt carries a different checker version; its imported scores are explicitly marked as recorded scores, without claiming they were recomputed by that older checker. That qualification covers only two synthetic scene groups, with six dependent intents per group and one trial per arm. See [the research protocol](../training/README.md). Later campaigns use their own frozen protocols and report availability and group dependence separately.

## Remaining evidence gaps

Agent Lens ingestion is verified, but automated Insights has not been observed. The live planner v1.3 and revision v1.2 changes are covered locally, not by a fresh remote model invocation. [Agent Lens details](agent-lens.md) explain how new outcome attributes differ from historical errors.

The original Models run contains its metrics and checkpoint artifacts, but its dataset input edge is missing. The later training run has independently reconciled dataset lineage. These are separate records: later recovery does not repair the original provenance. See [Models and inference](models-inference.md) for the original recovery tool and [the broader publication status](../training/experiments/next/results/forge-publication-status.json) for later receipts.

The original candidate produced zero useful matching shots in qualification. The later candidate improved over its matched base on development data and the available confirmation pairs, but confirmation was incomplete and further controlled diagnostics exposed repair and brief-preservation failures. Neither candidate is promoted. No creator time savings have been measured. Local implementation fixes require a new frozen comparison before claiming model improvement.
