"""Freeze and run a local Objectron development regression without replacing attempts."""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
from importlib import metadata, util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import time

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
ADAPTER = Path("training/experiments/next/objectron_benchmark.py")
VERSION = "objectron-current-worker-development-v1"
PACKAGES = (
    "torch",
    "torchvision",
    "numpy",
    "opencv-python-headless",
    "Pillow",
    "hydra-core",
    "iopath",
    "tqdm",
)
SCOPE = {
    "evidence_kind": "public-dataset-tracking",
    "cohort_exposure": "previously-inspected-development",
    "reference_kind": "projected-3d-cuboid",
    "authored_flowblock_take": False,
    "creator_outcome_measured": False,
    "visible_mask_accuracy_measured": False,
}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def runtime_identity() -> dict:
    return {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "packages": {name: metadata.version(name) for name in PACKAGES},
        "ffmpeg": subprocess.check_output(
            ["ffmpeg", "-version"], text=True
        ).splitlines()[0],
        "ffprobe": subprocess.check_output(
            ["ffprobe", "-version"], text=True
        ).splitlines()[0],
    }


def source_paths() -> list[Path]:
    return [
        ADAPTER,
        *(
            Path("worker/flowblock_worker") / name
            for name in (
                "__init__.py",
                "pipeline.py",
                "model.py",
                "measurement.py",
                "video.py",
            )
        ),
        Path("worker/models/manifest.json"),
        *(
            HERE.relative_to(ROOT) / name
            for name in (
                "validate_real_footage.py",
                "research-contract.json",
                "test_field_validation.py",
            )
        ),
    ]


def checked_child(directory: Path, relative: str) -> Path:
    path = (directory / relative).resolve()
    if not path.is_relative_to(directory.resolve()):
        raise ValueError("Artifact path escapes attempt directory")
    return path


def freeze(
    previous: Path, dataset: Path, output: Path, selection: list[str] | None
) -> dict:
    prior = read_json(previous / "cohort.json")
    eligible = [
        row["sequence_id"] for row in prior["rows"] if row["status"] == "prepared"
    ]
    selected = eligible if selection is None else selection
    if (
        not selected
        or len(set(selected)) != len(selected)
        or not set(selected) <= set(eligible)
    ):
        raise ValueError("Selection must contain distinct eligible sequence IDs")
    # Check every copied byte before creating the immutable attempt.
    inputs = []
    for row in prior["rows"]:
        if row["sequence_id"] not in selected:
            continue
        for name, key in (
            ("first-five-seconds.mp4", "clip_sha256"),
            ("references.json", "references_sha256"),
            ("manifest.json", "manifest_sha256"),
        ):
            relative = f"{row['directory']}/{name}"
            source = checked_child(previous, relative)
            if digest(source) != row[key]:
                raise ValueError(f"Prior prepared input changed: {relative}")
            inputs.append({"path": relative, "sha256": row[key]})
    identity = runtime_identity()
    output.mkdir(parents=True, exist_ok=False)
    for item in inputs:
        destination = checked_child(output, item["path"])
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(checked_child(previous, item["path"]), destination)
    cohort = dict(prior)
    cohort["phase"] = "previously-inspected-development-regression"
    cohort["rows"] = [
        row | {"status": "not_selected", "reason": "Not selected in frozen protocol"}
        if row["status"] == "prepared" and row["sequence_id"] not in selected
        else row
        for row in prior["rows"]
    ]
    write_json(output / "cohort.json", cohort)
    inputs.append({"path": "cohort.json", "sha256": digest(output / "cohort.json")})
    sources = []
    for path in source_paths():
        snapshot = Path("runtime") / f"{path.as_posix()}.txt"
        destination = output / snapshot
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / path, destination)
        sources.append(
            {
                "source": os.path.relpath(ROOT / path, output),
                "snapshot": snapshot.as_posix(),
                "sha256": digest(destination),
            }
        )
    provenance = []
    for path in (
        dataset / "source/LICENSE",
        dataset / "ATTRIBUTION.md",
        previous / "cohort.json",
    ):
        destination = output / "provenance" / path.name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        provenance.append(
            {
                "path": destination.relative_to(output).as_posix(),
                "sha256": digest(destination),
            }
        )
    manifest = {
        "version": VERSION,
        "frozen_at": utc_now(),
        "scope": SCOPE,
        "selected_sequence_ids": selected,
        "original_selected_count": len(prior["rows"]),
        "execution": {
            "device": "mps",
            "concurrency": 1,
            "attempts_per_sequence": 1,
            "stop_on_error": True,
        },
        "runtime": identity,
        "sources": sources,
        "inputs": inputs,
        "provenance": provenance,
        "previous_attempt": os.path.relpath(previous, output),
        "limitations": prior["limitations"]
        + [
            "These exact recordings have already been inspected; this run is not fresh held-out evidence.",
            "MPS uses CPU fallback for unsupported operations; execution times are local observations, not a service promise.",
        ],
    }
    write_json(output / "freeze.json", manifest)
    return manifest


