# Controlled planner and tracking experiments

The new tests found a reproducible tracking-review failure and a planner gain whose uncertainty remains wide. They did not establish faster usable takes or justify promoting the trained planner. Earlier experiments and the article are unchanged.

## What changed in the experiments

The planner suite uses twelve new authored scene groups in U-shaped, trapezoid and offset-alcove rooms. Each has an original brief, an equivalent paraphrase, an obstacle that blocks the original path but leaves a verified alternative, and an explicit equipment limitation. All 36 positive tasks have saved feasible witnesses. One rejected construction attempt is retained; positive selection happened before inference and does not estimate natural task prevalence.

The existing base and trained Llama models use the same coordinator, prompt, endpoint, JSON actions and budgets. The selected trained artifact is immutable version v1 from the prior SFT run. Two repetitions produce 192 scheduled executions. Task/repetition pairs are shuffled, with balanced alternating first-model order. No new training was performed and no paid request was retried. Requests, responses, actions, source hashes and elapsed-time records are preserved locally. Live trace export is disabled equally in both arms; later Weave imports contain recorded results and perform no inference.

The primary checker recompiles returned plans. A separate implementation checks source preservation, movement, timing, equipment and camera/operator clearance at 201 poses. That independent check excludes optics and cannot certify clearance between poses. Model quality remains conditional on the supplied synthetic geometry.

## Planner results

All 192 executions were attempted. Base had 71/96 assessable outcomes; trained had 86/96. All 35 unavailable outcomes ended with provider errors. They remain missing quality outcomes, not failed plans. No task was rerun.

Each condition schedules 24 occurrences per model. The following cells count brief-preserving plans over available outcomes; unsupported requests are deliberately excluded.

| Condition | Base plans / available | Trained plans / available |
| --- | ---: | ---: |
| Original brief | 6 / 20 | 10 / 20 |
| Equivalent paraphrase | 3 / 15 | 11 / 22 |
| Obstacle added to original path | 2 / 16 | 9 / 21 |
| All supported conditions | 11 / 51 | 30 / 63 |

On the **46 supported occurrences available in both arms**, base passed **10** and trained passed **21**. There were fourteen trained-only successes, three base-only successes, seven shared successes and twenty-two shared failures. The paired difference is **23.9 percentage points**, with a 95% whole-scene-group bootstrap interval of **0.0–48.0 points**. All twelve scene groups contributed pairs. Conditions and repetitions remain dependent within each scene group. The interval includes zero and does not correct selection caused by missing service outcomes.

Across all 72 scheduled supported occurrences per arm, delivered plans were 11 for base and 30 for trained. That operational difference includes unavailable execution and is not a pure model-quality effect.

For explicit unsupported requests, base produced a checked empty finish on 0/20 available occurrences, versus 14/23 for trained. On the nineteen matched available occurrences, the counts were zero and ten. These are checked abstentions, not successful plans or validated explanation quality.

The trained model changed success/failure outcome between original and paraphrased wording in **6 of 19 available wording pairs**: three favored the original and three the paraphrase. Seven pairs succeeded under both wordings. These observations do not establish a directional paraphrase penalty or separate wording sensitivity from generation variation. It agreed across repetitions for 32/41 available pairs, but agreement can include repeated failure. Two repeats do not establish generation stability.

Neither arm returned an engine-invalid plan. The independent check rejected twelve base outputs and six trained outputs for brief violations: family, direction or motion. The primary brief checker rejected the same outputs; these were neither disagreements between checkers nor discovered geometric collisions. This illustrates why geometric feasibility alone is an inadequate task score.

The [failure diagnostics](failure-diagnostics.md) trace scores back to model requests, tool observations and returned plans. In ten trained-model obstacle failures, the agent repeated the same rejected compile three times despite receiving collision evidence. Every supported task had a feasible witness frozen before inference. These failures therefore expose ineffective repair behavior on known-solvable tasks.

## Tracking with independent masks

The [six-clip video diagnostic](../../validation-video/results/report.md) compares the unchanged SAM 2.1 Small worker with visible alpha masks from a separate renderer. Later labels are withheld from tracking; the first prompt frame is excluded. Six authored clips share one bottle silhouette and produce 444 correlated non-seed observations.

In the similar-object crossing, **26 masks had intersection-over-union below the frozen 0.5 threshold; 20 were nevertheless accepted as visible by the worker**. All twenty also exceeded 0.05 frame-diagonal centroid error. At 2.53 seconds, the target was mostly occluded, but the accepted mask covered almost a full bottle. The other five cases had no masks below the frozen threshold. All 22 fully hidden frames produced empty masks and were not accepted as visible.

