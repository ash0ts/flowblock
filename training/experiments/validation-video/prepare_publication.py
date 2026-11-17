"""Prepare a metadata-only native Weave import of six completed synthetic clips."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT = HERE / "artifacts/publication-v1"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: Path, value: object):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def main():
    OUTPUT.mkdir(parents=True, exist_ok=False)
    summary = json.loads((HERE / "results/summary.json").read_text())
    frozen = json.loads((HERE / "results/frozen-manifest.json").read_text())
    tasks = []
    for case in frozen["cases"]:
        tasks.append(
            {
                "id": case["case_id"],
                "cohort": "synthetic-development-diagnostic",
                "unitOfAnalysis": "one authored five-second synthetic clip",
                "label": case["case_id"],
                "truthSource": "Author-rendered visible target silhouette; opaque occluders and offscreen pixels removed; independent of SAM outputs",
                "truthMasksSha256": case["sha256"]["truth.npz"],
                "truthFrameMetadataSha256": case["sha256"]["truth-frames.json"],
                "sourceClipSha256": case["sha256"]["clip.mp4"],
                "workerManifestSha256": case["sha256"]["manifest.json"],
                "frozenCohortSha256": summary["frozen_manifest_sha256"],
                "generatorSha256": frozen["generator_sha256"],
                "prompt": "Exact first-frame box only; subsequent labels withheld from tracker",
                "frames": 75,
                "fps": 15,
                "excludedSeedFrames": 1,
                "expectedVisible": "Entire 0–5 second interval; fully hidden truth separately reported",
                "hasPublishedPixels": False,
                "hasHumanLabels": False,
            }
        )
    write(OUTPUT / "tasks.json", tasks)
    protocol = json.loads((HERE / "research-contract.json").read_text())
    write(OUTPUT / "protocol.json", protocol)
    license = {
        "id": "LicenseRef-FlowBlock-Authored",
        "url": "https://github.com/ash0ts/flowblock",
        "redistributionAllowed": True,
    }
    manifest = {
        "schemaVersion": 1,
        "datasetId": "flowblock-synthetic-visible-mask-stress-v1",
        "description": "Metadata-only import of six authored synthetic video diagnostics. No footage, images, masks or coordinates are included. This is not a real-product accuracy benchmark.",
        "files": [
            {
                "path": name,
                "sha256": digest(OUTPUT / name),
                "license": license,
                "role": role,
            }
            for name, role in (("tasks.json", "tasks"), ("protocol.json", "protocol"))
        ],
        "metadata": {
            "taskCount": 6,
            "nonseedFrameCount": 444,
            "framesAreIndependentTasks": False,
            "generatorSha256": frozen["generator_sha256"],
            "frozenCohortSha256": summary["frozen_manifest_sha256"],
            "sourceResultsSha256": digest(HERE / "results/summary.json"),
        },
    }
    write(OUTPUT / "manifest.json", manifest)
    rows = []
    for case in summary["cases"]:
        values = case["all_nonseed"]
        scores = {
            "available": True,
            "attempted": True,
            "meanMaskIoU": values["mean_iou"],
            "scoredFrameCount": values["samples"],
            "badMaskFrameCount": values["bad_masks"],
            "workerAcceptedFrameCount": values["accepted_by_worker"],
            "falseAcceptedBadMaskFrameCount": values["false_accepted_bad_masks"],
            "fullyHiddenTruthFrameCount": case["fully_hidden_truth_nonseed"]["samples"],
            "uncertainFrameCount": values["uncertain"],
            "missingFrameCount": values["missing"],
            "processingSeconds": case["elapsed_processing_seconds"],
        }
        rows.append(
            {
                "taskId": case["case_id"],
                "output": {
                    "status": "completed",
                    "importOnly": True,
                    "executionLocation": "local MPS",
                    "allNonseed": values,
                    "visibleTruthNonseed": case["visible_truth_nonseed"],
                    "fullyHiddenTruthNonseed": case["fully_hidden_truth_nonseed"],
                    "provenance": case["provenance"],
                    "recordedMetricsSha256": digest(
                        HERE / "results" / f"{case['case_id']}-metrics.json"
                    ),
                },
                "scores": scores,
            }
        )
    results = {
        "schemaVersion": 1,
        "experimentId": "flowblock-synthetic-visible-mask-stress-v1",
        "attemptId": "synthetic-visible-mask-local-mps-attempt-001",
        "datasetManifestSha256": digest(OUTPUT / "manifest.json"),
        "tasksSha256": digest(OUTPUT / "tasks.json"),
        "model": {
            "name": "SAM-2_1-Small-synthetic-mask-stress",
            "provider": "local",
            "modelId": "facebook/sam2.1-hiera-small:sha256:"
            + summary["cases"][0]["provenance"]["checkpointSha256"],
            "promptSha256": None,
            "runtimeVersion": "SAM2 2b90b9f5ceec907a1c18123530e92e794ad901a4; framing-v1.1",
            "checkerVersion": "synthetic-visible-mask-stress-v1",
            "sourceHashes": {
                "benchmark.py": frozen["generator_sha256"],
                "research-contract.json": frozen["protocol_sha256"],
                **{
                    "worker/flowblock_worker/" + key: value
                    for key, value in frozen["worker_source_sha256"].items()
                },
            },
            "settings": {
                "device": "mps",
                "cpuFallbackForUnsupportedOps": True,
                "analysisFps": 15,
                "durationSecondsPerClip": 5,
                "seedFrame": 0,
                "laterReferencesSuppliedToTracker": False,
                "paidInference": False,
                "remoteModelInvocation": False,
                "maskThreshold": 0,
                "badMaskIoUThreshold": 0.5,
            },
        },
        "rows": rows,
        "summary": {
            "unitOfAnalysis": "six authored synthetic clips, not 444 independent tasks",
            "requestedClips": 6,
            "completedClips": 6,
            "scoredNonseedFrames": 444,
            "aggregateFrameMetrics": summary["aggregate_nonseed"],
            "visibleTruthFrameMetrics": summary["visible_truth_nonseed"],
            "fullyHiddenTruthFrameMetrics": summary["fully_hidden_truth_nonseed"],
            "equalClipMeanIoU": summary["equal_clip_mean_iou"],
            "processingSecondsTotal": sum(
                c["elapsed_processing_seconds"] for c in summary["cases"]
            ),
            "badMasksRestrictedToOneClip": "similar-object-crossing",
            "noPopulationConfidenceInterval": True,
        },
        "metadata": {
            "scope": "measurement-benchmark",
            "recordedAt": max(c["provenance"]["generatedAt"] for c in summary["cases"]),
            "limitations": summary["limitations"]
            + [
                "These six clips are now development data, not a fresh confirmation set for future tracker changes.",
                "Native Weave publication imports completed local executions and performs no inference.",
                "The publication task denominator is six clips; 444 frames are correlated within-clip measurements.",
            ],
        },
    }
    write(OUTPUT / "results.json", results)


if __name__ == "__main__":
    main()
