# FlowBlock video worker

This worker tracks the product selected by a normalized box prompt and compares its image-space framing with a saved plan. It runs the pinned SAM 2.1 Small model. It never estimates the physical camera path, lens, distance, or walking speed from a video.

## Local operation

Install FFmpeg and uv. Run these commands from `worker/`:

```sh
uv --no-config sync --frozen --python 3.12
uv --no-config run --no-sync flowblock-worker setup-model
uv --no-config run --env-file ../.env.local --no-sync flowblock-worker serve --device mps
```

The app's `.env.local` supplies `DATABASE_URL` and `FLOWBLOCK_STORAGE_DIR`. Set `FLOWBLOCK_STORAGE_DIR` to the same **absolute path** for both processes, such as `/path/to/flowblock/.data/media`; relative paths resolve from different working directories. The worker consumes only `analysis` jobs. Its `/healthz` and `/readyz` endpoints listen on `127.0.0.1:8091` by default; `FLOWBLOCK_WORKER_PORT` overrides the port and `FLOWBLOCK_HEALTH_HOST` overrides the address. Readiness also reaches the app through a `worker_health` PostgreSQL heartbeat every 15 seconds. `FLOWBLOCK_WORKER_ID` sets a stable worker name.

MPS mode is for local Apple Silicon use. PyTorch 2.5.1 uses CPU fallback for unsupported operations, including the model's bicubic upsampling. The run still uses the real model. `--device cpu` is available for explicit CPU operation. Neither mode demonstrates CUDA deployment. The default device is `cuda`; an unavailable device fails rather than silently switching modes.

For an explicit local file, use the process command:

```sh
uv --no-config run --no-sync flowblock-worker process \
  --device mps --input /path/to/take.mp4 \
  --manifest /path/to/manifest.json --output /path/to/new-output-directory
```

The output directory must not already contain a `frames/` directory. Output includes `analysis.json`, `proxy.mp4`, `timestamps.json`, JPEG inference frames, and evidence stills when a framing rule produces a finding. The server publishes only the proxy and selected evidence stills through owner-checked routes.

## Input contract

```json
{
  "jobId": "job UUID",
  "takeId": "take UUID",
  "planId": "saved plan ID",
  "planVersion": "1.0",
  "videoObjectKey": "owners/OWNER/takes/TAKE/original",
  "outputPrefix": "owners/OWNER/takes/TAKE/analyses/JOB/",
  "seed": {"timeSeconds": 2, "box": {"x": 0.4, "y": 0.3, "width": 0.2, "height": 0.4}},
  "corrections": [],
  "expectedVisible": {"startSeconds": 0, "endSeconds": 5},
  "plannedDurationSeconds": 5,
  "targetKeyframes": [
    {"timeSeconds": 0, "centerX": 0.5, "centerY": 0.5, "width": 0.2, "height": 0.4},
    {"timeSeconds": 5, "centerX": 0.5, "centerY": 0.5, "width": 0.2, "height": 0.4}
  ]
}
```

Coordinates use the upright image with `(0,0)` at the top left and `(1,1)` at the bottom right. Seed and correction times refer to source-relative presentation time. The seed must lie inside the declared expected-visible interval. Up to 20 correction boxes are accepted by the worker; the application can apply a lower limit. Target keyframes are interpolated linearly. Their default time basis is absolute source seconds. Server-generated plan targets set `targetTimeBasis: "normalized-phase"`, mapping the same fraction of the actual clip to the same fraction of `plannedDurationSeconds`. This matches the rehearsal overlay while duration remains a separate measurement. A `target` containing `start` and `end` framing boxes is also supported. Optional `phaseIntervals` contain `phase`, `startSeconds`, and `endSeconds`; otherwise the opening quarter, middle half, and ending quarter define the phase labels.

Inputs are 5 to 15 seconds; container duration rounding has a 0.1-second upper tolerance. The worker accepts at most 256 MiB and rejects dimensions beyond its decode limit. The application's upload limit is stricter. FFmpeg decodes supported video containers, applies orientation, normalizes pixel aspect ratio, and downsizes to at most 1280×720 landscape or 720×1280 portrait. It samples at 15 fps and removes audio from the analysis proxy. Original presentation timestamps and their nearest proxy-frame mapping remain in `timestamps.json`. A duplicated frame in variable-frame-rate input can map to the same source timestamp more than once.