This is a reproducible failure in one authored scenario, not a real-product error rate. The textured control also lost interior label pixels while retaining its extent, showing why mask overlap and framing usefulness must be reported separately. The exposed suite is now development material. Any uncertainty-rule change needs a newly frozen evaluation and independently annotated real footage.

## Execution reliability

The [external-process fault probe](watchdog-local-faults-20261029.json) returned normally for its control and terminated both a hanging local HTTP request and a blocked child event loop. With a 750 ms timeout and 100 ms termination grace, observed durations were 762 ms and 857 ms. No external watchdog timeout occurred in the paid planner run; all child processes exited. Host suspension can still delay the parent and terminating the client does not cancel provider computation.

Later dashboard publication exposed an actual limit of this monitor: the trained-arm import recorded 846.7 seconds against a 180-second timeout, while a concurrent read-only diagnostic recorded 724.7 seconds against a 120-second timeout. Both processes eventually exited after termination. The cause is unresolved; the recorded elapsed time is not provider computation time. A timer in the parent process did not enforce an absolute elapsed bound during that interval. These post-experiment publication failures do not change the planner scores. Raw wall and monotonic timings are retained in [the publication receipt](publication-status.json).

Eight separate unauthenticated catalog GET requests investigated connectivity without invoking models. Default Node transport returned two HTTP responses and two connection timeouts near 10.5 seconds. The existing extended transport returned four HTTP responses and reused one connection in each process. An HTTP 404 establishes an HTTP response, not authentication or model availability. This small probe reproduces intermittent connection establishment failure, but does not prove that changing timeouts fixes all inference failures or identify the provider as their cause.

A subsequent execution should test a persistent matched inference process, connection preparation outside task timing, parent monitoring for each task and structured error causes. The current experiment deliberately used fresh isolated child processes; its cold connections are an operational limitation, not a recommended production topology. Reported parent elapsed time includes process startup and scoring. Some early executions overlapped the local video diagnostic; these durations are not a clean provider-latency benchmark.

## Forge records and budget

The video evaluation is [verified in Weave](https://forge.coreweave.com/wandb/wandb/flowblock/weave/calls/01a189f4-8937-7af0-b3b5-ca05dc146e24), with exact six-row, dataset, configuration and summary readback. It imports local MPS measurements; it does not represent remote GPU execution. Both planner imports remain unverified after one attempt per arm and unsuccessful readback. Their local payloads contain 96 occurrences per arm, separate supported and unsupported denominators, and availability-only scores where quality is missing. [Publication status](publication-status.json) preserves the attempts and timing records. Missing local receipts do not establish that no remote writes occurred, so neither import was repeated. No further network attempts are running.

The new planner execution issued **531 inference requests**. Reported usage supports **$0.30501064** in rate-based estimates; **$0.10085416** remains reserved for unknown usage. The combined $0.40586480 is below the new $2 allocation inside the previous $20 inference reserve and $200 authorization. These are estimates and reservations, not an invoice. The previous training reservation remains unchanged; no new training or infrastructure was provisioned. Rates were checked against [the provider pricing page](https://www.coreweave.com/forge-pricing/inference-agents).

The successor ledger is `training/artifacts/controlled-validation-v1/budget.json`. It retains every prior call and reservation. Future work must continue from it rather than copy the earlier ledger and lose these calls.

## What the evidence supports next

1. Investigate identity ambiguity during similar-product crossings and when the interface should request another annotation. Use this failure for development, then evaluate a frozen fix on new masks and real annotated footage.
2. Improve how the planner uses rejection evidence and checks movement family and direction. Test persistent connection handling before another comparison. Keep plan quality, refusal behavior and availability separate, and use new frozen tasks after developing against these failures.
3. Run the prepared [feedback-versus-practice creator study](../../next/creator-study.md). No participants or filmed outcomes have been collected. Only that intervention can test whether measured corrections repay their upload, annotation and review effort.

## Reproduction and checks

[The protocol](protocol.json) freezes the task identities, order, model, source hashes, budgets and analysis. [Analysis JSON](analysis.json) preserves full counts and paired estimates. Complete inputs, raw calls and source bytes remain under `training/artifacts/controlled-validation-v1/`; [the experiment guide](../README.md) lists commands.

Formatting, TypeScript, ESLint, all 360 enabled TypeScript tests, and the production build passed. Sixteen database-dependent tests were skipped without database test configuration. The new video diagnostic's four tests and Python lint passed. No product behavior was changed. Existing CODEOWNERS coverage correctly assigns the new experiment paths to the repository owner.
