# Recorded planner system comparison

The plot shows explicit selected attempts from one analyzer report. It does not regrade outputs or select favorable attempts.

| Attempt | Arm | Scope | Plotted | Productive / available | Available / scheduled | Invalid / admitted plans | Provider calls |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| 2026-10-29T18-11-58-321Z-library-75823d38 | library | development | True | 58 / 72 | 72 / 72 | 0 / 58 | 0 |
| 2026-10-29T18-20-24-724Z-llama-base-b8620514 | llama-base | development | True | 17 / 72 | 72 / 72 | 0 / 26 | 283 |
| 2026-10-29T18-34-17-513Z-gpt-oss-94f32993 | gpt-oss | development | True | 12 / 72 | 72 / 72 | 0 / 16 | 277 |
| 2026-10-29T18-56-34-864Z-llama-sft-1c6b56a4 | llama-sft | development | True | 36 / 72 | 72 / 72 | 0 / 37 | 182 |
| 2026-10-29T16-42-01-725Z-gpt-oss-2533a3ec | gpt-oss | initial-network-pilot | False | 1 / 2 | 2 / 72 | 0 / 1 | 10 |
| 2026-10-29T17-09-02-708Z-gpt-oss-d677bfb8 | gpt-oss | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T18-11-57-314Z-llama-base-dfb2efa6 | llama-base | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T18-18-24-711Z-llama-base-3dd394a8 | llama-base | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T17-03-40-325Z-gpt-oss-21f1c150 | gpt-oss | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |
| 2026-10-29T18-24-41-859Z-gpt-oss-5ff56527 | gpt-oss | development | False | 0 / 0 | 0 / 72 | 0 / 0 | 0 |

A productive result passes the recorded geometry and brief checks; it is not a judged usable take.
Library search receives structured constraints. GPT-OSS uses a different product coordinator.
These authored rooms share topology templates. Tasks within each scene are dependent.
Matched trained − base: +26.4 percentage points; 95% interval 12.5 to 41.7 pp. Scene-group bootstrap, 12 groups.
Outside this chart: 1 initial pilot, 5 zero-call transport attempts; all attempts remain in the CSV.

Unavailable 0/0 quality cells have no score. An empty return is not necessarily a correct infeasibility explanation.

Base / trained pair: `2026-10-29T18-20-24-724Z-llama-base-b8620514` / `2026-10-29T18-56-34-864Z-llama-sft-1c6b56a4`.
`operationalSuccessAmongPairedScheduled`: exact analyzer estimate `{"base": {"numerator": 17, "denominator": 72, "rate": 0.2361111111111111}, "trained": {"numerator": 36, "denominator": 72, "rate": 0.5}, "difference": 0.2638888888888889, "sceneGroups": 12, "sceneGroupsWithEligiblePairs": 12, "intervalLimitation": null, "interval95": [0.125, 0.4166666666666667], "seed": 20261029, "iterations": 10000, "validReplicates": 10000, "emptyReplicates": 0, "method": "Paired scene-group percentile bootstrap; difference is trained minus base. Entire groups are sampled with replacement; no task-level independent resampling."}`.
`qualitySuccessAmongPairedAvailable`: exact analyzer estimate `{"base": {"numerator": 17, "denominator": 72, "rate": 0.2361111111111111}, "trained": {"numerator": 36, "denominator": 72, "rate": 0.5}, "difference": 0.2638888888888889, "sceneGroups": 12, "sceneGroupsWithEligiblePairs": 12, "intervalLimitation": null, "interval95": [0.125, 0.4166666666666667], "seed": 20261029, "iterations": 10000, "validReplicates": 10000, "emptyReplicates": 0, "method": "Paired scene-group percentile bootstrap; difference is trained minus base. Entire groups are sampled with replacement; no task-level independent resampling."}`.
`qualitySuccessAmongPairedAvailableWitnesses`: exact analyzer estimate `{"base": {"numerator": 17, "denominator": 58, "rate": 0.29310344827586204}, "trained": {"numerator": 35, "denominator": 58, "rate": 0.603448275862069}, "difference": 0.3103448275862069, "sceneGroups": 12, "sceneGroupsWithEligiblePairs": 12, "intervalLimitation": null, "interval95": [0.1509433962264151, 0.48214285714285715], "seed": 20261029, "iterations": 10000, "validReplicates": 10000, "emptyReplicates": 0, "method": "Paired scene-group percentile bootstrap; difference is trained minus base. Entire groups are sampled with replacement; no task-level independent resampling."}`.

Full precision and every attempt: [CSV](planner-comparison.csv). Source, receipt hashes and limitations: [provenance](planner-comparison.provenance.json).
