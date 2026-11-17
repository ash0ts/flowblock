# Recorded planner system comparison

The plot shows explicit selected attempts from one analyzer report. It does not regrade outputs or select favorable attempts.

| Attempt | Arm | Scope | Plotted | Productive / available | Available / scheduled | Invalid / admitted plans | Provider calls |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-10-29T18-11-58-321Z-library-75823d38 | library | development | False | 58 / 72 | 72 / 72 | 0 / 58 | 0 |
| 2026-10-29T18-20-24-724Z-llama-base-b8620514 | llama-base | development | False | 17 / 72 | 72 / 72 | 0 / 26 | 283 |
| 2026-10-29T18-34-17-513Z-gpt-oss-94f32993 | gpt-oss | development | False | 12 / 72 | 72 / 72 | 0 / 16 | 277 |
| 2026-10-29T18-56-34-864Z-llama-sft-1c6b56a4 | llama-sft | development | False | 36 / 72 | 72 / 72 | 0 / 37 | 182 |
| 2026-10-29T16-42-01-725Z-gpt-oss-2533a3ec | gpt-oss | initial-network-pilot | False | 1 / 2 | 2 / 72 | 0 / 1 | 10 |
| 2026-10-29T17-09-02-708Z-gpt-oss-d677bfb8 | gpt-oss | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T18-11-57-314Z-llama-base-dfb2efa6 | llama-base | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T18-18-24-711Z-llama-base-3dd394a8 | llama-base | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T17-03-40-325Z-gpt-oss-21f1c150 | gpt-oss | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T18-24-41-859Z-gpt-oss-5ff56527 | gpt-oss | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T19-04-21-481Z-library-c7203722 | library | confirmation | True | 103 / 180 | 180 / 180 | 0 / 103 | 0 |
| 2026-10-29T19-04-22-864Z-llama-base-e6285a4d | llama-base | confirmation | True | 13 / 61 | 61 / 180 | 0 / 18 | 247 |
| 2026-10-29T20-21-26-229Z-llama-sft-2bd7dfb0 | llama-sft | confirmation | True | 66 / 180 | 180 / 180 | 0 / 67 | 471 |
| 2026-10-29T20-29-38-701Z-gpt-oss-1ff2c4ac | gpt-oss | confirmation | True | 0 / 0 | 0 / 180 | 0 / 0 | 0 |

A productive result passes the recorded geometry and brief checks; it is not a judged usable take.
Library search receives structured constraints. GPT-OSS uses a different product coordinator.
These authored rooms share topology templates. Tasks within each scene are dependent.
Matched trained − base: +18.0 percentage points; 95% scene-group bootstrap interval 4.9 to 32.9 pp. 11 groups with paired outcomes.
Paired subset: base 13 / 61, trained 24 / 61. Outages select available tasks; this is not the full-cohort model-quality effect.
Unavailable outcomes stay missing. Available counts and attempted counts expose incomplete pipeline coverage.
Outside this chart: 1 initial pilot, 5 zero-call transport attempts; 4 other cohort attempts. All attempts remain in the CSV.

Unavailable 0/0 quality cells have no score. An empty return is not necessarily a correct infeasibility explanation.

Base / trained pair: `2026-10-29T19-04-22-864Z-llama-base-e6285a4d` / `2026-10-29T20-21-26-229Z-llama-sft-2bd7dfb0`.
`operationalSuccessAmongPairedScheduled`: exact analyzer estimate `{"base": {"numerator": 13, "denominator": 180, "rate": 0.07222222222222222}, "trained": {"numerator": 66, "denominator": 180, "rate": 0.36666666666666664}, "difference": 0.29444444444444445, "sceneGroups": 30, "sceneGroupsWithEligiblePairs": 30, "intervalLimitation": null, "interval95": [0.18888888888888888, 0.40555555555555556], "seed": 20261029, "iterations": 10000, "validReplicates": 10000, "emptyReplicates": 0, "method": "Paired scene-group percentile bootstrap; difference is trained minus base. Entire groups are sampled with replacement; no task-level independent resampling."}`.
`qualitySuccessAmongPairedAvailable`: exact analyzer estimate `{"base": {"numerator": 13, "denominator": 61, "rate": 0.21311475409836064}, "trained": {"numerator": 24, "denominator": 61, "rate": 0.39344262295081966}, "difference": 0.18032786885245902, "sceneGroups": 30, "sceneGroupsWithEligiblePairs": 11, "intervalLimitation": null, "interval95": [0.04918032786885246, 0.3285763209393346], "seed": 20261029, "iterations": 10000, "validReplicates": 10000, "emptyReplicates": 0, "method": "Paired scene-group percentile bootstrap; difference is trained minus base. Entire groups are sampled with replacement; no task-level independent resampling."}`.
`qualitySuccessAmongPairedAvailableWitnesses`: exact analyzer estimate `{"base": {"numerator": 13, "denominator": 31, "rate": 0.41935483870967744}, "trained": {"numerator": 24, "denominator": 31, "rate": 0.7741935483870968}, "difference": 0.3548387096774194, "sceneGroups": 30, "sceneGroupsWithEligiblePairs": 7, "intervalLimitation": "Few independent groups; percentile interval can be unstable.", "interval95": [0.14814814814814814, 0.5333333333333333], "seed": 20261029, "iterations": 10000, "validReplicates": 9998, "emptyReplicates": 2, "method": "Paired scene-group percentile bootstrap; difference is trained minus base. Entire groups are sampled with replacement; no task-level independent resampling."}`.

Full precision and every attempt: [CSV](planner-comparison.csv). Source, receipt hashes and limitations: [provenance](planner-comparison.provenance.json).
