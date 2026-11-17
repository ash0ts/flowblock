"""Build the local report and contact sheet from one preserved benchmark attempt."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def font(size: int):
    for path in (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size=size)


def build(inputs: Path, attempt: Path, destination: Path):
    destination.mkdir(parents=True, exist_ok=False)
    report = json.loads((attempt / "summary.json").read_text())
    shutil.copy2(attempt / "summary.json", destination / "summary.json")
    if (attempt / "environment.json").exists():
        shutil.copy2(attempt / "environment.json", destination / "environment.json")
    shutil.copy2(inputs / "frozen-manifest.json", destination / "frozen-manifest.json")
    rows, selections = [], []
    sheet = Image.new("RGB", (1000, 90 + 270 * len(report["cases"])), "#f4f1e9")
    draw = ImageDraw.Draw(sheet)
    draw.text(
        (16, 12),
        "Synthetic segmentation stress: selected diagnostic frames",
        fill="#17201b",
        font=font(24),
    )
    draw.text(
        (16, 45),
        "Per clip: worst IoU among accepted bad masks; otherwise worst non-seed IoU.",
        fill="#3a453f",
        font=font(17),
    )
    for number, case in enumerate(report["cases"]):
        identifier = case["case_id"]
        metrics = json.loads((attempt / identifier / "metrics.json").read_text())
        shutil.copy2(
            attempt / identifier / "metrics.json",
            destination / f"{identifier}-metrics.json",
        )
        eligible = [
            row for row in metrics["observations"] if not row["is_prompt_frame"]
        ]
        accepted_bad = [
            row for row in eligible if row["accepted_by_worker"] and row["bad_mask"]
        ]
        selected = min(
            accepted_bad or eligible, key=lambda row: (row["iou"], row["frame_index"])
        )
        index = selected["frame_index"]
        original = Image.open(
            attempt / identifier / "worker/frames" / f"{index:05d}.jpg"
        ).convert("RGB")
        truth = np.load(inputs / identifier / "truth.npz")["masks"][index]
        prediction = np.load(attempt / identifier / "predicted-masks.npz")["masks"][
            index
        ]
        top = 90 + number * 270
        draw.text(
            (16, top),
            f"{identifier} | {selected['timestamp']:.2f}s | IoU {selected['iou']:.3f} | worker: {selected['worker_visibility']}",
            fill="#17201b",
            font=font(18),
        )
        for column, (label, image) in enumerate(
            [
                ("Worker input", original),
                (
                    "Renderer truth: visible target",
                    Image.fromarray(truth.astype(np.uint8) * 255).convert("RGB"),
                ),
                (
                    "SAM output: threshold > 0",
                    Image.fromarray(prediction.astype(np.uint8) * 255).convert("RGB"),
                ),
            ]
        ):
            x = 10 + column * 330
            draw.text((x, top + 30), label, fill="#3a453f", font=font(15))
            sheet.paste(image, (x, top + 55))
        selections.append(
            {
                "case_id": identifier,
                "frame_index": index,
                "timestamp": selected["timestamp"],
                "iou": selected["iou"],
                "worker_visibility": selected["worker_visibility"],
                "selection": "worst accepted bad nonseed"
                if accepted_bad
                else "worst nonseed",
            }
        )
        rows.extend({"case_id": identifier, **row} for row in eligible)
    sheet.save(destination / "selected-frames.png")
    fields = [key for key in rows[0] if key != "worker_uncertainty_reasons"]
    with (destination / "frame-metrics.csv").open("w") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows({key: row[key] for key in fields} for row in rows)
    aggregate = report["aggregate_nonseed"]
    lines = [
        "# Synthetic visible-mask stress diagnostic",
        "",
        "This is a six-clip development diagnostic using one authored rendered product shape. SAM predictions are compared with visible alpha masks produced by our renderer. It does not measure accuracy on real products or creator benefit.",
        "",
        f"The unchanged pinned SAM 2.1 Small worker completed all six clips locally on MPS. The first prompt frame is excluded, leaving **{aggregate['samples']} scored frames**. {aggregate['bad_masks']} masks had IoU below the frozen 0.5 threshold; **{aggregate['false_accepted_bad_masks']} of those were still labeled visible by the worker**. Frames within a clip are correlated observations, not independent trials.",
        "",
        "| Case | Mean IoU | Bad masks / 74 | Worker accepted / 74 | Accepted bad masks | Fully hidden truth frames | Processing seconds |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for case in report["cases"]:
        row = case["all_nonseed"]
        lines.append(
            f"| {case['case_id']} | {row['mean_iou']:.3f} | {row['bad_masks']}/74 | {row['accepted_by_worker']}/74 | {row['false_accepted_bad_masks']} | {case['fully_hidden_truth_nonseed']['samples']} | {case['elapsed_processing_seconds']:.1f} |"
        )
    lines += [
        "",
        "IoU is intersection divided by union of predicted and reference target pixels. Both masks empty scores 1; only one empty scores 0. A bad mask is IoU < 0.5. Worker accepted means the existing rules labeled the sample `visible`. Center and extent errors are undefined when either mask is empty; the JSON and CSV preserve those missing values.",
        "",
        "Mask overlap and framing usefulness are different. A missing interior label can lower IoU while preserving the outer box. The per-frame data therefore also records center and extent errors; the IoU threshold alone is not a usability judgment.",
        "",
        "## Visibility and abstention",
        "",
    ]
    for key, label in (
        ("visible_truth_nonseed", "Truth-visible"),
        ("fully_hidden_truth_nonseed", "Fully hidden truth"),
    ):
        row = report[key]
        lines.append(
            f"- {label}: {row['samples']} frames; mean IoU {row['mean_iou']:.3f}; {row['bad_masks']} bad masks; {row['accepted_by_worker']} worker-accepted frames; {row['false_accepted_bad_masks']} accepted bad masks; {row['uncertain']} uncertain and {row['missing']} missing predictions."
        )
    lines += [
        "",
        "The declared expected-visible interval covers the full clip. Fully hidden frames deliberately test disappearance and recovery; the scorer knows they have empty masks, while the worker does not receive those later labels. This is separate from an authored reveal that intentionally excludes an initial interval from review.",
        "",
        "## Selected frames",
        "",
        "![Worker inputs, independently rendered visible masks, and SAM masks for one explicitly selected diagnostic frame per clip.](selected-frames.png)",
        "",
        "Selection is deterministic: the lowest-IoU worker-accepted bad frame in each clip, or the lowest-IoU non-seed frame if there is no accepted bad mask. These pictures illustrate errors; the table includes every non-seed frame.",
        "",
        "| Case | Selected frame | Seconds | IoU | Worker status |",
        "|---|---:|---:|---:|---|",
    ]
    for row in selections:
        lines.append(
            f"| {row['case_id']} | {row['frame_index']} | {row['timestamp']:.2f} | {row['iou']:.3f} | {row['worker_visibility']} |"
        )
    lines += [
        "",
        "## Scope and reproduction",
        "",
        "The textured and textureless translation cases share exactly the same truth masks and trajectory. Other cases stress scale, leaving the image, foreground occlusion, and a similar-object crossing. They share one product silhouette and should not be treated as a representative product benchmark.",
        "",
        "Only the exact renderer-derived first-frame box reaches SAM. This ideal prompt does not test creator annotation error. The worker's existing `describe_mask` function is observed to retain binary masks; its arguments, result and predictor state are unchanged. All later labels are reserved for grading. Every worker source file, model manifest, fixture, protocol and benchmark script is hashed before inference.",
        "",
        "This set is now development data. Tune uncertainty rules against it only with that label; evaluate any change on newly frozen cases and independently annotated real footage before reporting transfer. No runtime thresholds or model parameters were changed for this run.",
        "",
        "See [the contract](../research-contract.json), [frozen manifest](frozen-manifest.json), [full summary](summary.json), and [all frame metrics](frame-metrics.csv). Processing time excludes one-time model loading. MPS uses CPU fallback for unsupported operations; CUDA was not tested.",
        "",
    ]
    (destination / "report.md").write_text("\n".join(lines))
    provenance = {
        "question": "Which masks were accepted despite poor independent overlap?",
        "audience": "FlowBlock implementation reviewers",
        "selection": "Per clip worst IoU among worker-accepted bad nonseed masks, otherwise worst nonseed IoU",
        "source_summary_sha256": digest(attempt / "summary.json"),
        "frozen_manifest_sha256": digest(inputs / "frozen-manifest.json"),
        "generator_sha256": digest(Path(__file__)),
        "selected_frames": selections,
        "privacy": "Authored synthetic imagery only; no customer data or credentials",
        "limitations": report["limitations"],
    }
    (destination / "figure-provenance.json").write_text(
        json.dumps(provenance, indent=2) + "\n"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", type=Path, required=True)
    parser.add_argument("--attempt", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    build(args.inputs.resolve(), args.attempt.resolve(), args.output.resolve())
