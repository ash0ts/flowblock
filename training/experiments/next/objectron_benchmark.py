"""Real-video development diagnostics against projected Objectron 3D boxes.

These labels are not visible silhouettes. Discrepancy measures are proxies,
not tracking accuracy or evidence of creator benefit. Downloaded data stays local.
"""

from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
VERSION = "objectron-projection-diagnostic-v1"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def command(args: list[str], timeout: int = 120) -> str:
    return subprocess.run(
        args, capture_output=True, text=True, check=True, timeout=timeout
    ).stdout


def video_metadata(path: Path) -> dict:
    raw = json.loads(
        command(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_streams",
                "-show_frames",
                "-show_entries",
                "stream=width,height,duration,nb_frames:stream_tags=rotate:stream_side_data=rotation:frame=best_effort_timestamp_time",
                "-of",
                "json",
                str(path),
            ]
        )
    )
    stream = raw["streams"][0]
    timestamps = [float(f["best_effort_timestamp_time"]) for f in raw["frames"]]
    if not timestamps or any(b <= a for a, b in zip(timestamps, timestamps[1:])):
        raise ValueError("Original presentation timestamps must increase strictly")
    rotation = next(
        (
            float(s["rotation"])
            for s in stream.get("side_data_list", [])
            if "rotation" in s
        ),
        float(stream.get("tags", {}).get("rotate", 0)),
    )
    return {
        "duration_seconds": float(stream["duration"]),
        "encoded_width": int(stream["width"]),
        "encoded_height": int(stream["height"]),
        "display_rotation_degrees": rotation,
        "presentation_timestamps": timestamps,
        "relative_timestamps": [t - timestamps[0] for t in timestamps],
    }


def projected_box(keypoints: list[dict]) -> dict:
    corners = [p for p in keypoints if p["id"] != 0]
    if len(corners) != 8 or any(p["depth_m"] <= 0 for p in corners):
        raise ValueError("Expected eight projected corners in front of the camera")
    xs, ys = [p["x"] for p in corners], [p["y"] for p in corners]
    if not all(math.isfinite(v) for v in [*xs, *ys]):
        raise ValueError("Non-finite projection")
    box = {
        "x": min(xs),
        "y": min(ys),
        "width": max(xs) - min(xs),
        "height": max(ys) - min(ys),
    }
    if min(box["width"], box["height"]) <= 0:
        raise ValueError("Degenerate projected box")
    return box


def prompt_box(box: dict) -> dict:
    """Clip only the annotation prompt; preserve the full reference projection."""
    x, y = max(0.0, box["x"]), max(0.0, box["y"])
    right, bottom = (
        min(1.0, box["x"] + box["width"]),
        min(1.0, box["y"] + box["height"]),
    )
    if right <= x or bottom <= y:
        raise ValueError("First-frame product projection does not intersect the image")
    return {"x": x, "y": y, "width": right - x, "height": bottom - y}


def nearest_index(timestamps: list[float], timestamp: float) -> int:
    index = bisect.bisect_left(timestamps, timestamp)
    choices = range(max(0, index - 1), min(len(timestamps), index + 1))
    return min(choices, key=lambda i: abs(timestamps[i] - timestamp))


def proxy_metrics(track: dict, reference: dict, width: int, height: int) -> dict | None:
    if track.get("center") is None or track.get("box") is None:
        return None
    center, box = track["center"], track["box"]
    target_center = reference["center"]
    extent = reference["box"]
    return {
        "mask_center_inside_projected_box": (
            extent["x"] <= center["x"] <= extent["x"] + extent["width"]
            and extent["y"] <= center["y"] <= extent["y"] + extent["height"]
        ),
        "mask_centroid_to_projected_3d_center_frame_diagonal_discrepancy": math.hypot(
            (center["x"] - target_center["x"]) * width,
            (center["y"] - target_center["y"]) * height,
        )
        / math.hypot(width, height),
        "mask_width_to_projected_box_width_ratio": box["width"] / extent["width"],
        "mask_height_to_projected_box_height_ratio": box["height"] / extent["height"],
    }


