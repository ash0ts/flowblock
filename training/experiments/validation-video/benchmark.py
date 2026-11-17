"""Frozen synthetic development diagnostics for the unmodified FlowBlock SAM worker."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import platform
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
WIDTH, HEIGHT, FPS, FRAMES = 320, 180, 15, 75
CASES = [
    "textured-translation",
    "textureless-translation",
    "gradual-scale",
    "boundary-exit-reentry",
    "occlusion-recovery",
    "similar-object-crossing",
]


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def silhouette(cx: float, cy: float, scale: float) -> np.ndarray:
    image = Image.new("L", (WIDTH, HEIGHT))
    draw = ImageDraw.Draw(image)

    def rect(values):
        x0, y0, x1, y1 = values
        return tuple(
            round(v)
            for v in (
                cx + x0 * scale,
                cy + y0 * scale,
                cx + x1 * scale,
                cy + y1 * scale,
            )
        )

    draw.rounded_rectangle(
        rect((-21, -35, 21, 43)), radius=max(1, round(8 * scale)), fill=255
    )
    draw.rectangle(rect((-11, -46, 11, -32)), fill=255)
    return np.asarray(image) > 0


def render(case: str, index: int) -> tuple[Image.Image, np.ndarray, dict]:
    """Truth is the visible raster silhouette after occlusion, not an amodal box."""
    t = index / (FRAMES - 1)
    cx, cy, scale = 110 + 100 * t, 94.0, 1.0
    if case == "gradual-scale":
        cx, scale = 160, 0.65 + 0.75 * t
    elif case == "boundary-exit-reentry":
        cx = 160 + 190 * math.sin(math.pi * t)
    elif case == "occlusion-recovery":
        cx = 80 + 160 * t
    elif case == "similar-object-crossing":
        cx = 80 + 160 * t
    base = Image.new("RGB", (WIDTH, HEIGHT), (220, 215, 204))
    draw = ImageDraw.Draw(base)
    draw.rectangle((0, 145, WIDTH, HEIGHT), fill=(190, 177, 156))
    draw.line((0, 35, WIDTH, 35), fill=(205, 200, 189), width=1)
    target = silhouette(cx, cy, scale)
    color = (44, 83, 68)
    layer = Image.new("RGB", base.size, color)
    detail = ImageDraw.Draw(layer)
    if case != "textureless-translation":
        detail.rectangle(
            (
                round(cx - 16 * scale),
                round(cy - 13 * scale),
                round(cx + 16 * scale),
                round(cy + 23 * scale),
            ),
            fill=(239, 233, 208),
        )
        for offset in (-8, 0, 8):
            detail.line(
                (
                    round(cx - 11 * scale),
                    round(cy + offset * scale),
                    round(cx + 11 * scale),
                    round(cy + offset * scale),
                ),
                fill=(63, 83, 62),
                width=max(1, round(2 * scale)),
            )
    base.paste(layer, mask=Image.fromarray(target.astype(np.uint8) * 255))
    visible = target.copy()
    occluder = np.zeros_like(target)
    if case == "occlusion-recovery":
        # A fixed opaque foreground panel fully covers the target near the midpoint.
        occluder[:, 133:188] = True
        ImageDraw.Draw(base).rectangle((133, 0, 187, HEIGHT - 1), fill=(102, 88, 73))
    elif case == "similar-object-crossing":
        # Same-family foreground distractor crosses the seeded target; it is not truth.
        distractor_x = 250 - 170 * t
        occluder = silhouette(distractor_x, cy + 4, 1.0)
        base.paste(
            Image.new("RGB", base.size, (48, 86, 72)),
            mask=Image.fromarray(occluder.astype(np.uint8) * 255),
        )
    visible &= ~occluder
    return (
        base,
        visible,
        {
            "frame_index": index,
            "timestamp": index / FPS,
            "target_visible_pixels": int(visible.sum()),
            "target_pre_occlusion_pixels_in_image": int(target.sum()),
            "fully_hidden": not bool(visible.any()),
        },
    )


def extent(mask: np.ndarray) -> dict | None:
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    return {
        "x": float(xs.min() / WIDTH),
        "y": float(ys.min() / HEIGHT),
        "width": float((xs.max() - xs.min() + 1) / WIDTH),
        "height": float((ys.max() - ys.min() + 1) / HEIGHT),
        "center_x": float((xs.mean() + 0.5) / WIDTH),
        "center_y": float((ys.mean() + 0.5) / HEIGHT),
    }


def score_mask(predicted: np.ndarray, truth: np.ndarray) -> dict:
    union = int((predicted | truth).sum())
    intersection = int((predicted & truth).sum())
    iou = intersection / union if union else 1.0
    pred, actual = extent(predicted), extent(truth)
    return {
        "iou": iou,
        "bad_mask": iou < 0.5,
        "truth_pixels": int(truth.sum()),
        "predicted_pixels": int(predicted.sum()),
        "truth_visible": bool(truth.any()),
        "center_error_frame_diagonal": math.hypot(
            (pred["center_x"] - actual["center_x"]) * WIDTH,
            (pred["center_y"] - actual["center_y"]) * HEIGHT,
        )
        / math.hypot(WIDTH, HEIGHT)
        if pred and actual
        else None,
        "extent_error_max_normalized": max(
            abs(pred["width"] - actual["width"]), abs(pred["height"] - actual["height"])
        )
        if pred and actual
        else None,
    }


def prepare(output: Path):
    output.mkdir(parents=True, exist_ok=False)
    cases = []
    for case in CASES:
        directory = output / case
        frames = directory / "source-frames"
        frames.mkdir(parents=True)
        masks, rows = [], []
        for index in range(FRAMES):
            image, mask, row = render(case, index)
            image.save(frames / f"{index:05d}.png")
            masks.append(mask)
            rows.append(row)
        np.savez_compressed(directory / "truth.npz", masks=np.array(masks))
        write_json(directory / "truth-frames.json", rows)
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-framerate",
                str(FPS),
                "-i",
                str(frames / "%05d.png"),
                "-c:v",
                "libx264",
                "-crf",
                "18",
                "-pix_fmt",
                "yuv420p",
                str(directory / "clip.mp4"),
            ],
            check=True,
        )
        seed_extent = extent(masks[0])
        seed = {k: seed_extent[k] for k in ("x", "y", "width", "height")}
        manifest = {
            "jobId": case,
            "takeId": case,
            "planId": "synthetic-stress-diagnostic",
            "planVersion": "1",
            "outputPrefix": case,
            "seed": {"timeSeconds": 0, "box": seed},
            "corrections": [],
            "expectedVisible": {"startSeconds": 0, "endSeconds": 5},
            "plannedDurationSeconds": 5,
            "targetKeyframes": [
                {
                    "timeSeconds": sec,
                    "centerX": seed_extent["center_x"],
                    "centerY": seed_extent["center_y"],
                    "width": seed["width"],
                    "height": seed["height"],
                }
                for sec in (0, 5)
            ],
        }
        write_json(directory / "manifest.json", manifest)
        cases.append(
            {
                "case_id": case,
                "directory": case,
                "sha256": {
                    p.name: sha(p)
                    for p in (
                        directory / "clip.mp4",
                        directory / "truth.npz",
                        directory / "truth-frames.json",
                        directory / "manifest.json",
                    )
                },
            }
        )
    frozen = {
        "version": "synthetic-visible-mask-stress-v1",
        "phase": "development-diagnostic",
        "created_at_unix": time.time(),
        "width": WIDTH,
        "height": HEIGHT,
        "fps": FPS,
        "frames_per_clip": FRAMES,
        "generator_sha256": sha(Path(__file__)),
        "protocol_sha256": sha(HERE / "research-contract.json"),
        "worker_source_sha256": {
            p.name: sha(p)
            for p in sorted((ROOT / "worker/flowblock_worker").glob("*.py"))
        },
        "model_manifest_sha256": sha(ROOT / "worker/models/manifest.json"),
        "cases": cases,
    }
    write_json(output / "frozen-manifest.json", frozen)
    print(
        json.dumps(
            {
                "status": "frozen",
                "cases": len(cases),
                "manifest_sha256": sha(output / "frozen-manifest.json"),
            }
        )
    )


def summarize(rows: list[dict]) -> dict:
    accepted = [r for r in rows if r["accepted_by_worker"]]
    bad = [r for r in rows if r["bad_mask"]]
    errors = {
        key: [r[key] for r in rows if r[key] is not None]
        for key in ("center_error_frame_diagonal", "extent_error_max_normalized")
    }
    return {
        "samples": len(rows),
        "mean_iou": float(np.mean([r["iou"] for r in rows])) if rows else None,
        "bad_masks": len(bad),
        "accepted_by_worker": len(accepted),
        "false_accepted_bad_masks": sum(r["accepted_by_worker"] for r in bad),
        "bad_fraction_of_accepted": sum(r["bad_mask"] for r in accepted) / len(accepted)
        if accepted
        else None,
        "false_accept_fraction_of_bad": sum(r["accepted_by_worker"] for r in bad)
        / len(bad)
        if bad
        else None,
        "uncertain": sum(r["worker_visibility"] == "uncertain" for r in rows),
        "missing": sum(r["worker_visibility"] == "missing" for r in rows),
        **{
            key: {
                "mean": float(np.mean(vals)) if vals else None,
                "defined_samples": len(vals),
            }
            for key, vals in errors.items()
        },
    }


def run(inputs: Path, output: Path):
    frozen = json.loads((inputs / "frozen-manifest.json").read_text())
    if (
        sha(Path(__file__)) != frozen["generator_sha256"]
        or sha(HERE / "research-contract.json") != frozen["protocol_sha256"]
    ):
        raise ValueError("Frozen benchmark source or protocol changed")
    for name, expected in frozen["worker_source_sha256"].items():
        if sha(ROOT / "worker/flowblock_worker" / name) != expected:
            raise ValueError("Worker changed after fixture freeze")
    if sha(ROOT / "worker/models/manifest.json") != frozen["model_manifest_sha256"]:
        raise ValueError("Model manifest changed after fixture freeze")
    output.mkdir(parents=True, exist_ok=False)
    sys.path.insert(0, str(ROOT / "worker"))
    from flowblock_worker import model
    from flowblock_worker.pipeline import process

    segmenter = model.Segmenter("mps")
    records = []
    for case in frozen["cases"]:
        source = inputs / case["directory"]
        directory = output / case["case_id"]
        directory.mkdir()
        for name, expected in case["sha256"].items():
            if sha(source / name) != expected:
                raise ValueError("Frozen input changed")
        captured = []
        original = model.describe_mask

        def observe(logits, width, height):
            if (width, height) != (WIDTH, HEIGHT):
                raise ValueError("Unexpected worker resize")
            captured.append((logits > 0).copy())
            return original(logits, width, height)

        started = time.monotonic()
        model.describe_mask = observe
        try:
            result = process(
                source / "clip.mp4",
                json.loads((source / "manifest.json").read_text()),
                directory / "worker",
                segmenter,
            )
        finally:
            model.describe_mask = original
        elapsed = time.monotonic() - started
        if len(captured) != FRAMES or len(result["tracks"]) != FRAMES:
            raise ValueError("Expected one forward mask for each of 75 frames")
        truth = np.load(source / "truth.npz")["masks"]
        np.savez_compressed(directory / "predicted-masks.npz", masks=np.array(captured))
        rows = []
        for index, (track, prediction, reference) in enumerate(
            zip(result["tracks"], captured, truth)
        ):
            if (
                track["frameIndex"] != index
                or abs(track["timestamp"] - index / FPS) > 0.0001
            ):
                raise ValueError("Output frame-to-truth timing mismatch")
            rows.append(
                {
                    "frame_index": index,
                    "timestamp": track["timestamp"],
                    "is_prompt_frame": index == 0,
                    "worker_visibility": track["visibility"],
                    "worker_uncertainty_reasons": track["uncertaintyReasons"],
                    "accepted_by_worker": track["visibility"] == "visible",
                    **score_mask(prediction, reference),
                }
            )
        eligible = rows[1:]
        record = {
            "case_id": case["case_id"],
            "elapsed_processing_seconds": elapsed,
            "provenance": result["provenance"],
            "all_nonseed": summarize(eligible),
            "visible_truth_nonseed": summarize(
                [r for r in eligible if r["truth_visible"]]
            ),
            "fully_hidden_truth_nonseed": summarize(
                [r for r in eligible if not r["truth_visible"]]
            ),
            "observations": rows,
        }
        write_json(directory / "metrics.json", record)
        records.append(record)
        print(
            json.dumps(
                {
                    "case_id": case["case_id"],
                    "elapsed_seconds": elapsed,
                    **record["all_nonseed"],
                }
            ),
            flush=True,
        )
    eligible = [
        row
        for record in records
        for row in record["observations"]
        if not row["is_prompt_frame"]
    ]
    report = {
        "version": frozen["version"],
        "phase": frozen["phase"],
        "frozen_manifest_sha256": sha(inputs / "frozen-manifest.json"),
        "platform": platform.platform(),
        "python": sys.version,
        "aggregate_nonseed": summarize(eligible),
        "visible_truth_nonseed": summarize([r for r in eligible if r["truth_visible"]]),
        "fully_hidden_truth_nonseed": summarize(
            [r for r in eligible if not r["truth_visible"]]
        ),
        "equal_clip_mean_iou": float(
            np.mean([r["all_nonseed"]["mean_iou"] for r in records])
        ),
        "cases": [{k: v for k, v in r.items() if k != "observations"} for r in records],
        "limitations": [
            "Six authored synthetic clips share one rendered product shape and are not independent real-product samples.",
            "Visible-mask truth is produced by our raster renderer independently of SAM, not human annotation.",
            "IoU<0.5 is a frozen diagnostic threshold, not a validated product usability cutoff.",
            "No creator treatment or claim about time to usable footage.",
            "Expected visibility covers the whole clip; fully hidden ground-truth frames are separately scored as an abstention stress condition.",
            "Boundary rasterization and video compression can affect edge agreement.",
        ],
    }
    write_json(output / "summary.json", report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "run"])
    parser.add_argument("--inputs", type=Path, default=HERE / "artifacts/frozen-v1")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.output.resolve()) if args.action == "prepare" else run(
        args.inputs.resolve(), args.output.resolve()
    )


if __name__ == "__main__":
    main()