## Measurements

Each frame records the mask centroid, bounding extent, simplified mask boundary, border contact, and uncertainty reasons. Tiny masks, nearly full-frame masks, fragmented masks, weak foreground logits, and abrupt center or area changes are marked uncertain. These flags are heuristics, not calibrated confidence probabilities. Missing masks remain missing. Frames outside the declared visibility interval are excluded from coverage and findings, even if the model predicts a mask there.

Reliable masks alone support framing, size, and possible-clipping observations. Framing uses a center-distance threshold of 0.08 normalized x/y units. Size compares the square root of the observed bounding-box area with the target and flags values outside 75% to 125%. Border contact indicates possible clipping, not proof that the physical product was cropped. A phase needs at least three affected frames and at least 20% affected measured frames before a finding is emitted. Duration is compared directly with the planned duration. At most two findings are returned, each with evidence timestamps. Coverage below 80% of expected-visible frames marks the job `needs_review`.

The result schema is [take-analysis.ts](../src/domain/take-analysis.ts). Its provenance records the actual device, source revision, checkpoint hash, and measurement-rule version. The worker has no mock-inference mode. [verification.md](verification.md) records the synthetic smoke check and its limits.

## Job and artifact lifecycle

Claims use `FOR UPDATE SKIP LOCKED`. A job receives a 90-second lease, renewed every 15 seconds, and at most three attempts. Completion requires the current lease token, a live lease, an uncancelled job, and an undeleted, unexpired take owned by the same account with the same input object key. The worker rechecks those conditions before every artifact upload and at publication.

Every attempt adds its lease token to the output prefix. Failure, cancellation, deletion, or lost ownership removes that attempt's uploaded and partially written artifacts. Cleanup cannot delete a later attempt's prefix. The server's tombstone sweeper provides a second cleanup path for a process killed between upload and publication.

Local storage uses `FLOWBLOCK_STORAGE_DIR`. Optional S3 configuration accepts `S3_BUCKET`, `S3_ENDPOINT`, and `AWS_REGION`, plus standard AWS credential variables. `FLOWBLOCK_S3_BUCKET` and `FLOWBLOCK_S3_ENDPOINT` are aliases. Defaults match the application's CoreWeave endpoint configuration. No remote infrastructure is needed or provisioned for local use. Source media is accessed by validated private object keys; arbitrary user URLs are never fetched.

## Optional CUDA image

The Dockerfile provides an executable CUDA worker path using Python 3.12, PyTorch 2.5.1, and the locked dependencies. It runs as a non-root user and builds the model into the image. The SAM checkout belongs to that user, and the build verifies its Git provenance and checkpoint checksum after switching users. Its readiness endpoint depends on the model and database being available. The container explicitly binds health checks to `0.0.0.0`; publish locally with `-p 127.0.0.1:8091:8091`. Build locally with `docker build -t flowblock-worker worker` from the application directory. Run with a configured PostgreSQL connection and `--gpus all` on an NVIDIA host. CUDA execution was not validated on this Apple Silicon machine.

## Model source and license

`models/manifest.json` pins SAM 2 commit `2b90b9f5ceec907a1c18123530e92e794ad901a4` and the SAM 2.1 Small checkpoint SHA-256 `6d1aa6f30de5c92224f8172114de081d104bbd23dd9dc5c58996f0cad5dc4d38`. Setup verifies the downloaded checkpoint; every model startup verifies that hash and the source checkout revision and rejects tracked source changes.

The checkpoint and model code use Apache 2.0 according to the [pinned upstream license section](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/README.md#license). The license is retained in `models/LICENSE.sam2`. Upstream's optional connected-component CUDA code uses BSD-3-Clause, retained in `models/LICENSE.cctorch`; that optional postprocessing is disabled consistently in this worker. The download uses the official Facebook Hugging Face repository at a pinned revision. Its bytes were also downloaded from Meta's original checkpoint URL and verified to have the same SHA-256.
