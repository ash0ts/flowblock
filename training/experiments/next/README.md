# FlowBlock research campaign

This directory separates planner qualification, video measurement, and creator benefit. A valid path is an executable result under supplied measurements. A tracking observation is an image-space measurement. Neither establishes that a creator reached a usable take faster.

The [completed campaign report](results/campaign-report.md) separates development gains from incomplete confirmation and links the [final budget receipt](results/budget-final.json). Publication verification is recorded separately from model execution.

The original twelve tasks are diagnostic data. Their recorded outputs and frozen runtime remain in the original training directories. `results/history-diagnostics.json` re-examines raw replies and clearly labels new offline recompilation. It does not replace the original comparison.

The new authored corpus contains 384 training tasks in 64 scene groups, 72 development tasks in 12 groups, and 180 confirmation tasks in 30 groups. Each group has six dependent movement requests. Geometry varies, but all splits use the same three room templates. This measures transfer to new scene instances, not unseen topology families or real creator setups.

The frozen training file contains 1,032 next-action examples: 234 productive tasks provide initial actions, successful finishes, repair actions after failed compiles, and repaired finishes; 48 hard-constraint tasks provide a compile followed by an empty finish. The 102 cases without a search witness are omitted from supervision rather than labeled impossible. These are automated solver/checker labels, without attributed cinematographer review.

`data/*/manifest.json` identifies the exact files intended for Models. Large materialized task files and JSONL stay outside Git and remain locally available. A publication is usable only after a receipt verifies its remote bytes and immutable artifact version; an attempted upload is not a verified dataset. `data/generation-runtime.json` preserves the source bytes used to generate the corpus. Protocol amendments identify later checker and transport changes without rewriting those examples.

| Entry point | Responsibility |
| --- | --- |
| `build.ts` | Generate disjoint scene groups, teacher actions, manifests and generation snapshots into a new directory |
| `grade.ts` | Recompile source facts and check executable movement, direction, travel, height, duration and supported effect |
| `search.ts` | Family-constrained finite search; an empty search is not global infeasibility |
| `planner.ts` | Planning-only JSON coordinator with six actions, two repairs and explicit completion |
| `run.ts` | Persist requests before inference, track availability, enforce budget and freeze confirmation identity |
| `budget.ts` | A shared $20 inference reserve inside the $200 authorization; retain uncertain-call reservations |
| `transport.ts` | Read-only connection warmup outside task timing; no paid-request retries |
| `train.py` | One bounded SFT job, verified dataset input lineage, submission receipt and independent checkpoint readback |
| `publish.py` | Native Models dataset producer, measured-result consumer and byte/metric/lineage verification |
| `publish-weave.ts` | Native Weave Dataset and Evaluation from recorded executions, with remote score/model readback |
| `models-results.ts` | Convert a completed execution into scalar Models metrics and an evidence Table |
| `audit-teachers.ts` | Replay frozen positive labels against the declared checker |

The deployed GPT-OSS coordinator is an application baseline. Base and trained Llama use the same research prompt, tool protocol, budgets and checker; only that matched pair estimates a training effect. The library reference receives the structured movement family and checker, so it has privileged information compared with the language models.

Training uses the final positive checkpoint from one Llama 3.1 8B SFT run, one epoch, batch size eight, peak learning rate 0.0002, cosine schedule, and loss on the last assistant turn. Invalid compile actions occur as repair context, not supervised repair targets. A checkpoint is not promoted merely because its training loss falls.

Every inference attempt has its own directory. Service failures, coordinator deadlines, unattempted tasks, model protocol failures, and successful outputs stay distinct. Raw calls remain available for diagnosis. `result.latencyMs` measures coordinator time; entry latency also includes scoring and persistence. Read-only connection and telemetry warmup are recorded separately. Token-derived cost is an estimate, not an invoice.

The provider does not expose a cancellation operation in the pinned training SDK. A client timeout does not stop a remote job. The training adapter permits one small job and records its exact source, job and checkpoint identities; it does not claim a provider-enforced dollar cap. Inspect an uncertain submission before any recovery. Dataset metadata recovery uses the same deterministic identity and a separate receipt after remote readback.

The [Objectron method](objectron.md) covers eight real, locally processed clips and preserves two exclusions. Its projected 3D boxes are a framing proxy, not segmentation ground truth. The [creator-study protocol](creator-study.md) supplies prospective collection, blinded ratings and censoring-aware descriptive scoring. No public video dataset substitutes for the controlled creator study.

Generate a new corpus only into a new path. Do not regenerate the frozen confirmation file while tuning a candidate:

```sh
node --import tsx training/experiments/next/build.ts NEW_DIRECTORY
training/.venv/bin/python training/experiments/next/publish.py MANIFEST --publish
training/.venv/bin/python training/experiments/next/train.py TRAIN_MANIFEST ACTIONS_JSONL --dataset-receipt VERIFIED_RECEIPT --protocol TRAINING_PROTOCOL --train
node --env-file=.env.local --import tsx training/experiments/next/run.ts --split development --arm llama-base --tasks TASKS_JSON --protocol EXECUTION_PROTOCOL --output NEW_ATTEMPT_DIRECTORY --budget-ledger SHARED_LEDGER --transport-warmup true
```

Confirmation additionally requires the selected checkpoint/prompt/runtime receipt and its SHA-256, plus the frozen task SHA-256. Keep dataset publication and recorded-result publication separate: importing a run into a dashboard is not another model execution.
