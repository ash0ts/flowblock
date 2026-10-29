# Planner training and evaluation

The planner keeps geometry in a deterministic compiler. The model chooses an allowlisted recipe and parameters through ordinary JSON assistant messages. Supervised fine-tuning teaches that action protocol; it does not replace the geometry validator or learn camera pose from video.

`frozen/manifest.json` identifies the immutable synthetic dataset and exact runtime prompt. The split unit is scene geometry: 24 training scenes, six development scenes and 12 held-out test scenes. Each scene has six intent tasks. The 238 training rows contain solver-selected compile actions and their validated finish actions, plus explicit abstentions where a fixed two-recipe, three-bearing search finds no matching candidate. These are programmatic geometry labels, not human ratings of cinematography. That search is not a proof that every possible path is infeasible.

`research-contract.json` defines the arms, settings, task membership, missingness and stopping rules. The initial qualification uses 12 tasks from two held-out scenes, with one trial per arm. It is smaller than the frozen 72-task full campaign. The final checkpoint from one predeclared training run is used without development-set selection. A positive optimizer result alone does not authorize replacing the baseline.

The completed campaign used planner v1. Its exact evaluated source is preserved in [`frozen/runtime.ts`](frozen/runtime.ts), with source and dependency hashes in [`frozen/runtime-manifest.json`](frozen/runtime-manifest.json). Product planner v1.1 was changed afterward to include telemetry initialization, inference and final telemetry flush in one deadline. Optional telemetry initialization and flush each wait at most one second, within the remaining total budget. A late model reply cannot execute actions after the deadline. This fix has deterministic deadline tests; it has no new model evaluation result. Historical receipts remain unchanged.

Install the client environment and generate data with:

```sh
uv --no-config venv --python 3.12 training/.venv
uv --no-config pip install --python training/.venv/bin/python -r training/requirements.lock
npx tsx training/prepare.ts
```

The `--no-config` flag prevents a containing monorepo's unrelated uv version pin from affecting this independent repository. `prepare.ts` refuses to replace changed frozen files. A new experiment needs a new fixture version.

Set `WANDB_API_KEY`, `WANDB_ENTITY` and optionally `WANDB_PROJECT` in the environment or the ignored `.env.local`. Training uses the Forge endpoint, `https://forge.coreweave.com/api/training/v1`, through the pinned ART client. It submits at most 400 examples for one epoch. It does not retry a training POST. Run a new authorized attempt with:

```sh
training/.venv/bin/python training/train.py --train
```

`training/artifacts/` retains full local receipts and per-call records. If a client fails after submission, inspect the recorded job before doing anything else. Readback never creates a job:

```sh
training/.venv/bin/python training/readback.py training/artifacts/ATTEMPT.json
```

An independent completed-job event and positive checkpoint can recover a successful training receipt when final client telemetry failed. The original failure receipt remains intact. The supplied run used 30 optimizer updates; the server published checkpoint step 1. A checkpoint alias numbered zero is never used as an untrained control.

Evaluate the deterministic library, the product baseline, and the actual untrained base model separately. The original research contract predates the runtime selector; these commands select frozen v1 for historical reproduction:

```sh
node --env-file-if-exists=.env.local --import tsx scripts/evaluate.ts --runtime frozen-v1 --arm library
node --env-file-if-exists=.env.local --import tsx scripts/evaluate.ts --runtime frozen-v1 --arm baseline
node --env-file-if-exists=.env.local --import tsx scripts/evaluate.ts --runtime frozen-v1 --arm base --inference-url https://forge.coreweave.com/api/training/v1 --condition matched-before
node --env-file-if-exists=.env.local --import tsx scripts/evaluate.ts --runtime frozen-v1 --arm candidate --condition matched-after
```

`--runtime frozen-v1` verifies the snapshot and dependency hashes before running the historical protocol. `--runtime product` (the default) evaluates the current product runtime and records its distinct version and source hash. Its results cannot be compared to the v1 campaign as a matched training effect. Both modes use the frozen fixture membership. The preparation script reproduces the existing dataset using frozen v1.

Candidate evaluation requires a verified positive checkpoint receipt. Both matched arms must use the same gateway, prompt, source hashes, fixture IDs, model settings and checker. `compare.ts` reports a mismatch instead of attributing a mixed-protocol difference to training:

```sh
npx tsx training/compare.ts training/artifacts/BEFORE training/artifacts/AFTER
node --env-file-if-exists=.env.local --import tsx training/read-traces.ts training/artifacts/AFTER
```

Infrastructure failures, malformed actor output, library fallback and unattempted tasks stay distinct. Model results never receive credit for fallback library candidates. Summary success counts are split into matching valid candidates and bounded-search abstentions. Token counts come from provider responses; billed dollar cost remains unknown unless independently available. Compact sanitized summaries and readbacks live in tracked `results/`; full synthetic conversations remain in ignored local artifacts.

The completed qualification did **not** establish a useful planning improvement. The trained checkpoint returned an empty candidate list on all 12 tasks. Six counted as acceptable abstentions because the fixed recipe search found no candidate in that scene; the other six were failures on the scene with feasible recipes. Productive matching candidates remained zero for both matched base and candidate runs. The candidate was not promoted. [The results guide](results/README.md) links the receipts, exact comparison and trace readbacks; [the compact summary](results/summary.json) feeds the separate developer view.
