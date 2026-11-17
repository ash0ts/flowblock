# Models, inference, and the recorded SFT experiment

The application runs locally. Optional planning uses W&B Serverless Inference; the recorded SFT experiment used Forge Serverless Training and W&B Models. The application does not provision GPU nodes or deploy a remote web service.

## Inference

[`chat`](../src/server/planner.ts) calls the OpenAI-compatible `chat/completions` API at `https://api.inference.wandb.ai/v1`, with the project in the `OpenAI-Project` header. The default model is `openai/gpt-oss-20b`. Both planning and evidence-based revision use this adapter. `FLOWBLOCK_INFERENCE_URL` can select the training gateway when evaluating a trained checkpoint.

Credentials remain on the server. Models return typed JSON actions; application code validates and executes them. A failed model request preserves local planning and exposes the recipe library. No new inference request is needed to publish existing evaluation or training records.

## Training and Models

[`train.py`](../training/train.py) uses pinned ART `0.5.23` and W&B SDK `0.31.0`. The completed experiment trained a Llama 3.1 8B LoRA on the frozen synthetic dataset. [Serverless SFT](https://docs.coreweave.com/products/post-training/serverless-training/sft) stores trained adapters as artifacts and makes checkpoints available through inference.

[The original Models run](https://forge.coreweave.com/wandb/wandb/flowblock/runs/flowblock-sft-v1-20261029-095244) contains all 30 `sft/loss` points and LoRA artifact versions. [Native Models readback](../training/results/models-native-readback.json) verifies all 30 optimizer steps and eight metrics per step against the original job events. Its client run state is `failed`: final client telemetry timed out after the remote training job completed. [Job and checkpoint readback](../training/results/training-readback.json) independently established completion. A client run state and a training job outcome describe different processes.

The recorded dataset artifact URI could not be resolved during the integration audit. The original run has no dataset input edge. The frozen dataset bytes and their SHA-256 still match the verified training receipt; they are preserved in [`training/frozen`](../training/frozen).

## Publishing recorded evidence

[`publish-models.py`](../training/publish-models.py) defaults to a local dry run:

```sh
python3 training/publish-models.py
```

The `--publish` option creates a dedicated, deterministic telemetry run in the original project. It imports the recorded optimizer metrics, consumes the existing positive LoRA checkpoint, and logs the exact frozen dataset as a **recovered training data output**. It also logs a provenance artifact. This does not create historical dataset-input lineage on the training run, retrain the model, or run inference.

The configuration records the original training start, evidence readback time, import time, source hashes, original run URL, and checkpoint identity. The publisher checks every recovered metric against server readback and verifies the artifact edges. Repeated execution reads back the existing run; it never resumes an uncertain write. Use `--verify` for readback without remote writes.

The script defaults to the Forge Models API host, `https://api.forge.coreweave.com`, while preserving an explicit `WANDB_BASE_URL`. The pinned SDK normalizes the Forge `/api/wandb` proxy URL back to that canonical host. A separate bounded GraphQL read through the proxy verified the original run's metrics during intermittent SDK transport failures. Keep the Models URL process-local: changing the web application's base URL also requires reviewing its explicit Weave trace endpoint.

Publication receipts live under ignored `training/artifacts/models-publication`. [The current publication receipt](../training/results/models-publication.json) records a failed authentication preflight and confirms that the proposed run does not exist. No remote mutation occurred. The dedicated recovered dataset and telemetry publication remain pending; the original native Models history is independently verified. A later successful import must produce a verified receipt before the application presents its new dashboard as available.

The trained candidate remains unpromoted. [Qualification results](../training/results/README.md) distinguish productive plans from accepted abstentions and retain the failed candidate's result.
