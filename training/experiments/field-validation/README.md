# Real-footage development validation

This runner re-executes the current SAM worker on real public recordings while preserving the earlier experiment. It uses the eight eligible Objectron clips already downloaded and inspected in the [original diagnostic](../next/objectron.md). It keeps exclusion rows for the source clip shorter than five seconds and the clip with unavailable annotation. These recordings remain development data, even though the new worker execution is fresh.

The [research contract](research-contract.json) fixes the selection, measures, aggregation and stopping rules. `freeze` copies the prepared clips, prompts and projection references into a new attempt directory. It snapshots the executed adapter and ML modules, model manifest, runner, test and contract, and records the installed package versions. Execution verifies those hashes before loading SAM and after processing. It refuses an existing execution claim, including a partial attempt. There are no automatic downloads, replacements or retries.

The runner calls the existing [Objectron adapter](../next/objectron_benchmark.py), which constructs SAM 2.1 Small on MPS and processes one clip at a time. Model construction verifies the pinned source revision and checkpoint. Queue transport, application permissions, Forge telemetry and CUDA execution are outside this direct-worker test. MPS enables CPU fallback for unsupported operations. Local timing includes desktop resource contention.

## Retained source material

| Local path | Contents |
| --- | --- |
| `training/artifacts/public-data/objectron` | Acquired recordings, annotations, source indices, acquisition/readback receipts, upstream schema, attribution and C-UDA-1.0 agreement |
| `training/artifacts/objectron-diagnostic-v1` | Reviewed first-five-second trims, prompts, projected-box references, original SAM measurements and frozen runtime |
| A new `training/artifacts/field-validation-*` directory | Copied input bytes, current runtime freeze, fresh inference outputs and completion receipt |

The eligible set covers book, bottle, camera, cup and laptop recordings. The new run needs no download and changes no original media or previous measurement receipt. Raw media stays outside Git under the existing `artifacts/` ignore rule.

## Running a new attempt

Use the worker environment so the installed dependency versions match execution. Pick a new output directory for every attempt. Keep other SAM inference idle while this process runs.

```sh
worker/.venv/bin/python training/experiments/field-validation/validate_real_footage.py freeze \
  --output training/artifacts/field-validation-NEW

worker/.venv/bin/python training/experiments/field-validation/validate_real_footage.py verify \
  --output training/artifacts/field-validation-NEW

worker/.venv/bin/python training/experiments/field-validation/validate_real_footage.py run \
  --output training/artifacts/field-validation-NEW
```

The default includes every eligible sequence. An explicit `--sequence` selection is accepted only during freezing and remains visible alongside the excluded and unselected rows. Do not change membership after seeing results. `execution-started.json` records the attempt claim; `summary.json` records completion, failures, unattempted clips, denominators, per-video receipts and equal-video proxy means. A failure stops execution and leaves the artifacts in place. Inspect it before creating a separately named attempt.

## Reading the results

The seeded frame is excluded. Usable coverage means the worker accepted a measurement under its review heuristics; it is not confidence calibration. Center discrepancy and extent ratios compare a visible mask with a projected 3D cuboid. They do not measure silhouette accuracy. The fixed initial-frame target exists to exercise the worker contract, so its framing findings cannot establish that a filmed shot followed a FlowBlock brief.

Keep these evidence types separate:

| Evidence | What it records | What remains unmeasured |
| --- | --- | --- |
| Synthetic integration clip | Known rendered motion and application processing | Real capture conditions and creator outcomes |
| Public dataset tracking | Real recorded pixels, a declared prompt, worker observations and dataset reference proxies | A creator following a FlowBlock plan or benefiting from feedback |
| Filmed FlowBlock take | A consenting creator's recording linked to the actual immutable plan and setup | A causal improvement from feedback without an appropriate comparison |
| Creator outcome study | Allocation, every attempt, workflow timing, feedback exposure and blind usability judgments | Generalization beyond the recruited sample and declared study conditions |

The runner fixes its evidence scope to public-dataset tracking and rejects a manifest that claims creator outcomes or visible-mask accuracy. It cannot verify the honesty of human records. The existing [creator-study collection tool](../next/creator-study.md) supplies allocation, consent, timing, practice-control and blinded-review validation for future collection. No creator responses or study results are generated here.

Objectron footage and annotations use the retained C-UDA-1.0 agreement. The attempt keeps that agreement and source attribution. Media, annotations and rendered frames remain in ignored local artifacts. A publication should contain approved derived metadata and links to the upstream source, with the original exclusions and limitations intact.

## Publishing completed measurements

`prepare_publication.py` creates an explicit metadata allowlist from a completed attempt. It verifies the frozen source snapshots, scope, result hashes and cohort membership. The payload contains scalar measurements, original exclusions, source hashes, installed runtime versions, the protocol and attribution. It omits media, rendered overlays, source labels and per-frame coordinates.

```sh
worker/.venv/bin/python training/experiments/field-validation/prepare_publication.py \
  training/artifacts/field-validation-NEW \
  --output training/artifacts/field-validation-NEW/publication
```

The existing [Models publisher](../next/publish.py) consumes `manifest.json` and `models-results.json`. The [Weave publisher](../next/publish-weave.ts) consumes the same manifest, `tasks.json` and `weave-results.json`. Both default to local validation. Their explicit publication modes require an existing private project, preserve uncertain publication receipts and verify the uploaded records. Publication imports the completed local measurements; it performs no model inference.

In Weave, `available` and `attempted` include the original exclusion rows. Their fraction describes cohort availability, not model quality. Projection metrics include only completed recordings, and each native metric reports its contributing count. Use the recorded processing times for worker latency; import-call durations measure publication work.

The adapter's per-video metadata also hashes worker files that its direct execution does not import, such as queue jobs. For executed-source identity, use this attempt's `freeze.json` and the published `runtime.json`, which name the imported ML modules separately from transport and telemetry code.

## Recorded repeat on October 30, 2026

The [completed receipt](results/public-video-repeat-2026-10-30.json) records eight fresh local SAM executions and the two original exclusions. The current worker accepted 591 of 592 non-seed observations under its tracking heuristics. One bottle observation at 3.666667 seconds was uncertain because of weak mask logits. The equal-video mean projected-center discrepancy was 0.03324 frame diagonals. Average processing time was 108.85 seconds per five-second clip on this local MPS run, excluding model setup and queueing.

An independent arithmetic readback reproduced the per-video counts and proxy means. Assistant inspection of midpoint and final overlays found apparent price-card leakage, omission of a cup's visible interior and laptop-mask extension onto a table. Those observations did not change the protocol or scores. The same inspected recordings remain development data; this repeat does not establish a tracking improvement, independent silhouette accuracy or creator benefit.

- [Models run and result table](https://forge.coreweave.com/wandb/wandb/flowblock/runs/benchmark-15a84f079fb00539cb9d7e94): 12 metrics, dataset lineage and artifact bytes verified; all cells in the ten-row, 19-column table matched the local export.
- [Dataset producer and artifact](https://forge.coreweave.com/wandb/wandb/flowblock/runs/dataset-61173b354f2a1529cf796266): source identities, runtime hashes, protocol and attribution, with no media or pixel annotations.
- [Native Weave evaluation](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a18ecd-e40d-775b-a817-1a570fc3c840): ten imported cohort rows, including both exclusions; row scores, aggregate, dataset and model configuration verified by remote readback.