def export_annotations(dataset: Path) -> None:
    # Upstream generated protobuf code predates modern descriptor constructors.
    os.environ.setdefault("PROTOCOL_BUFFERS_PYTHON_IMPLEMENTATION", "python")
    sys.path.insert(0, str(dataset / "source"))
    from objectron.schema import annotation_data_pb2
    from google.protobuf.json_format import MessageToDict

    products = []
    for source in sorted((dataset / "sequences").rglob("annotations.pbdata")):
        sequence = annotation_data_pb2.Sequence()
        sequence.ParseFromString(source.read_bytes())
        sequence_id = source.parent.relative_to(dataset / "sequences").as_posix()
        objects = [
            {
                "object_id": o.id,
                "category": o.category,
                "type": o.type,
                "method": o.method,
                "dimensions_m": list(o.scale),
                "rotation_row_major": list(o.rotation),
                "translation_m": list(o.translation),
                "dimension_source": "Objectron manually annotated oriented 3D box, not physical survey",
            }
            for o in sequence.objects
        ]
        frames = [
            {
                "frame_id": frame.frame_id,
                "timestamp": frame.timestamp,
                "camera": MessageToDict(frame.camera, preserving_proto_field_name=True),
                "objects": [
                    {
                        "object_id": annotation.object_id,
                        "visibility_field": annotation.visibility,
                        "keypoints": [
                            {
                                "id": point.id,
                                "x": point.point_2d.x,
                                "y": point.point_2d.y,
                                "depth_m": point.point_2d.depth,
                                "point_3d_m": [
                                    point.point_3d.x,
                                    point.point_3d.y,
                                    point.point_3d.z,
                                ],
                            }
                            for point in annotation.keypoints
                        ],
                    }
                    for annotation in frame.annotations
                ],
            }
            for frame in sequence.frame_annotations
        ]
        record = {
            "sequence_id": sequence_id,
            "annotation_sha256": digest(source),
            "objects": objects,
            "frames": frames,
            "label_definition": "Projected manually annotated 3D box; not visible silhouette",
        }
        write_json(source.parent / "annotations.json", record)
        products.append(
            {k: v for k, v in record.items() if k != "frames"}
            | {
                "frame_count": len(frames),
                "annotation_timestamp_values": sorted({f["timestamp"] for f in frames}),
            }
        )
    write_json(dataset / "product-dimensions.json", products)


def prepare(dataset: Path, output: Path) -> None:
    output.mkdir(parents=True, exist_ok=False)
    rows = []
    for source in sorted((dataset / "sequences").rglob("video.MOV")):
        sequence_id = source.parent.relative_to(dataset / "sequences").as_posix()
        row = {"sequence_id": sequence_id, "source_video_sha256": digest(source)}
        annotation_path = source.parent / "annotations.json"
        if not annotation_path.exists():
            rows.append(
                row | {"status": "excluded", "reason": "annotation unavailable"}
            )
            continue
        annotation = json.loads(annotation_path.read_text())
        metadata = video_metadata(source)
        row["original_video"] = metadata
        if metadata["duration_seconds"] < 5:
            rows.append(
                row
                | {
                    "status": "excluded",
                    "reason": "source shorter than worker minimum of 5 seconds",
                }
            )
            continue
        if metadata["display_rotation_degrees"] != -90:
            raise ValueError(
                "This cohort adapter's reviewed upright convention is -90-degree Objectron MOV only"
            )
        frames = annotation["frames"]
        if [f["frame_id"] for f in frames] != list(
            range(len(metadata["relative_timestamps"]))
        ):
            raise ValueError(
                f"Annotation frame IDs do not align one-to-one with decoded frames: {sequence_id}"
            )
        if len(annotation["objects"]) != 1:
            raise ValueError(
                "This development protocol requires exactly one annotated product"
            )
        references = []
        for frame in frames:
            if len(frame["objects"]) != 1:
                raise ValueError("Missing or ambiguous frame object")
            keypoints = frame["objects"][0]["keypoints"]
            center = next(p for p in keypoints if p["id"] == 0)
            references.append(
                {
                    "frame_id": frame["frame_id"],
                    "source_seconds": metadata["relative_timestamps"][
                        frame["frame_id"]
                    ],
                    "center": {"x": center["x"], "y": center["y"]},
                    "box": projected_box(keypoints),
                }
            )
        directory = output / sequence_id.replace("/", "_")
        directory.mkdir()
        clip = directory / "first-five-seconds.mp4"
        command(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(source),
                "-t",
                "5",
                "-map",
                "0:v:0",
                "-an",
                "-sn",
                "-dn",
                "-vf",
                "scale=720:960,setsar=1",
                "-c:v",
                "libx264",
                "-preset",
                "fast",
                "-crf",
                "18",
                "-fps_mode",
                "passthrough",
                "-metadata:s:v:0",
                "rotate=0",
                str(clip),
            ]
        )
        seed = prompt_box(references[0]["box"])
        manifest = {
            "jobId": f"{VERSION}-{sequence_id}",
            "takeId": sequence_id,
            "planId": "diagnostic-fixed-target",
            "seed": {"timeSeconds": 0, "box": seed},
            "corrections": [],
            "expectedVisible": {"startSeconds": 0, "endSeconds": 5},
            "plannedDurationSeconds": 5,
            "targetKeyframes": [
                {
                    "timeSeconds": t,
                    "centerX": seed["x"] + seed["width"] / 2,
                    "centerY": seed["y"] + seed["height"] / 2,
                    "width": seed["width"],
                    "height": seed["height"],
                }
                for t in (0, 5)
            ],
        }
        write_json(directory / "manifest.json", manifest)
        write_json(directory / "references.json", references)
        row.update(
            {
                "status": "prepared",
                "directory": directory.relative_to(output).as_posix(),
                "annotation_sha256": annotation["annotation_sha256"],
                "clip_sha256": digest(clip),
                "references_sha256": digest(directory / "references.json"),
                "manifest_sha256": digest(directory / "manifest.json"),
                "annotation_timestamps_used": False,
                "time_mapping": "frame_id indexes decoded original presentation timestamps; annotation timestamp is a zero default",
                "orientation": "Objectron normalized projections already match the upright displayed image; FFmpeg applies MOV rotation once",
                "prompt": "Clipped first-frame projected 3D box; no later labels given to SAM",
                "findings_scope": "Fixed initial-frame target is diagnostic only, not an authored brief or creator performance judgment",
            }
        )
        rows.append(row)
    write_json(
        output / "cohort.json",
        {
            "version": VERSION,
            "adapter_sha256": digest(Path(__file__)),
            "phase": "development-diagnostic",
            "rows": rows,
            "limitations": [
                "Convenience sample from upstream test indices, not FlowBlock confirmation data",
                "Projected 3D boxes are not visible silhouettes; metrics are discrepancy proxies, not mask accuracy",
                "No creator treatment, usability judgment, calibrated confidence or camera-distance inference",
            ],
        },
    )