def verify(output: Path, *, live_sources: bool = True) -> dict:
    manifest = read_json(output / "freeze.json")
    if manifest["version"] != VERSION or manifest["scope"] != SCOPE:
        raise ValueError("Unsupported experiment version or evidence scope")
    for item in manifest["inputs"] + manifest["provenance"]:
        if digest(checked_child(output, item["path"])) != item["sha256"]:
            raise ValueError(f"Frozen artifact changed: {item['path']}")
    for item in manifest["sources"]:
        if digest(checked_child(output, item["snapshot"])) != item["sha256"]:
            raise ValueError(f"Frozen source snapshot changed: {item['snapshot']}")
        if live_sources and digest(output / item["source"]) != item["sha256"]:
            raise ValueError(f"Executed source changed: {item['source']}")
    if live_sources and runtime_identity() != manifest["runtime"]:
        raise ValueError("Executed dependency or platform identity changed")
    return manifest


def load_adapter():
    spec = util.spec_from_file_location(
        "field_validation_objectron_adapter", ROOT / ADAPTER
    )
    module = util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def summarize(output: Path, status: str, elapsed: float, error: str | None) -> dict:
    frozen = read_json(output / "freeze.json")
    rows = []
    for row in read_json(output / "cohort.json")["rows"]:
        result = {"sequence_id": row["sequence_id"], "status": row["status"]}
        if row["status"] != "prepared":
            rows.append(result | {"reason": row["reason"]})
            continue
        directory = checked_child(output, row["directory"])
        metrics_path = directory / "metrics.json"
        if not metrics_path.exists():
            result["status"] = (
                "failed" if (directory / "analysis").exists() else "unattempted"
            )
            rows.append(result)
            continue
        metrics = read_json(metrics_path)
        if metrics["provenance"]["realInference"] is not True:
            raise ValueError("Public-video results must come from real inference")
        rows.append(
            result
            | {
                "status": "completed",
                "metrics": f"{row['directory']}/metrics.json",
                "metrics_sha256": digest(metrics_path),
                "analysis_sha256": digest(directory / "analysis/analysis.json"),
                "elapsed_processing_seconds": metrics["elapsed_processing_seconds"],
                "provenance": metrics["provenance"],
                "summary": metrics["summary"],
            }
        )
    completed = [row for row in rows if row["status"] == "completed"]
    evaluated = sum(
        row["summary"]["evaluation_samples_excluding_seed"] for row in completed
    )
    usable = sum(row["summary"]["usable_samples"] for row in completed)
    metric_keys = {
        key
        for row in completed
        for key in row["summary"]["mean_proxy_metrics_on_usable_samples"]
    }
    aggregate = {}
    for key in sorted(metric_keys):
        values = [
            row["summary"]["mean_proxy_metrics_on_usable_samples"][key]
            for row in completed
            if key in row["summary"]["mean_proxy_metrics_on_usable_samples"]
        ]
        aggregate[key] = {
            "mean": sum(values) / len(values),
            "contributing_videos": len(values),
        }
    return {
        "version": VERSION,
        "scope": SCOPE,
        "freeze_sha256": digest(output / "freeze.json"),
        "execution_status": status,
        "execution_error": error,
        "finished_at": utc_now(),
        "elapsed_wall_seconds_including_model_setup": elapsed,
        "counts": dict(Counter(row["status"] for row in rows)),
        "selected_for_execution": len(frozen["selected_sequence_ids"]),
        "evaluation_samples_excluding_seed": evaluated,
        "usable_samples": usable,
        "usable_fraction": usable / evaluated if evaluated else None,
        "equal_video_mean_proxy_metrics": aggregate,
        "rows": rows,
        "limitations": frozen["limitations"],
    }


def run(output: Path) -> dict:
    verify(output)
    # An exclusive claim prevents retries from turning an uncertain outcome into a new result.
    write_json(
        output / "execution-started.json",
        {"started_at": utc_now(), "freeze_sha256": digest(output / "freeze.json")},
    )
    started = time.monotonic()
    status, error = "completed", None
    try:
        load_adapter().run_benchmark(output, None)
        verify(output)
    except Exception as exc:
        status, error = "failed", f"{type(exc).__name__}: {exc}"
    result = summarize(output, status, time.monotonic() - started, error)
    write_json(output / "summary.json", result)
    if status != "completed":
        raise RuntimeError(f"Attempt stopped; preserved summary.json: {error}")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("freeze", "verify", "run"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--previous",
        type=Path,
        default=ROOT / "training/artifacts/objectron-diagnostic-v1",
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        default=ROOT / "training/artifacts/public-data/objectron",
    )
    parser.add_argument(
        "--sequence",
        action="append",
        help="Predeclare a subset at freeze time; default is all eligible clips",
    )
    args = parser.parse_args()
    if args.sequence and args.action != "freeze":
        parser.error("Selection belongs to freeze, not execution")
    output = args.output.resolve()
    if args.action == "freeze":
        result = freeze(
            args.previous.resolve(), args.dataset.resolve(), output, args.sequence
        )
    elif args.action == "verify":
        result = verify(output)
    else:
        result = run(output)
    print(
        json.dumps(
            {
                "action": args.action,
                "output": str(output),
                "version": result["version"],
                "scope": result["scope"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
