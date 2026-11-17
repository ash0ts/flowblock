# Recorded campaign analysis

`analyze.ts` reads completed campaign directories and produces `report.json`, `tasks.csv`, and `report.md` in a new output directory. It never calls a model, recompiles a plan, changes a grade, or replaces an earlier attempt.

```sh
node --import tsx training/experiments/next/analyze.ts \
  --run training/artifacts/v2-runs/development-library-v4 \
  --pilot training/artifacts/v2-runs/development-gpt-oss \
  --run training/artifacts/v2-runs/development-gpt-oss-warm \
  --output training/artifacts/v2-analysis-example
```

Add a `--run` for each completed base and trained Llama attempt when available. Use `--pilot` only for the initial network pilot; it remains a separate scope. Each supplied directory keeps its own attempt identity. The analyzer refuses an existing output directory, incomplete results, task-file hash changes, mismatched raw task receipts, and repeated attempt IDs. It records hashes of every source receipt it reads.

The summaries distinguish:

- **Operational success:** productive plans divided by all scheduled tasks. Unavailable and unattempted pipeline outcomes did not deliver a plan, but this measure does not label them model-quality failures.
- **Quality success:** productive plans divided by available, graded outcomes. Unavailable outcomes remain missing.
- **Known-witness success:** the same two denominators restricted to tasks for which a compatible recorded deterministic check found a productive witness. The analyzer may join evidence across supplied attempts with matching tasks, checker, search and engine hashes. It reports the evidence's attempt IDs. Missing evidence stays unknown; a search without a witness does not prove infeasibility.
- **Admissions and empties:** credited plan count, geometry-invalid admissions, checked and unchecked accepted empty results, false abstentions, and unsupported abstentions. Older receipts without the new check fields remain unknown; they are not silently regraded.
- **Timing and costs:** coordinator latency and the longer harness latency are separate. Returned call usage remains visible when a later call fails. Budget sums use only this attempt's reservation IDs from the shared ledger. Estimated charges, unresolved reservations and missing usage remain separate; none is an invoice.

Base/SFT comparisons require matching split, task hash, checker, prompt, runtime hashes, protocol and model settings. Incompatible attempts receive an explicit mismatch report. The analyzer does not pool development with confirmation or select a favorable attempt.

For a compatible pair, it resamples complete scheduled scene groups with replacement, keeping every dependent task pair within its group. The default is 10,000 replicates with seed 20261029; `--seed` and `--iterations` make those choices explicit. It reports the trained-minus-base difference and a percentile 95% interval for operational success, paired-available quality, and paired-available quality on known-witness tasks. Groups partially omitted by a task limit are excluded and named. Paired availability, each arm's missingness, empty bootstrap replicates, and eligible group counts are reported. Fewer than two groups with eligible pairs produces no interval; small group counts receive a warning.

These intervals describe variation across the supplied authored scene groups. One generation per task does not measure repeated-generation variance. Paired-available estimates are conditional on availability and can be selected. Shared synthetic generators and graders also limit generalization. None of these results establishes cinematographic quality or whether measured feedback helps a creator finish a usable take sooner; that requires the prospective [creator study](creator-study.md).

The exported pure functions are `pairedClusterBootstrap`, `compareCampaigns`, `summarizeCampaign`, `attachWitnessEvidence`, and `rowsCsv`. `loadCampaign` validates receipts; `analyzeCampaigns` writes the three artifacts. Tests cover group-level resampling, reproducible seeds, missing outcomes, partial groups, incompatible protocols, witness provenance, scoped budget accounting, and source integrity.
