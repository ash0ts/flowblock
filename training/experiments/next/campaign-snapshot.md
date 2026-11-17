# Developer research snapshot

The developer page reads the checked-in [campaign-summary.json](results/campaign-summary.json) through [the typed loader](../../../src/server/campaign-summary.ts). It is a metadata-only snapshot of the private `wandb/flowblock` project. It does not query services, inherit the viewer's configured project, regrade runs, or expose footage, prompts, credentials or signed URLs. The original twelve-task record remains separate.

Generate a replacement with `campaign_snapshot.py`. Supply the analyzer report and every attempt to display explicitly; the script does not choose the newest or best-scoring attempt. Development and confirmation retain separate cohort labels. Initial pilots cannot enter the comparison table. Available outcomes are the quality denominator; unavailable outcomes are not assigned a zero quality score. Attempted-but-unavailable tasks and unattempted tasks remain separate. When availability is incomplete, the table also shows productive delivery over all scheduled tasks. Paired estimates remain conditional on availability; outages may select the measured subset.

```sh
python3 training/experiments/next/campaign_snapshot.py \
  --analysis training/artifacts/v2-analysis-final/report.json \
  --attempt 2026-10-29T18-11-58-321Z-library-75823d38 \
  --attempt 2026-10-29T18-20-24-724Z-llama-base-b8620514 \
  --attempt 2026-10-29T18-34-17-513Z-gpt-oss-94f32993 \
  --attempt 2026-10-29T18-56-34-864Z-llama-sft-1c6b56a4 \
  --attempt 2026-10-29T19-04-21-481Z-library-c7203722 \
  --attempt 2026-10-29T19-04-22-864Z-llama-base-e6285a4d \
  --attempt 2026-10-29T20-21-26-229Z-llama-sft-2bd7dfb0 \
  --attempt 2026-10-29T20-29-38-701Z-gpt-oss-1ff2c4ac \
  --training-receipt training/artifacts/next-training/flowblock-v2-20261029/registration-recovery-4ada4cc527bb/attempt.json \
  --training-readback training/artifacts/next-training/flowblock-v2-20261029/registration-recovery-4ada4cc527bb/independent-job-2026-10-29T18-56-31.460459+00-00.json \
  --confirmation-state completed \
  --confirmation-runtime training/experiments/next/data/execution-runtime-v6.json \
  --evidence 'Objectron tracking — Weave evaluation=training/experiments/next/results/weave-publications/fe81860e3c760bb61819103089bfa04d8d39b66803dfcb45948c9dd24d49c49f.json' \
  --evidence 'Solver-checked training dataset — W&B Models=training/artifacts/next-publications/recoveries/train-final-resume-1809Z/dataset-b208f09c74df9dd36df81b06.json' \
  --evidence 'SFT optimizer history and checkpoint — W&B Models=training/artifacts/next-training/flowblock-v2-20261029/native-models-independent-reconciliation.json' \
  --evidence 'Base Llama development — W&B Models=training/artifacts/v2-runs/development-llama-base-connected/models-metric-recovery/receipt.json' \
  --evidence 'Base Llama development — Weave evaluation=training/experiments/next/results/weave-publications/e27f9481a7e4b4267ab46c304cd8a37a70f55e1942265a9bfebe9ab392659494.json' \
  --evidence 'GPT-OSS development — W&B Models=training/artifacts/next-publications/benchmark-45613265409bc847d764d262.json' \
  --evidence 'GPT-OSS development — Weave evaluation=training/experiments/next/results/weave-publications/b5d549f8890ccdc864d2b6bc82ce076027d5b40a79de407d8c2416507447cd0c.json' \
  --evidence 'Trained Llama development — Weave evaluation=training/experiments/next/results/weave-publications/698c8b176fd80e853c15979faf23fd1b78079115342ce542b06a3430a7bc9135.json' \
  --evidence 'Trained Llama development — W&B Models=training/artifacts/v2-runs/development-llama-sft/models-final-readback/receipt.json' \
  --evidence 'Base Llama confirmation — Weave evaluation=training/experiments/next/results/weave-publications/ace405ff2b5008dc71f0b960024aadbe5b244e43714cc61c9a4bfed797b3e35f.json' \
  --evidence 'GPT-OSS confirmation — Weave coverage only=training/experiments/next/results/weave-publications/19901ba87618123f8f6649967a10a0542179c0bc26f19844b20258bc6ddbd342.json' \
  --evidence 'Deterministic library confirmation — Weave evaluation=training/experiments/next/results/weave-publications/a56246fa98136d9e65ae1a3e31f2836158ec1c4956fc14fca143e49560fd0018.json' \
  --evidence 'Trained Llama confirmation — Weave evaluation=training/experiments/next/results/weave-publications/9ed02d14788b4c067d5da7f7b6463849f8111f5203dd4ec44c74e7709fba3f69.json'
```

When another evaluation finishes, create a new analyzer report and include its exact attempt ID. Matched base/trained estimates and their group-bootstrap intervals are copied only from compatible comparisons for the selected attempts; the UI does not compute them. Add confirmation rows only after execution and change `--confirmation-state` explicitly to `in-progress` or `completed`. Do not change the frozen input files. A future creator study requires a reviewed extension to the snapshot schema and a source-backed participant count; the current generator records that none has been run.

Each source and publication receipt carries a SHA-256 hash. An evidence receipt must say `verified`. The loader additionally accepts only clean HTTPS links under the fixed Forge project path, with no query strings, credentials or fragments. Completion steps require an independent `COMPLETED` job readback matching the submission job ID; configured optimizer steps alone are not completion evidence. The serving baseline remains unchanged by this display.

The static JSON import is included in the application build. Schema-invalid data yields an explicit unavailable state instead of a partial or misleading table. The research section reuses the existing developer cards and horizontally scrollable table, which is keyboard-focusable on narrow screens. The repository's existing `* @ash0ts` ownership rule covers these files.
