"""Build the metadata-only developer snapshot from explicit recorded evidence.

No service calls, regrading, latest-run selection, or raw evidence publication.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LABELS = {
    "library": "Deterministic library",
    "llama-base": "Llama 3.1 8B base",
    "llama-sft": "Llama 3.1 8B trained",
    "gpt-oss": "GPT-OSS 20B product coordinator",
}


def read(path: Path) -> dict:
    return json.loads(path.read_text())


def source(path: Path) -> dict:
    return {
        "path": path.resolve().relative_to(ROOT).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--analysis", type=Path, required=True)
    parser.add_argument("--attempt", action="append", required=True)
    parser.add_argument("--training-receipt", type=Path, required=True)
    parser.add_argument("--training-readback", type=Path)
    parser.add_argument("--confirmation-runtime", type=Path)
    parser.add_argument(
        "--evidence", action="append", default=[], metavar="LABEL=RECEIPT_PATH"
    )
    parser.add_argument(
        "--confirmation-state",
        choices=["unused", "in-progress", "completed"],
        required=True,
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "training/experiments/next/results/campaign-summary.json",
    )
    args = parser.parse_args()
    report = read(args.analysis)
    if report.get("analysisVersion") != "flowblock-campaign-analysis-v1":
        raise ValueError("Unsupported analysis report")
    if len(set(args.attempt)) != len(args.attempt):
        raise ValueError("Repeated attempt selection")
    campaigns = {row["attemptId"]: row for row in report["campaigns"]}
    selected = [campaigns[attempt] for attempt in args.attempt]
    if any(row["scope"] not in ("development", "confirmation") for row in selected):
        raise ValueError(
            "Initial pilots cannot be presented as current comparison results"
        )
    omitted = [
        row for row in report["campaigns"] if row["attemptId"] not in args.attempt
    ]
    training = read(args.training_receipt)
    completion = read(args.training_readback) if args.training_readback else None
    if completion and not (
        completion.get("status") == "trained"
        and completion.get("completedEvent") is True
        and completion.get("job", {}).get("status") == "COMPLETED"
        and completion.get("trainingJobId") == training.get("trainingJobId")
    ):
        raise ValueError(
            "Training completion readback does not match the submitted job"
        )
    protocol_path = ROOT / "training/experiments/next/data/protocol.json"
    protocol = read(protocol_path)
    confirmation_path = ROOT / "training/experiments/next/data/confirmation/tasks.json"
    confirmation = json.loads(confirmation_path.read_text())
    objectron_path = (
        ROOT / "training/experiments/next/results/objectron-diagnostic.json"
    )
    objectron = read(objectron_path)["metrics"]
    publication_path = (
        ROOT / "training/experiments/next/results/objectron-publication-status.json"
    )
    evidence = []
    for item in args.evidence:
        label, path_string = item.split("=", 1)
        path = Path(path_string)
        receipt = read(path)
        if receipt.get("status") != "verified":
            raise ValueError(f"Evidence is not verified: {path}")
        url = receipt.get("evaluationUrl") or receipt.get("runUrl")
        if not url and re.fullmatch(r"[A-Za-z0-9_-]+", receipt.get("runId", "")):
            url = f"https://forge.coreweave.com/wandb/wandb/flowblock/runs/{receipt['runId']}"
        if not url:
            raise ValueError(f"Verified receipt has no native evidence link: {path}")
        evidence.append(
            {"label": label, "url": url, "status": "verified", "receipt": source(path)}
        )
    snapshot = {
        "schemaVersion": 1,
        "experimentId": "flowblock-planner-v2",
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "project": "wandb/flowblock",
        "access": "private",
        "analysis": source(args.analysis),
        "results": [
            {
                "attemptId": row["attemptId"],
                "label": LABELS[row["arm"]],
                "cohort": row["scope"],
                "scheduled": row["summary"]["scheduled"],
                "attempted": row["summary"]["attempted"],
                "available": row["summary"]["availability"]["numerator"],
                "productive": row["summary"]["qualitySuccessAmongAvailable"][
                    "numerator"
                ],
                "sceneGroups": row["summary"]["sceneGroups"],
                "invalidAdmissions": row["summary"]["admissions"]["invalidPlans"],
            }
            for row in selected
        ],
        "omittedAttempts": {
            "initialPilot": sum(
                row["scope"] == "initial-network-pilot" for row in omitted
            ),
            "zeroCallTransport": sum(
                row["scope"] != "initial-network-pilot"
                and row["summary"]["attempted"] == 0
                and row["summary"]["usage"]["providerCalls"] == 0
                for row in omitted
            ),
        },
        "matchedComparisons": [
            {
                "cohort": pair["scope"],
                "baseAttemptId": pair["baseAttemptId"],
                "trainedAttemptId": pair["trainedAttemptId"],
                "pairedAvailable": pair["missingness"]["pairedAvailable"],
                "baseProductive": pair["qualitySuccessAmongPairedAvailable"]["base"][
                    "numerator"
                ],
                "trainedProductive": pair["qualitySuccessAmongPairedAvailable"][
                    "trained"
                ]["numerator"],
                "sceneGroups": pair["qualitySuccessAmongPairedAvailable"][
                    "sceneGroupsWithEligiblePairs"
                ],
                "difference": pair["qualitySuccessAmongPairedAvailable"]["difference"],
                "interval95": pair["qualitySuccessAmongPairedAvailable"]["interval95"],
                "iterations": pair["qualitySuccessAmongPairedAvailable"]["iterations"],
                "seed": pair["qualitySuccessAmongPairedAvailable"]["seed"],
            }
            for pair in report["comparisons"]
            if pair["compatible"]
            and pair["baseAttemptId"] in args.attempt
            and pair["trainedAttemptId"] in args.attempt
        ],
        "training": {
            "state": "trained" if completion else training["status"],
            "recordedAt": completion["verifiedAt"]
            if completion
            else training.get("updatedAt", training["startedAt"]),
            "examples": training["rows"],
            "plannedSteps": len(training["submittedConfig"]["learning_rate"]),
            "completedSteps": completion["gradientUpdates"] if completion else None,
            "completionSource": source(args.training_readback) if completion else None,
            "jobId": training.get("trainingJobId"),
            "source": source(args.training_receipt),
        },
        "confirmation": {
            "state": args.confirmation_state,
            "tasks": len(confirmation),
            "sceneGroups": protocol["splits"]["confirmation"]["groups"],
            "source": source(confirmation_path),
            "executionSource": source(args.confirmation_runtime)
            if args.confirmation_runtime
            else None,
        },
        "creatorStudy": {"state": "not-started", "participants": 0},
        "objectron": {
            "selected": objectron["cohort/requested_sequences"],
            "completed": objectron["execution/completed_sequences"],
            "nonSeedSamples": objectron["measurements/evaluated_nonseed_samples"],
            "heuristicAcceptedSamples": objectron[
                "measurements/heuristic_usable_samples"
            ],
            "meanProjectionDiscrepancy": objectron[
                "projection_proxy/mean_sequence_mask_centroid_to_projected_3d_center_frame_diagonal_discrepancy"
            ],
            "modelsPublication": read(publication_path)["nativeModelsPublication"],
            "source": source(objectron_path),
        },
        "evidence": evidence,
    }
    args.output.write_text(json.dumps(snapshot, indent=2) + "\n")
    print(
        json.dumps(
            {
                "output": str(args.output),
                "rows": len(selected),
                "verifiedEvidenceLinks": len(evidence),
            }
        )
    )


if __name__ == "__main__":
    main()
