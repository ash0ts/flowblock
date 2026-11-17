# Measuring the value of a correction

The planner benchmark tests supported geometry and brief preservation. A public tracking dataset tests image-space measurements. Neither records a creator receiving feedback and attempting another take. The creator-benefit question requires prospective data collected under the protocol below.

This is a collection instrument and proposed feasibility pilot. No creators have been recruited or scored by this repository. The Python test data is synthetic and stays outside study results.

## Allocation and controls

The proposed pilot has 24 creators, allocated evenly to four parallel arms. Each creator films three stationary-product jobs. These counts are a proposed collection scope, not a power calculation or a result.

| Arm value | Workflow | Comparison |
| --- | --- | --- |
| `existing` | Creator's existing workflow | Combined product value |
| `recipe` | Fixed recipe card | Value beyond a static instruction |
| `flowblock-practice` | FlowBlock plan, upload, annotation and replay; measured findings and correction withheld | Repeated practice with comparable review effort |
| `flowblock-feedback` | Same plan and review process; measured findings and one proposed correction shown | Added effect of measured feedback |

Assign each creator to one arm for the pilot. Balance camera experience and device class across arms, and record the randomized allocation before the first attempt. Rotate brief/product order across creators within each arm. The practice arm's next take receives no coaching. That comparison separates the correction from ordinary repetition; the existing-workflow and recipe comparisons estimate the larger workflow difference.

Do not swap a creator into a different arm after viewing their takes. Record facilitator help, accidental feedback in a control condition, and other protocol deviations. The collector rejects correction events in control arms and cross-arm assignment of one creator. It does not claim randomization merely because a CSV contains an arm label.

## Outcomes and timing

Time zero is opening the assigned brief with equipment available. Time to first usable take ends at the recording-end timestamp of the earliest take that the blinded reviewers later judge usable. Count planning, upload, annotation, waiting, review and repeated capture. Preserve every take, including footage the creator chose not to keep.

Freeze the session cap and brief-specific rubric before collection. Record monotonic timestamps on one clock per session, with a UTC anchor. A session without a usable take is censored at its end and remains in the analysis. Preserve early abandonment reasons. Do not average only the successful times or treat incomplete reviews as failed takes.

The rubric covers the requested motion effect, required subject visibility and framing, acceptable focus/exposure, and prohibited substitutions. Two independent reviewers score randomized take IDs without the arm, attempt order, feedback or timestamps. A third reviewer resolves disagreements. Record the original ratings and the adjudication rather than replacing them. Keep the same rubric across arms. Tracking measurements help explain failures; they do not replace independent usability judgments.

The primary comparison is feedback versus practice. Jobs and takes are nested within creator. The pilot estimates feasibility, missingness, censoring and variability. Use those measurements to plan a later sample size and freeze a time-to-event analysis before a confirmatory study. The included scorer produces descriptive records and retains censoring; it does not emit an unsupported significance test or claim the proposed 25% improvement.

## Collection files

`study.py` uses standard-library Python and CSV files. It creates empty tables, validates relationships and timing, appends checked records, emits a blinded rating manifest, and scores completed sessions. It makes no network calls and never uploads footage or trains a model.

```sh
python3 training/experiments/next/study.py init --directory training/artifacts/creator-pilot
python3 training/experiments/next/study.py append --directory training/artifacts/creator-pilot --table creators --row-json creator-row.json
python3 training/experiments/next/study.py close-session --directory training/artifacts/creator-pilot --assignment-id ASSIGNMENT_ID --end-monotonic ACTUAL_END
python3 training/experiments/next/study.py validate --directory training/artifacts/creator-pilot
python3 training/experiments/next/study.py rating-manifest --directory training/artifacts/creator-pilot --output blinded-takes.csv
python3 training/experiments/next/study.py score --directory training/artifacts/creator-pilot --output creator-summary.json
```

The new directory must not exist. Each row JSON contains exactly the corresponding CSV columns, all as strings. Boolean cells are `true` or `false`. Use pseudonymous creator IDs and random opaque rating IDs. Keep identity/consent documents in a separate private location. The media hash ties each take to its original file without putting footage into the CSV. The rating manifest exposes only the opaque rating ID and media hash; prepare the associated media without identifying filenames or revealing assignment information.

Create an assignment when its session starts, leaving `session_end_monotonic` blank. Record all take and event rows. When the session ends, use `close-session` to record its actual end and optional `--abandoned-reason`. The command retains the before/after completion record and refuses to replace an already closed session. Ratings may arrive later; incomplete sessions or any unreviewed takes remain incomplete in the scorer.

| File | Recorded facts |
| --- | --- |
| `creators.csv` | Pseudonymous ID, experience/device strata, study consent, separate training consent |
| `assignments.csv` | Randomized arm, brief/product order, time origin, fixed cap, end/abandonment |
| `attempts.csv` | Every capture interval, original media hash, plan version, blinded rating ID |
| `events.csv` | Upload, annotation, queue, analysis, review and correction intervals; versions/findings and acceptance |
| `ratings.csv` | Two independent usability judgments and a separate adjudication when needed |

Training consent is separate and defaults to the creator's explicit choice. A study-consent field is not permission to publish footage, log it into Forge, or train on it. The scoring export contains pseudonymous outcomes; access and sharing must follow the consent scope. Training artifacts and Forge traces should reference approved hashes and metrics rather than raw private footage.

## Completion gate

A real creator result requires consented participants, preserved takes, valid timing, verified allocation, blinded reviews and an analysis that accounts for clustering and censoring. An empty collection, a tracking benchmark and a simulated example are separate artifacts. The current repository supplies the collection and scoring machinery; it does not represent them as a completed creator study.
