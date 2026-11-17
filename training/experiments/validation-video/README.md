# Independent visible-mask diagnostic

This local experiment tests whether the unchanged video worker flags inaccurate segmentation masks. Its ground truth is a rendered target alpha layer, with occluder and offscreen pixels removed. SAM supplies predictions only. The diagnostic uses six synthetic clips and one rendered bottle shape; it does not establish performance on real products or creator benefit.

The [frozen contract](research-contract.json) defines the cases, metrics, missingness, and interpretation before inference. Each clip has 75 frames; the first frame supplies the only prompt and is excluded from scoring. Source hashes in the generated manifest bind the worker, model, generator, and source media to this run. Previous Objectron and planner results remain unchanged.

From the repository root:

```sh
worker/.venv/bin/python training/experiments/validation-video/benchmark.py prepare \
  --output training/experiments/validation-video/artifacts/frozen-v1
worker/.venv/bin/python training/experiments/validation-video/benchmark.py run \
  --inputs training/experiments/validation-video/artifacts/frozen-v1 \
  --output training/experiments/validation-video/artifacts/attempt-001
worker/.venv/bin/python training/experiments/validation-video/build_report.py \
  --inputs training/experiments/validation-video/artifacts/frozen-v1 \
  --attempt training/experiments/validation-video/artifacts/attempt-001 \
  --output training/experiments/validation-video/results
```

All output directories must be new. Interrupted attempts remain intact; use a separate directory for any later attempt. Generated media and raw masks remain under gitignored `artifacts/`. The report preserves frame metrics, source fingerprints, and selected diagnostic frames for review.

Production worker code is unchanged. A wrapper observes binary masks at the existing mask-description boundary and delegates to the original function without changing inputs or outputs. The first-frame seed and forward-only propagation give one observation per frame. No later reference is available to the predictor.

The worker receives a fixed first-frame framing target so its normal pipeline executes. This experiment grades segmentation and tracking-status decisions only. Its emitted framing findings are not scored as correctness judgments against a creator brief.

The [recorded attempt](results/report.md) completed all six clips. It found 26 masks below the frozen IoU threshold, including 20 accepted by the worker, all in the similar-object crossing case. The other five clips had no masks below that threshold. See the [validation receipt](results/validation-receipt.json) for readback hashes and checks. Those observations diagnose one failure mode; they do not estimate its frequency in creator footage.

`prepare_publication.py` prepares the native Weave import under `artifacts/publication-v1/`. It includes case labels, source checksums, model configuration, and per-clip measurements. It includes no footage, images, masks, or annotation coordinates. The existing `next/publish-weave.ts` validates and imports those completed executions; it does not invoke SAM. Six clips are the task denominator. Frame totals remain dependent measurements within those tasks.

The [native Weave evaluation](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a189f4-8937-7af0-b3b5-ca05dc146e24) was imported once and verified by exact readback: all six rows, dataset, model configuration, and aggregate summary match the local records. [Publication status](results/publication-status.json) and the [full receipt](results/weave-publication.json) preserve that check. No inference ran during publication.
