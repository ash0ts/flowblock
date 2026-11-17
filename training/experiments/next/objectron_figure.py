"""Render the completed Objectron diagnostic without publishing source media.

Run with: uv --no-config run --with matplotlib==3.10.7 python \
  training/experiments/next/objectron_figure.py
"""

from __future__ import annotations

import csv
import hashlib
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter


ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "training/experiments/next/results/objectron-diagnostic.json"
OUTPUT = SOURCE.parent / "figures"
METRIC = "maskCentroidToProjected3dCenterFrameDiagonalDiscrepancy"


def main() -> None:
    evidence = json.loads(SOURCE.read_text())
    rows = [row for row in evidence["rows"] if row["status"] == "completed"]
    excluded = [row for row in evidence["rows"] if row["status"] == "excluded"]
    rows.sort(key=lambda row: row[METRIC])
    assert len(rows) == evidence["metrics"]["execution/completed_sequences"]
    assert sum(row["evaluationSamplesExcludingSeed"] for row in rows) == 592
    assert (
        abs(
            sum(row[METRIC] for row in rows) / len(rows)
            - evidence["metrics"][
                "projection_proxy/mean_sequence_mask_centroid_to_projected_3d_center_frame_diagonal_discrepancy"
            ]
        )
        < 1e-12
    )
    OUTPUT.mkdir(parents=True, exist_ok=True)

    fields = [
        "sequenceId",
        "status",
        METRIC,
        "usableSamples",
        "evaluationSamplesExcludingSeed",
        "usableFraction",
        "processingSeconds",
        "note",
        "reason",
    ]
    with (OUTPUT / "objectron-diagnostic.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows([*rows, *excluded])

    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 11,
            "svg.fonttype": "none",
            "axes.unicode_minus": False,
        }
    )
    ink, muted, blue, grid = "#182630", "#53616a", "#176f91", "#dce3e7"
    fig = plt.figure(figsize=(12, 9), facecolor="white")
    fig.text(
        0.06,
        0.947,
        "The heuristics accepted every track.\nInspection still found apparent mask errors.",
        color=ink,
        fontsize=21,
        weight="bold",
        va="top",
        linespacing=1.2,
    )
    fig.text(
        0.06,
        0.856,
        "Objectron development diagnostic · 8 five-second clips · SAM 2.1 Small on local MPS",
        color=muted,
        fontsize=11,
    )

    ax = fig.add_axes((0.255, 0.385, 0.47, 0.405))
    ax.set_axisbelow(True)
    ax.xaxis.grid(True, color=grid, linewidth=0.8)
    y = list(range(len(rows)))
    values = [row[METRIC] for row in rows]
    ax.hlines(y, 0, values, color="#bdd4de", linewidth=2)
    ax.scatter(values, y, color=blue, s=56, zorder=3)
    ax.set_yticks(y, [row["sequenceId"] for row in rows], color=ink)
    ax.tick_params(axis="y", length=0, pad=12)
    ax.tick_params(axis="x", colors=muted, length=0, pad=9)
    ax.set_xlim(0, 0.116)
    ax.set_xticks([0, 0.02, 0.04, 0.06, 0.08, 0.10])
    ax.xaxis.set_major_formatter(PercentFormatter(1, decimals=0))
    ax.set_ylim(len(rows) - 0.5, -0.5)
    for spine in ax.spines.values():
        spine.set_visible(False)
    for i, row in enumerate(rows):
        ax.text(
            row[METRIC] + 0.003,
            i,
            f"{100 * row[METRIC]:.2f}%",
            color=ink,
            fontsize=10,
            va="center",
        )
    ax.set_xlabel(
        "Mask-centroid / projected 3D-center discrepancy\nMean distance as a share of the frame diagonal",
        color=ink,
        labelpad=13,
        fontsize=11,
    )

    coverage = fig.add_axes((0.79, 0.385, 0.16, 0.405), sharey=ax)
    coverage.set_xlim(0, 1)
    coverage.axis("off")
    for i, row in enumerate(rows):
        coverage.text(
            0.5,
            i,
            f"{row['usableSamples']} / {row['evaluationSamplesExcludingSeed']}",
            ha="center",
            va="center",
            color=ink,
            fontsize=12,
        )
    fig.text(0.06, 0.805, "Original sequence", color=muted, fontsize=10, weight="bold")
    fig.text(
        0.255,
        0.805,
        "Projection proxy — not mask accuracy",
        color=ink,
        fontsize=11,
        weight="bold",
    )
    fig.text(
        0.87,
        0.805,
        "Heuristic-usable",
        color=ink,
        fontsize=10,
        weight="bold",
        ha="center",
    )
    fig.text(
        0.87, 0.786, "samples / non-seed samples", color=muted, fontsize=8, ha="center"
    )

    fig.text(
        0.06, 0.275, "Assistant inspection notes", fontsize=13, weight="bold", color=ink
    )
    fig.text(
        0.06,
        0.252,
        "Midpoint/end overlays were inspected after execution. These notes are not independent ground truth.",
        fontsize=10,
        color=muted,
    )
    examples = [
        ("camera/batch-7/24 · 2.47 s", "Mask extends onto a\nneighboring price card."),
        ("cup/batch-37/28 · 4.93 s", "Mask omits the visible\nwhite cup interior."),
        (
            "laptop/batch-37/20 · 4.93 s",
            "Boundary extends toward\nadjacent cables / table.",
        ),
    ]
    for x, (title, note) in zip((0.06, 0.37, 0.68), examples):
        fig.text(x, 0.215, title, fontsize=10, weight="bold", color=ink)
        fig.text(x, 0.191, note, fontsize=11, color=ink, va="top", linespacing=1.4)
    fig.text(
        0.06,
        0.107,
        "10 sequences selected; 2 excluded before execution: one clip under 5 s, one annotation unavailable.\n592 samples are temporally dependent. 100% heuristic usability does not establish accurate masks or usable takes.",
        color=muted,
        fontsize=9,
        va="top",
        linespacing=1.4,
    )
    fig.text(
        0.06,
        0.048,
        "Source: Google Objectron, C-UDA-1.0 · flowblock-objectron-projection-diagnostic-v1 · 29 Oct 2026",
        color=muted,
        fontsize=8,
    )

    for suffix in ("png", "svg", "pdf"):
        fig.savefig(
            OUTPUT / f"objectron-diagnostic.{suffix}", dpi=180, facecolor="white"
        )
    plt.close(fig)

    ledger = {
        "question": "Do heuristic-usable tracks establish reliable product masks?",
        "boundedTakeaway": "All samples passed the worker heuristics; assistant inspection found apparent mask errors. Projection discrepancy is not visible-silhouette accuracy.",
        "source": SOURCE.relative_to(ROOT).as_posix(),
        "sourceSha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "experimentId": evidence["experimentId"],
        "datasetManifestSha256": evidence["datasetManifestSha256"],
        "renderer": f"matplotlib {matplotlib.__version__}",
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "metric": {
            "field": METRIC,
            "sourceLocator": "rows[status=completed]",
            "unit": "frame diagonal; multiplied by 100 for display",
            "aggregation": "per-sequence arithmetic mean over heuristic-usable non-seed samples",
            "missingness": "excluded sequences remain in CSV; no zero imputation",
            "displayRounding": "two decimal places as percent",
        },
        "coverage": {
            "numerator": "usableSamples",
            "denominator": "evaluationSamplesExcludingSeed",
            "meaning": "passes worker uncertainty heuristics, not an accuracy or usable-take judgment",
        },
        "inspection": {
            "sourceLocator": "rows[].note",
            "reviewer": "assistant qualitative inspection",
            "independentGroundTruth": False,
            "affectsScores": False,
        },
        "privacy": "Metadata only; no footage, frames, pixel annotations or signed URLs included.",
        "license": {
            "dataset": "Objectron",
            "id": "C-UDA-1.0",
            "url": "https://github.com/google-research-datasets/Objectron/blob/master/LICENSE",
        },
        "limitations": evidence["metadata"]["limitations"],
    }
    (OUTPUT / "objectron-diagnostic.provenance.json").write_text(
        json.dumps(ledger, indent=2) + "\n"
    )
    table = "\n".join(
        f"| {row['sequenceId']} | {100 * row[METRIC]:.4f}% | {row['usableSamples']} / {row['evaluationSamplesExcludingSeed']} | {row['processingSeconds']:.2f} |"
        for row in rows
    )
    exclusions = "\n".join(
        f"- `{row['sequenceId']}`: {row['reason']}." for row in excluded
    )
    notes = "\n".join(
        f"- `{row['sequenceId']}`: {row['note']}" for row in rows if row.get("note")
    )
    (OUTPUT / "README.md").write_text(
        "# Objectron diagnostic figure\n\n"
        "Every evaluated sample passed the worker's uncertainty heuristics. Assistant inspection nevertheless found apparent mask errors in three sampled views. The figure compares eight source videos; it does not establish tracking accuracy or creator benefit.\n\n"
        "![Eight per-video projection discrepancies range from 0.96% to 9.71% of the frame diagonal. Each clip has 74 of 74 non-seed samples accepted by the heuristics. Assistant notes describe camera-mask leakage, omitted cup interior, and laptop-mask extension.](objectron-diagnostic.png)\n\n"
        "Exports: [SVG](objectron-diagnostic.svg), [PDF](objectron-diagnostic.pdf), [CSV](objectron-diagnostic.csv), [source ledger](objectron-diagnostic.provenance.json).\n\n"
        "The proxy is the mean Euclidean distance between the mask centroid and the projected 3D-box center, divided by the image diagonal. These are different label definitions even under perfect segmentation. Means use heuristic-usable samples after the first-frame prompt; seed frames are excluded. Percentage values below are rounded for display. The CSV retains full precision.\n\n"
        "| Original sequence | Projection discrepancy | Heuristic-usable / evaluated | Processing seconds |\n"
        "| --- | ---: | ---: | ---: |\n"
        + table
        + "\n\nSamples within a video are dependent. Processing includes decoding, tracking, measurements and evidence writes, excluding model construction and queueing. No remote GPU execution is implied.\n\n"
        "Excluded before execution:\n\n"
        + exclusions
        + "\n\nAssistant inspection notes, preserved from the recorded results:\n\n"
        + notes
        + "\n\nSource: [Google Objectron](https://github.com/google-research-datasets/Objectron), [C-UDA-1.0](https://github.com/google-research-datasets/Objectron/blob/master/LICENSE). No footage, frames or pixel annotations are included in these exports. The cohort remains development data.\n\n"
        "Reproduce from the repository root:\n\n```sh\nuv --no-config run --with matplotlib==3.10.7 python training/experiments/next/objectron_figure.py\n```\n"
    )


if __name__ == "__main__":
    main()
