# GPT-OSS development diagnostics

The completed `2026-10-29T18-34-17-513Z-gpt-oss-94f32993` attempt produced a brief-preserving plan on 12/72 available tasks. 72/72 scheduled tasks were available. Recorded terminations: 41 finished, 31 fallback. These are development diagnostics, not confirmation results.

The recorded grader assessed 16 returned plans from 15 tasks: 16 were engine-valid and 13 preserved the brief. Plan counts and successful-task counts differ when a task returns multiple plans.

| Requested family | Productive / available tasks | Productive / known-witness tasks | Returned plans | Actor-failure tasks |
| --- | ---: | ---: | ---: | ---: |
| hold | 7/12 | 7/12 | 8 | 2 |
| push-in | 2/12 | 2/9 | 2 | 3 |
| pull-out | 2/12 | 2/10 | 3 | 6 |
| lateral | 0/12 | 0/10 | 0 | 7 |
| orbit | 1/12 | 1/9 | 1 | 6 |
| reveal | 0/12 | 0/8 | 2 | 7 |

3 returned plans missed at least one brief check. Failed checks: family 2/16, height 1/16. Checks overlap. Direction, duration, feasible, motion, source preserved, supported effect passed on all 16 assessed plans. Unreturned plans are outside these criterion denominators.

The agent issued 277 provider calls; 242 tool/action events were logged. Recorded compilation checks: 139 (16 valid, 123 invalid). Explicitly logged action-schema errors: 0.
The call count exceeds the event count by 35. This receipt cannot assign those missing event observations to particular failure types. Observed compile and schema-error counts are incomplete diagnostics, not evidence that unlogged actions were valid.
The coordinator rejected 61 `propose_revision` calls across 58 tasks because planning requests had no saved take/evidence. These are recorded tool-selection errors.

The most frequent codes among observed invalid compiles were `framing_band` 90/123, `camera_obstacle` 85/123, `framing_clipped` 81/123. Codes overlap and describe supplied geometry, not a filmed creator's movement.

Examples:

- [development-000-reveal](../../../artifacts/v2-runs/development-gpt-oss-recovery/development-000-reveal.json): returned plan fails family; inspect `entry.grade.planGrades` and `/result/events/0`.
- [development-003-reveal](../../../artifacts/v2-runs/development-gpt-oss-recovery/development-003-reveal.json): returned plan fails family; inspect `entry.grade.planGrades` and `/result/events/2`.
- [development-009-hold](../../../artifacts/v2-runs/development-gpt-oss-recovery/development-009-hold.json): returned plan fails height; inspect `entry.grade.planGrades` and `/result/events/3`.
- [development-000-hold](../../../artifacts/v2-runs/development-gpt-oss-recovery/development-000-hold.json): unsupported revision action at `/result/events/1` ([response](../../../artifacts/v2-runs/development-gpt-oss-recovery/calls/development-000-hold/1-response.json)).

There were 26 accepted empty finishes: 18 on the 58 tasks with recorded witnesses, 5 credited unsupported abstentions, and 3 bounded empty outcomes. Unchecked empty finishes: 0. Witness absence does not prove infeasibility.
The 31 fallback tasks carried 62 raw library plans; all were excluded from model-success credit. Credited plan counts above use recorded `planGrades`, not those raw fallback plans.

The machine-readable companion preserves criterion denominators, failure categories, task hashes, call links and trace IDs. No runtime, teacher label or training data was changed for this diagnosis. Other arms, the initial network pilot and confirmation remain separate attempts.