def run_benchmark(output: Path, limit: int | None) -> None:
    sys.path.insert(0, str(ROOT / "worker"))
    from flowblock_worker.model import Segmenter
    from flowblock_worker.pipeline import process

    cohort = json.loads((output / "cohort.json").read_text())
    segmenter = Segmenter("mps")
    selected = [row for row in cohort["rows"] if row["status"] == "prepared"]
    if limit is not None:
        selected = selected[:limit]
    for row in selected:
        directory = output / row["directory"]
        result_path = directory / "metrics.json"
        if result_path.exists():
            print(
                json.dumps(
                    {"sequence_id": row["sequence_id"], "status": "already-recorded"}
                ),
                flush=True,
            )
            continue
        if (directory / "analysis").exists():
            raise ValueError(
                "Unfinished analysis exists; inspect it and use a separate attempt directory"
            )
        for name, key in [
            ("first-five-seconds.mp4", "clip_sha256"),
            ("references.json", "references_sha256"),
            ("manifest.json", "manifest_sha256"),
        ]:
            if digest(directory / name) != row[key]:
                raise ValueError("Prepared input hash changed")
        started = time.monotonic()
        analysis = process(
            directory / "first-five-seconds.mp4",
            json.loads((directory / "manifest.json").read_text()),
            directory / "analysis",
            segmenter,
        )
        elapsed = time.monotonic() - started
        references = json.loads((directory / "references.json").read_text())
        timestamps = [r["source_seconds"] for r in references]
        observations = []
        for track in analysis["tracks"]:
            index = nearest_index(timestamps, track["timestamp"])
            delta = abs(timestamps[index] - track["timestamp"])
            if delta > 0.018:
                raise ValueError(
                    "Worker-to-original timestamp mapping exceeds half a source frame"
                )
            observations.append(
                {
                    "source_frame_id": index,
                    "source_seconds": timestamps[index],
                    "worker_seconds": track["timestamp"],
                    "timestamp_difference_seconds": delta,
                    "seed_frame": index == 0,
                    "tracking_status": track["visibility"],
                    "uncertainty_reasons": track["uncertaintyReasons"],
                    "metrics": proxy_metrics(
                        track,
                        references[index],
                        analysis["video"]["width"],
                        analysis["video"]["height"],
                    ),
                }
            )
        eligible = [o for o in observations if not o["seed_frame"]]
        usable = [
            o
            for o in eligible
            if o["tracking_status"] == "visible" and o["metrics"] is not None
        ]
        keys = list(usable[0]["metrics"]) if usable else []
        summary = {
            "evaluation_samples_excluding_seed": len(eligible),
            "usable_samples": len(usable),
            "usable_fraction": len(usable) / len(eligible) if eligible else None,
            "mean_proxy_metrics_on_usable_samples": {
                key: sum(o["metrics"][key] for o in usable) / len(usable)
                for key in keys
            },
        }
        result = {
            "version": VERSION,
            "sequence_id": row["sequence_id"],
            "phase": "development-diagnostic",
            "elapsed_processing_seconds": elapsed,
            "provenance": analysis["provenance"],
            "source_video_sha256": row["source_video_sha256"],
            "annotation_sha256": row["annotation_sha256"],
            "adapter_sha256": digest(Path(__file__)),
            "worker_source_sha256": {
                p.name: digest(p)
                for p in sorted((ROOT / "worker" / "flowblock_worker").glob("*.py"))
            },
            "summary": summary,
            "observations": observations,
            "limitations": cohort["limitations"],
        }
        write_json(result_path, result)
        print(
            json.dumps(
                {
                    "sequence_id": row["sequence_id"],
                    "elapsed_seconds": elapsed,
                    **summary,
                }
            ),
            flush=True,
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["export", "prepare", "run"])
    parser.add_argument(
        "--dataset",
        type=Path,
        default=ROOT / "training/artifacts/public-data/objectron",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "training/artifacts/objectron-diagnostic-v1",
    )
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    if args.action == "export":
        export_annotations(args.dataset.resolve())
    elif args.action == "prepare":
        prepare(args.dataset.resolve(), args.output.resolve())
    else:
        run_benchmark(args.output.resolve(), args.limit)
