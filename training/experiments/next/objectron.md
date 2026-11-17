# Objectron video diagnostic

This development experiment runs the existing SAM 2.1 Small worker on real mobile footage. It compares measured mask centers and extents with projected Objectron 3D boxes. A projected box is a different label from the visible product silhouette. The resulting discrepancies are proxies, not tracking accuracy, framing quality, or creator benefit.

## Data and selection

The source is [Google Objectron](https://github.com/google-research-datasets/Objectron), distributed under [C-UDA-1.0](https://github.com/google-research-datasets/Objectron/blob/master/LICENSE). Preserve source attribution and the agreement with redistributed data. Keep original footage and per-frame source annotations in ignored local artifacts. Derived experiment summaries can link to the upstream release without publishing the footage.

The acquisition rule takes the first two entries in the upstream test indices for bottle, cup, camera, book and laptop. These ten sequences are development data for FlowBlock. The upstream split name does not make them fresh FlowBlock confirmation data. Selection was fixed before inspecting clips. It is a convenience sample, not a representative creator sample.

Each sequence has three public URLs:

```
https://storage.googleapis.com/objectron/videos/{sequence_id}/video.MOV
https://storage.googleapis.com/objectron/annotations/{sequence_id}.pbdata
https://storage.googleapis.com/objectron/videos/{sequence_id}/geometry.pbdata
```

`annotations.pbdata` contains the annotated objects and their image projections. `geometry.pbdata` contains AR metadata. The official [download notebook](https://github.com/google-research-datasets/Objectron/blob/master/notebooks/Download%20Data.ipynb) distinguishes them.

The local source receipt records exact URLs, hashes, byte counts, errors, recovery attempts and a final filesystem readback. Missing files remain missing; the experiment does not replace them with easier sequences. The source proto defines full box dimensions in meters, but these are annotated estimates rather than measurements from a physical survey. The publication describes manual box annotation; the sampled records' `method` fields do not identify an annotator.

## Timing and orientation

The annotation timestamp fields in this cohort are all zero. The adapter requires annotation frame IDs to match decoded frames one-to-one and maps them to the original presentation timestamps reported by FFprobe. It does not invent timestamps from a nominal frame rate.

All acquired MOVs have a -90-degree display rotation. Visual inspection of every eligible first-frame overlay confirmed that Objectron's normalized 2D projections already match the upright displayed image. FFmpeg applies the MOV rotation once. The adapter does not rotate the labels again. The adapter intentionally rejects another rotation convention until it has been verified.

Eligible videos are trimmed to the first five seconds and re-encoded upright without changing speed. Source videos shorter than five seconds are excluded, never padded. Worker samples are mapped back to the nearest original timestamp, with a maximum difference of 0.018 seconds. Exact mappings remain in the per-frame results.

## Prompt and measures

Only the first projected 3D box is used as a SAM prompt. The prompt is clipped to the image; the reference box remains unclipped. Later reference labels are never given to SAM. Seed-frame results are excluded from aggregates.

For every later sampled frame, retain tracking status and uncertainty reasons. Among samples the worker marks visible, report:

- Fraction of mask centroids inside the projected 3D box.
- Mean distance from mask centroid to projected 3D-box center, divided by the image diagonal in pixels.
- Mean mask-width/projected-box-width and mask-height/projected-box-height ratios.

Report the count of all evaluated samples, usable samples and usable fraction alongside these conditional means. Empty or uncertain tracks cannot count as accurate observations. A ratio near one is not automatically a good segmentation: the cuboid can contain substantial background, and its projected center can lie outside the visible object's silhouette.

The worker receives a fixed first-frame target only to exercise its existing processing contract. Its framing findings do not measure an authored shot brief and are not included in this benchmark's score. The acquisition, annotation source, SAM source/checkpoint, device, worker code, adapter, input clip, original video, and timestamp mapping are retained with results.

## Reproduction

Downloaded source schemas and generated protobuf modules live under `training/artifacts/public-data/objectron/source`. Use the files recorded in its source manifests. The generated modules require the pure-Python protobuf implementation:

```sh
PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION=python \
  uv --no-config run --with protobuf==5.29.6 python \
  training/experiments/next/objectron_benchmark.py export

python3 training/experiments/next/objectron_benchmark.py prepare \
  --output training/artifacts/objectron-diagnostic-new-attempt

worker/.venv/bin/python training/experiments/next/objectron_benchmark.py run \
  --output training/artifacts/objectron-diagnostic-new-attempt --limit 1

worker/.venv/bin/python training/experiments/next/objectron_benchmark.py run \
  --output training/artifacts/objectron-diagnostic-new-attempt
```

Preparation refuses to overwrite an attempt directory. Execution skips completed per-sequence receipts and stops if an incomplete analysis directory exists, requiring inspection rather than an uncertain retry. The smoke sequence is part of development and remains in the result set. Its runtime is included, not silently replaced by a later run.

The original executed adapter and worker sources are archived under the attempt's `runtime/` directory. Later formatting or product fixes do not change those executed bytes.

## Completed development run

The [recorded result](results/objectron-diagnostic.json) contains all ten selected sequences: eight completed, one excluded because its original clip is shorter than five seconds, and one excluded because its source annotation could not be acquired. The eight completed clips produced 592 observations after excluding their seed frames. Mean per-sequence projected-center discrepancy was 0.03307 frame diagonals. Mean processing time was 71.95 seconds per five-second clip on local MPS, including decoding, tracking, measurement and evidence writes, but excluding model construction and queueing.

All 592 observations passed the current worker uncertainty heuristics. Assistant qualitative inspection of midpoint and final overlays nevertheless found mask leakage onto a camera's neighboring price card, omission of a cup's visible interior, and extension from a laptop toward cables/table. The result notes link these observations to frames and timestamps. They are qualitative inspection, not independent ground truth, and do not alter the computed scores. A 100% usable fraction here means that the heuristics accepted every sample; it does not establish tracking accuracy.

The metadata-only publication package retains source attribution, hashes, product dimensions, cohort membership, protocol and runtime identity, results and exclusions. It excludes footage and pixel annotations. The inspected cohort remains development data.

## Interpretation

This experiment establishes that real public mobile footage can pass through the implemented worker and produces inspectable image-space measurements. It cannot validate the proposed visible-mask accuracy thresholds without independent silhouette annotations. It cannot show that a correction helps a creator get a usable take sooner. That needs the prospective creator study, including upload and annotation effort, an uncoached repeat, and blind usability judgments.
