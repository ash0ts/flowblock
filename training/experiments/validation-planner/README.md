# Controlled planner validation

This experiment reuses the existing base and trained Llama models to test specific failure modes. It does not train another candidate or replace the original qualification and confirmation results.

## Design

The builder creates twelve scene groups across six movement families and three new synthetic room templates: U-shaped, trapezoid and offset alcove. Each group has four conditions:

- An original brief with a solver-verified plan.
- An equivalent paraphrase with the same geometry and requested effect.
- A fixed obstacle that blocks the original plan, with a verified alternative.
- An explicit equipment limitation requiring checked abstention.

The first three conditions give 36 supported tasks. The twelve unsupported tasks are scored separately. Construction selects positive cases before inference; exclusions and candidate-search logs are retained. This is a controlled stress suite, not an estimate of natural task prevalence. Neither the recipes nor labels have received cinematographer review.

Base and trained models use the same research coordinator, prompt, action schema, six-action/two-repair limits, temperature and endpoint. Each task has two repetitions per model. Task/repetition pairs are shuffled with a frozen seed, and first-model order alternates. All 192 scheduled occurrences remain in the denominator, including unavailable and unattempted work. Repetitions and conditions remain clustered within scene group for uncertainty estimates.

## Execution and measurements

`freeze.ts` records the tasks, schedule, selected checkpoint, source hashes and source bytes before inference. `run.ts` checks those hashes before each child process. `child.ts` records requests before sending them, preserves responses, reserves cost before each request and makes no automatic paid-request retry. Live telemetry is disabled equally for both models to separate planner behavior from trace-export failures. Scored results can be imported into the existing private Weave project afterward; an import is not another inference run.

`watchdog.ts` monitors each child from a separate process, records monotonic and wall time, and escalates termination. Its local fault probe exercises a hanging HTTP request and a blocked child event loop. It cannot guarantee elapsed time during host suspension or cancel provider computation. Unknown responses retain their cost reservations. Two consecutive pairs with neither result available stop the campaign, preserving the remaining schedule as unattempted.

The primary outcome is a returned plan preserving the brief on supported tasks. Unsupported tasks report checked abstention separately; explanation correctness is not graded. The independent arithmetic diagnostic checks geometry at 201 poses, direction, timing, height and equipment. It does not use the compiler internally, but it is sampled rather than a continuous clearance proof and does not validate optics. Mask accuracy and creator benefit require separate experiments.

## Budget and reproduction

The experiment uses at most $2 of additional rate-based inference reservations within the prior $20 inference allocation and $200 overall authorization. No new training job is allowed. Previously billed training dollars are still unavailable; reservations are not invoices. The carried-forward ledger in `training/artifacts/controlled-validation-v1/budget.json` succeeds `training/artifacts/v2-budget.json`. Future campaigns must use the successor rather than copy the older ledger again.

```sh
node --import tsx training/experiments/validation-planner/freeze.ts NEW_DIRECTORY
node --env-file=.env.local --import tsx training/experiments/validation-planner/run.ts NEW_DIRECTORY
node --import tsx training/experiments/validation-planner/analyze.ts NEW_DIRECTORY
```

An execution claim prevents rerunning the same frozen directory. Do not create another copy to retry failed tasks. Preserve a new experiment identity and protocol for any later study.

## Evidence

The [results report](results/report.md) contains planner scores, independent diagnostics, tracking results and limitations. The committed local watchdog receipt is in [results/watchdog-local-faults-20261029.json](results/watchdog-local-faults-20261029.json). Later publication attempts exceeded their configured watchdog durations; [publication status](results/publication-status.json) preserves the unresolved outcomes and raw timings. The full task inputs, raw model outputs, source archive and live budget stay under the ignored `training/artifacts/controlled-validation-v1/` directory.
