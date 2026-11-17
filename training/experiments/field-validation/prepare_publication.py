"""Build metadata-only Models and Weave imports from one completed local attempt."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from validate_real_footage import digest, read_json, verify, write_json

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PROXIES = {
    "mask_center_inside_projected_box": "maskCenterInsideProjectedBoxFraction",
    "mask_centroid_to_projected_3d_center_frame_diagonal_discrepancy": "maskCentroidToProjected3dCenterFrameDiagonalDiscrepancy",
    "mask_width_to_projected_box_width_ratio": "maskWidthToProjectedBoxWidthRatio",
    "mask_height_to_projected_box_height_ratio": "maskHeightToProjectedBoxHeightRatio",
}
LICENSE = {
    "id": "C-UDA-1.0",
    "url": "https://github.com/google-research-datasets/Objectron/blob/master/LICENSE",
    "redistributionAllowed": True,
}


def publication_rows(summary: dict) -> list[dict]:
    rows = []
    for result in summary["rows"]:
        row = {
            "taskId": result["sequence_id"].replace("/", "-"),
            "sequenceId": result["sequence_id"],
            "sourceDataset": "Objectron",
            "licenseId": LICENSE["id"],
            "split": "development",
            "status": result["status"],
            "available": result["status"] == "completed",
            "note": "Previously inspected public recording. No authored FlowBlock take, silhouette accuracy or creator outcome measured.",
        }
        if row["available"]:
            measured = result["summary"]
            row.update(
                {
                    "outcome": "measured projection proxy",
                    "evaluationSamplesExcludingSeed": measured[
                        "evaluation_samples_excluding_seed"
                    ],
                    "usableSamples": measured["usable_samples"],
                    "usableFraction": measured["usable_fraction"],
                    "processingSeconds": result["elapsed_processing_seconds"],
                    "runtimeVersion": "SAM 2.1 Small / MPS / framing-v1.1",
                    **{
                        PROXIES[key]: value
                        for key, value in measured[
                            "mean_proxy_metrics_on_usable_samples"
                        ].items()
                    },
                }
            )
        else:
            row.update(
                {
                    "reason": result.get("reason", result["status"]),
                    "outcome": "no measured result",
                }
            )
        rows.append(row)
    return rows


def prepare(attempt: Path, output: Path) -> dict:
    frozen = verify(attempt, live_sources=False)
    summary = read_json(attempt / "summary.json")
    if (
        summary["freeze_sha256"] != digest(attempt / "freeze.json")
        or summary["scope"] != frozen["scope"]
    ):
        raise ValueError("Result does not match frozen inputs and evidence scope")
    completed = [row for row in summary["rows"] if row["status"] == "completed"]
    if summary["execution_status"] != "completed" or len(completed) != len(
        frozen["selected_sequence_ids"]
    ):
        raise ValueError(
            "Publish only a complete attempt; preserve failures locally for inspection"
        )
    for row in completed:
        metrics_path = attempt / row["metrics"]
        if (
            digest(metrics_path) != row["metrics_sha256"]
            or digest(metrics_path.parent / "analysis/analysis.json")
            != row["analysis_sha256"]
        ):
            raise ValueError("Measured result bytes changed after execution")
        metrics = read_json(metrics_path)
        if (
            metrics["summary"] != row["summary"]
            or metrics["sequence_id"] != row["sequence_id"]
        ):
            raise ValueError("Per-video result and summary differ")
    output.mkdir(parents=True, exist_ok=False)
    rows = publication_rows(summary)
    cohort = read_json(attempt / "cohort.json")
    tasks = []
    for result, source in zip(rows, cohort["rows"], strict=True):
        if result["sequenceId"] != source["sequence_id"]:
            raise ValueError("Cohort membership or ordering changed")
        tasks.append(
            {
                "id": result["taskId"],
                "sequenceId": result["sequenceId"],
                "split": "previously-inspected-development",
                "sourceDataset": "Objectron",
                "sourceVideoSha256": source["source_video_sha256"],
                "annotationSha256": source.get("annotation_sha256"),
                "clipSha256": source.get("clip_sha256"),
                "promptManifestSha256": source.get("manifest_sha256"),
                "referenceSha256": source.get("references_sha256"),
                "eligibility": source["status"],
                "exclusionReason": source.get("reason"),
                "referenceDefinition": "Projected 3D cuboid, not visible silhouette",
                "promptPolicy": "First-frame clipped projected box only; no later labels supplied to SAM",
                "evidenceScope": frozen["scope"],
                "sourceUrl": "https://github.com/google-research-datasets/Objectron",
                "licenseId": LICENSE["id"],
            }
        )
    limitations = summary["limitations"] + [
        "The new execution repeats eight previously inspected recordings; it is not a fresh confirmation set.",
        "Usable means passing worker tracking heuristics, not a creator-rated usable take.",
        "Frames are dependent within video. Proxy averages use equal video weights; available/attempted include all original selection rows and are not a quality score.",
        "Publication imports completed local MPS results; import trace latency is not inference latency.",
        "No raw media, rendered images, masks, prompts, per-frame coordinates or source annotations are published.",
    ]
    source_hashes = {
        item["snapshot"].removeprefix("runtime/").removesuffix(".txt"): item["sha256"]
        for item in frozen["sources"]
    }
    write_json(output / "tasks.json", tasks)
    write_json(
        output / "runtime.json",
        {
            "freezeSha256": summary["freeze_sha256"],
            "frozenAt": frozen["frozen_at"],
            "sourceSummarySha256": digest(attempt / "summary.json"),
            "executedSourceHashes": source_hashes,
            "runtime": frozen["runtime"],
            "publicationAdapterSha256": digest(Path(__file__)),
            "resultHashes": {
                row["sequence_id"]: {
                    "metrics": row["metrics_sha256"],
                    "analysis": row["analysis_sha256"],
                }
                for row in completed
            },
        },
    )
    protocol = (
        attempt
        / "runtime/training/experiments/field-validation/research-contract.json.txt"
    )
    write_json(output / "protocol.json", read_json(protocol))
    write_json(
        output / "attribution.json",
        {
            "title": "Objectron: A Large Scale Dataset of Object-Centric Videos in the Wild With Pose Annotations",
            "authors": [
                "Adel Ahmadyan",
                "Liangkai Zhang",
                "Artsiom Ablavatski",
                "Jianing Wei",
                "Matthias Grundmann",
            ],
            "publication": "CVPR 2021",
            "sourceUrl": "https://github.com/google-research-datasets/Objectron",
            "license": LICENSE,
            "sourceLicenseSha256": digest(attempt / "provenance/LICENSE"),
            "sourceAttributionSha256": digest(attempt / "provenance/ATTRIBUTION.md"),
            "distribution": "Derived numeric results, source identity hashes and attribution only. Original data and annotations are excluded. Source Data remains governed by C-UDA-1.0; recipients of source Data must retain attribution and accept that agreement.",
        },
    )
    dataset_manifest = {
        "schemaVersion": 1,
        "datasetId": "flowblock-objectron-repeat-development",
        "version": attempt.name,
        "description": "Metadata-only current-worker repeat on previously inspected real Objectron recordings. Projection discrepancy is a cuboid-reference proxy, not silhouette accuracy or creator benefit. Original exclusions retained.",
        "files": [
            {
                "path": name,
                "sha256": digest(output / name),
                "role": role,
                "license": LICENSE,
                "split": "development",
            }
            for name, role in (
                ("tasks.json", "metadata"),
                ("runtime.json", "metadata"),
                ("protocol.json", "protocol"),
                ("attribution.json", "metadata"),
            )
        ],
        "metadata": {
            "kind": "licensed-derived",
            "splitUnit": "one previously inspected source recording; creator identity unavailable",
            "counts": {
                "original_selected_recordings": len(rows),
                "executed_recordings": len(completed),
                "excluded_recordings": sum(row["status"] == "excluded" for row in rows),
            },
            "limitations": limitations,
        },
    }
    write_json(output / "manifest.json", dataset_manifest)
    metrics = {
        "cohort/original_selected_recordings": len(rows),
        "cohort/executed_recordings": len(completed),
        "cohort/excluded_recordings": sum(row["status"] == "excluded" for row in rows),
        "tracking/evaluation_samples_excluding_seed": summary[
            "evaluation_samples_excluding_seed"
        ],
        "tracking/usable_samples": summary["usable_samples"],
        "tracking/usable_fraction": summary["usable_fraction"],
        "processing/total_seconds": sum(
            row["elapsed_processing_seconds"] for row in completed
        ),
        "processing/mean_seconds_per_clip": sum(
            row["elapsed_processing_seconds"] for row in completed
        )
        / len(completed),
        **{
            f"projection/equal_video_mean_{PROXIES[key]}": value["mean"]
            for key, value in summary["equal_video_mean_proxy_metrics"].items()
        },
    }
    common = {
        "schemaVersion": 1,
        "experimentId": "flowblock-objectron-development-repeat-20261030",
        "datasetManifestSha256": digest(output / "manifest.json"),
    }
    write_json(
        output / "models-results.json",
        common
        | {
            "status": "completed",
            "metrics": metrics,
            "rows": rows,
            "metadata": {
                "runtimeVersion": "SAM 2.1 Small / MPS / framing-v1.1",
                "checkerVersion": frozen["version"],
                "evaluationKind": "development",
                "limitations": limitations,
            },
        },
    )
    provenance = completed[0]["provenance"]
    weave_rows = []
    for row, result in zip(rows, summary["rows"], strict=True):
        scores = {"available": row["available"], "attempted": row["available"]}
        scores.update(
            {
                key: value
                for key, value in row.items()
                if key
                in (
                    *PROXIES.values(),
                    "evaluationSamplesExcludingSeed",
                    "usableSamples",
                    "usableFraction",
                    "processingSeconds",
                )
                and value is not None
            }
        )
        weave_rows.append(
            {
                "taskId": row["taskId"],
                "output": row
                | (
                    {
                        "metricsSha256": result["metrics_sha256"],
                        "analysisSha256": result["analysis_sha256"],
                    }
                    if row["available"]
                    else {}
                ),
                "scores": scores,
            }
        )
    write_json(
        output / "weave-results.json",
        common
        | {
            "attemptId": attempt.name,
            "tasksSha256": digest(output / "tasks.json"),
            "model": {
                "name": "SAM-2_1-Small-Objectron-development-repeat",
                "provider": "local",
                "modelId": "facebook/sam2.1-hiera-small:sha256:"
                + provenance["checkpointSha256"],
                "promptSha256": None,
                "runtimeVersion": f"SAM2 {provenance['repositoryCommit']}; {provenance['rulesVersion']}",
                "checkerVersion": frozen["version"],
                "sourceHashes": source_hashes,
                "settings": {
                    "device": "mps",
                    "cpuFallbackForUnsupportedOps": True,
                    "analysisFps": 15,
                    "clipDurationSeconds": 5,
                    "seedFrame": 0,
                    "laterLabelsSupplied": False,
                    "remoteModelInvocation": False,
                    "paidInference": False,
                    "evidenceScope": frozen["scope"],
                },
            },
            "rows": weave_rows,
            "summary": {
                "metrics": metrics,
                "counts": summary["counts"],
                "evidenceScope": frozen["scope"],
                "unitOfAnalysis": "one public recording; frames are dependent",
                "freshHeldOutEvidence": False,
            },
            "metadata": {
                "scope": "development",
                "recordedAt": summary["finished_at"],
                "limitations": limitations,
            },
        },
    )
    return {"output": str(output), "rows": len(rows), "metrics": metrics}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("attempt", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.attempt.resolve(), args.output.resolve()), indent=2))
