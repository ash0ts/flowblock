# Base Llama development diagnostics

The completed `2026-10-29T18-20-24-724Z-llama-base-b8620514` attempt produced a brief-preserving plan on 17/72 available tasks. 72/72 scheduled tasks were available. Recorded terminations: 30 finished, 42 repair-budget. These are development diagnostics, not confirmation results.

The recorded grader assessed 26 returned plans from 26 tasks: 26 were engine-valid and 17 preserved the brief. Plan counts and successful-task counts differ when a task returns multiple plans.

| Requested family | Productive / available tasks | Productive / known-witness tasks | Returned plans | Actor-failure tasks |
| --- | ---: | ---: | ---: | ---: |
| hold | 6/12 | 6/12 | 6 | 5 |
| push-in | 6/12 | 6/9 | 7 | 5 |
| pull-out | 2/12 | 2/10 | 2 | 8 |
| lateral | 3/12 | 3/10 | 3 | 8 |
| orbit | 0/12 | 0/9 | 1 | 11 |
| reveal | 0/12 | 0/8 | 7 | 5 |

9 returned plans missed at least one brief check. Failed checks: direction 3/26, family 8/26, motion 1/26, supported effect 1/26. Checks overlap. Duration, feasible, height, source preserved passed on all 26 assessed plans. Unreturned plans are outside these criterion denominators.

The agent issued 283 provider calls; 283 tool/action events were logged. Recorded compilation checks: 170 (57 valid, 113 invalid). Explicitly logged action-schema errors: 36.
`travelFractionOfOpticallySolvedDistance` appeared in 23/36 explicitly schema-invalid replies: a descriptive recipe default was copied into an override field the action schema does not accept.

The most frequent codes among observed invalid compiles were `operator_obstacle` 51/113, `operator_boundary` 43/113, `camera_obstacle` 41/113. Codes overlap and describe supplied geometry, not a filmed creator's movement.

Examples:

- [development-000-reveal](../../../artifacts/v2-runs/development-llama-base-connected/development-000-reveal.json): returned plan fails family; inspect `entry.grade.planGrades` and `/result/events/1`.
- [development-001-push-in](../../../artifacts/v2-runs/development-llama-base-connected/development-001-push-in.json): returned plan fails family, direction; inspect `entry.grade.planGrades` and `/result/events/4`.
- [development-001-reveal](../../../artifacts/v2-runs/development-llama-base-connected/development-001-reveal.json): returned plan fails family, direction; inspect `entry.grade.planGrades` and `/result/events/2`.
- [development-000-pull-out](../../../artifacts/v2-runs/development-llama-base-connected/development-000-pull-out.json): rejected descriptive default at `/result/events/1` ([response](../../../artifacts/v2-runs/development-llama-base-connected/calls/development-000-pull-out/1-response.json)).
- [development-003-pull-out](../../../artifacts/v2-runs/development-llama-base-connected/development-003-pull-out.json): the final explanation calls `0.10000000000000009 m` less than the `0.10 m` requirement. The recorded grader has a feasible witness; this is a false abstention, not evidence of infeasibility.

There were 4 accepted empty finishes: 4 on the 58 tasks with recorded witnesses, 0 credited unsupported abstentions, and 0 bounded empty outcomes. Unchecked empty finishes: 0. Witness absence does not prove infeasibility.

The machine-readable companion preserves criterion denominators, failure categories, task hashes, call links and trace IDs. No runtime, teacher label or training data was changed for this diagnosis. Other arms, the initial network pilot and confirmation remain separate attempts.
