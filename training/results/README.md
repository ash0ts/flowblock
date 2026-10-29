# Qualification evidence

Training completed, but the candidate did not improve useful shot planning. [summary.json](summary.json) is the compact developer-view record. The configured GPT-OSS 20B baseline remains selected.

The one authorized SFT run used 238 solver-reviewed message examples for one epoch, with 30 optimizer updates. Independent API readback reported 368,623 processed tokens and 10,092 loss-bearing tokens. The first update's loss was 2.08699581772089 and the last was 0.09211441418301547. These values describe training optimization, not planning quality. The published positive checkpoint is step 1, with ID `7f5b53a6-1f56-4a2f-a20f-9c0abb43ea90`.

[training-readback.json](training-readback.json) contains the actual job events and checkpoint records. [training-receipt.json](training-receipt.json) identifies the dataset hash, model, job and artifact. [The Forge run](https://forge.coreweave.com/wandb/wandb/flowblock/runs/flowblock-sft-v1-20261029-095244) corresponds to that receipt.

The first client attempt registered the model but stopped before a training job was submitted because the optional W&B SDK was absent. After installing the pinned dependency, a separate receipt resumed that same registered model. The training job then completed, but final client telemetry timed out while verifying W&B credentials. The original client receipt therefore retained `submitted-outcome-unknown`. A read-only query found both a `training_ended` event and positive checkpoint step 1, resolving the training outcome without resubmitting any job. The recovered receipt records this chain explicitly.

## What the evaluation found

The qualification used 12 held-out intent tasks across two synthetic scenes, once per arm. Six intents share each scene, so these are not 12 independent environments. The full frozen test set has 72 tasks across 12 scenes; that campaign was not run. The final checkpoint was predeclared, with no development-set checkpoint selection.

| Arm | Available / requested | Productive matching candidates | Accepted bounded-search abstentions | Median latency |
| --- | --- | --- | --- | --- |
| Deterministic recipe library | 12 / 12 | 2 | 0 | 6 ms |
| GPT-OSS 20B product baseline | 11 / 12 | 1 | 0 | 4,137 ms |
| Untrained Llama 3.1 8B, matched gateway | 12 / 12 | 0 | 0 | 2,455 ms |
| SFT Llama 3.1 8B, checkpoint 1 | 12 / 12 | 0 | 6 | 1,726 ms |

The trained model returned no candidates on all 12 tasks. All six aggregate gains were abstentions on the scene where the bounded recipe search found no candidate. It also abstained on every task in the feasible scene, producing no useful shots. A headline of “0% to 50% planning improvement” would misrepresent this result. The narrower observation is improved JSON protocol compliance accompanied by broad abstention. No model promotion followed.

One GPT-OSS baseline request had a transport failure and remains unavailable. An earlier untrained-Llama qualification through the standard inference gateway is retained in local artifacts, but is not used as the matched before control. The matched base and trained candidate used the same Forge training gateway, prompt, task IDs, action budget, inference settings and checker.

The strict comparison initially found different runtime source hashes. [runtime-equivalence.json](runtime-equivalence.json) reconstructs the exact prior file by removing only the `export ` prefix from the existing telemetry function. Its body and all planner behavior are unchanged. Both hashes and the initial strict comparison are preserved; the [audited comparison](2026-10-29T09-57-33-340Z-base-cf306701--2026-10-29T10-00-01-734Z-candidate-3dd66429-audited.json) records that equivalence separately.

After the qualification, the evaluated planner source was copied byte for byte into [`../frozen/runtime.ts`](../frozen/runtime.ts). Product planner v1.1 then received a deadline fix covering telemetry initialization and final flush, with late model responses rejected. That product fix was tested without additional model calls. These historical results still describe v1. [`../runtime.ts`](../runtime.ts) selects and verifies frozen v1 explicitly for reproductions; the evaluation manifest records which runtime was used. The export-only equivalence audit reads the frozen snapshot so it remains reproducible after product changes.

The candidate's accepted-abstention trace and feasible-task failure trace were both read back from Weave with HTTP 200 and one recorded turn each. [The candidate trace receipt](2026-10-29T10-00-01-734Z-candidate-3dd66429-trace-readback.json) and [baseline trace receipt](2026-10-29T09-55-47-916Z-baseline-9b8ab274-trace-readback.json) contain their conversation and trace IDs. They are available under [the Forge Weave project](https://forge.coreweave.com/wandb/wandb/flowblock/weave).

Provider token usage is retained per arm. No invoice was read, so billed dollar cost is unknown. The geometry oracle is a finite search and does not prove that a scene admits no possible path. These synthetic checks do not establish human cinematic quality, on-set suitability or general performance beyond this qualification.
