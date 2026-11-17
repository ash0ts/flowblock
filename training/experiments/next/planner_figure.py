"""Render recorded planner summaries without regrading or selecting attempts.

Requires matplotlib==3.10.7. Supply explicit attempt IDs in display order.
The report and its existing comparisons are the only measurement inputs.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import PercentFormatter


LABELS = {
    "library": "Deterministic library\nStructured-brief search",
    "llama-base": "Llama 3.1 8B base\nBounded JSON planner",
    "llama-sft": "Llama 3.1 8B trained\nBounded JSON planner",
    "gpt-oss": "GPT-OSS 20B\nProduct coordinator",
}
ROOT = Path(__file__).resolve().parents[3]


def ratio_text(value: dict) -> str:
    return f"{value['numerator']} / {value['denominator']}"


def load_report(path: Path, attempt_ids: list[str]) -> tuple[dict, list[dict]]:
    report = json.loads(path.read_text())
    if report.get("analysisVersion") != "flowblock-campaign-analysis-v1":
        raise ValueError("Unsupported analyzer report version")
    if len(set(attempt_ids)) != len(attempt_ids) or not 1 <= len(attempt_ids) <= 4:
        raise ValueError("Select one to four distinct attempt IDs explicitly")
    by_id = {row["attemptId"]: row for row in report["campaigns"]}
    rows = [by_id[attempt_id] for attempt_id in attempt_ids]
    scopes = {row["scope"] for row in rows}
    if len(scopes) != 1 or "initial-network-pilot" in scopes:
        raise ValueError("A figure requires one non-pilot cohort")
    if len({row["manifest"]["tasksSha256"] for row in rows}) != 1:
        raise ValueError("Selected systems must share the exact task file")
    for row in rows:
        summary = row["summary"]
        for name in (
            "availability",
            "qualitySuccessAmongAvailable",
            "operationalSuccessAmongScheduled",
        ):
            value = summary[name]
            numerator, denominator = value["numerator"], value["denominator"]
            expected = numerator / denominator if denominator else None
            if not 0 <= numerator <= denominator or value["rate"] != expected:
                raise ValueError(f"Inconsistent {name} for {row['attemptId']}")
    return report, rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--attempt", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report, rows = load_report(args.report, args.attempt)
    args.output.mkdir(parents=True, exist_ok=False)
    source_hash = hashlib.sha256(args.report.read_bytes()).hexdigest()
    selected = set(args.attempt)
    omitted = [row for row in report["campaigns"] if row["attemptId"] not in selected]
    pilots = [row for row in omitted if row["scope"] == "initial-network-pilot"]
    zero_calls = [
        row
        for row in omitted
        if row["scope"] != "initial-network-pilot"
        and row["summary"]["usage"]["providerCalls"] == 0
        and row["summary"]["attempted"] == 0
    ]
    other_omitted = len(omitted) - len(pilots) - len(zero_calls)
    comparisons = [
        pair
        for pair in report["comparisons"]
        if pair["baseAttemptId"] in selected and pair["trainedAttemptId"] in selected
    ]
    matching = [pair for pair in comparisons if pair["compatible"]]

    # Every attempt stays in the accessible table, including unavailable rows.
    table_rows = []
    for row in report["campaigns"]:
        summary = row["summary"]
        quality = summary["qualitySuccessAmongAvailable"]
        table_rows.append(
            {
                "attemptId": row["attemptId"],
                "arm": row["arm"],
                "scope": row["scope"],
                "plotted": row["attemptId"] in selected,
                "scheduledTasks": summary["scheduled"],
                "sceneGroups": summary["sceneGroups"],
                "attemptedTasks": summary["attempted"],
                "availableOutcomes": summary["availability"]["numerator"],
                "productiveOutcomes": quality["numerator"],
                "qualityDenominator": quality["denominator"],
                "qualityRate": quality["rate"],
                "operationalRate": summary["operationalSuccessAmongScheduled"]["rate"],
                "geometryInvalidPlans": summary["admissions"]["invalidPlans"],
                "creditedPlans": summary["admissions"]["creditedPlans"],
                "falseAbstentions": summary["empty"]["falseAbstention"],
                "providerCalls": summary["usage"]["providerCalls"],
            }
        )
    with (args.output / "planner-comparison.csv").open("w", newline="") as handle:
        writer = csv.DictWriter(handle, list(table_rows[0]))
        writer.writeheader()
        writer.writerows(table_rows)

    plt.rcParams.update(
        {"font.family": "DejaVu Sans", "font.size": 11, "svg.fonttype": "none"}
    )
    ink, muted, blue, grid = "#182630", "#53616a", "#176f91", "#dce3e7"
    fig = plt.figure(figsize=(12, 7.2 + max(0, len(rows) - 2) * 0.45))
    fig.text(
        0.06,
        0.94,
        "Feasible plans that preserve the brief",
        fontsize=23,
        weight="bold",
        color=ink,
    )
    scope = rows[0]["scope"]
    summary = rows[0]["summary"]
    fig.text(
        0.06,
        0.89,
        f"{scope.title()} · {summary['scheduled']} authored tasks in "
        f"{summary['sceneGroups']} scene groups · descriptive system comparison",
        fontsize=11,
        color=muted,
    )
    ax = fig.add_axes((0.26, 0.45, 0.40, 0.33))
    ax.set_axisbelow(True)
    ax.xaxis.grid(color=grid, linewidth=0.8)
    ax.set_xlim(0, 1)
    ax.set_ylim(len(rows) - 0.5, -0.5)
    ax.set_xticks([0, 0.25, 0.5, 0.75, 1])
    ax.xaxis.set_major_formatter(PercentFormatter(1, decimals=0))
    ax.set_yticks(
        range(len(rows)), [LABELS.get(row["arm"], row["arm"]) for row in rows]
    )
    ax.tick_params(axis="y", length=0, pad=15, colors=ink)
    ax.tick_params(axis="x", length=0, pad=9, colors=muted)
    for spine in ax.spines.values():
        spine.set_visible(False)
    for index, row in enumerate(rows):
        quality = row["summary"]["qualitySuccessAmongAvailable"]
        if quality["rate"] is None:
            ax.text(
                0.02, index, "Unavailable; no quality score", color=muted, va="center"
            )
            continue
        ax.hlines(index, 0, quality["rate"], color="#bdd4de", linewidth=3)
        marker = "s" if row["arm"] == "library" else "o"
        ax.scatter(quality["rate"], index, s=75, marker=marker, color=blue, zorder=3)
        ax.annotate(
            f"{100 * quality['rate']:.1f}%",
            (quality["rate"], index),
            xytext=(0, 15),
            textcoords="offset points",
            ha="center",
            fontsize=11,
            color=ink,
        )
    ax.set_xlabel(
        "Productive plans / available graded outcomes", labelpad=13, color=ink
    )
    columns = [
        (0.705, "Productive", "qualitySuccessAmongAvailable"),
        (0.815, "Available", "availability"),
        (0.925, "Invalid", "invalid"),
    ]
    for x, title, key in columns:
        fig.text(x, 0.813, title, ha="center", fontsize=10, weight="bold", color=ink)
        column = fig.add_axes((x - 0.05, 0.45, 0.10, 0.33), sharey=ax)
        column.set_xlim(0, 1)
        column.axis("off")
        for index, row in enumerate(rows):
            current = row["summary"]
            unavailable = current["availability"]["numerator"] == 0
            if key == "invalid":
                value = (
                    "Unmeasured"
                    if unavailable
                    else f"{current['admissions']['invalidPlans']} / {current['admissions']['creditedPlans']}"
                )
            elif key == "qualitySuccessAmongAvailable" and unavailable:
                value = "Unavailable"
            else:
                value = ratio_text(current[key])
            column.text(
                0.5, index, value, ha="center", va="center", color=ink, fontsize=11
            )
            if current["availability"]["numerator"] < current["scheduled"]:
                note = (
                    f"{current['attempted']} attempted"
                    if key == "availability"
                    else f"{current['qualitySuccessAmongAvailable']['numerator']}/{current['scheduled']} scheduled"
                    if key == "qualitySuccessAmongAvailable"
                    else ""
                )
                column.annotate(
                    note,
                    (0.5, index),
                    xytext=(0, -18),
                    textcoords="offset points",
                    ha="center",
                    fontsize=8,
                    color=muted,
                )
    fig.text(0.815, 0.792, "/ scheduled", ha="center", color=muted, fontsize=8)
    fig.text(0.925, 0.792, "/ admitted plans", ha="center", color=muted, fontsize=8)

    caveats = [
        "A productive result passes the recorded geometry and brief checks; it is not a judged usable take.",
        "Library search receives structured constraints. GPT-OSS uses a different product coordinator.",
        "These authored rooms share topology templates. Tasks within each scene are dependent.",
    ]
    if not matching:
        caveats.append(
            "No matched base / trained comparison is available here; no training-effect estimate or interval is shown."
        )
    else:
        for pair in matching:
            estimate = pair["qualitySuccessAmongPairedAvailable"]
            if estimate["difference"] is None:
                caveats.append(
                    "Matched Llama comparison has no paired available quality outcomes; no effect estimate."
                )
                continue
            interval = estimate["interval95"]
            uncertainty = (
                f"95% scene-group bootstrap interval {100 * interval[0]:.1f} to {100 * interval[1]:.1f} pp"
                if interval
                else "interval unavailable"
            )
            caveats.append(
                f"Matched trained − base: {100 * estimate['difference']:+.1f} percentage points; {uncertainty}. "
                f"{estimate['sceneGroupsWithEligiblePairs']} groups with paired outcomes."
            )
            if (
                pair["missingness"]["pairedAvailable"]
                < pair["missingness"]["pairedScheduled"]
            ):
                caveats.append(
                    f"Paired subset: base {ratio_text(estimate['base'])}, trained {ratio_text(estimate['trained'])}. "
                    "Outages select available tasks; this is not the full-cohort model-quality effect."
                )
    if any(
        row["summary"]["availability"]["numerator"] < row["summary"]["scheduled"]
        for row in rows
    ):
        caveats.append(
            "Unavailable outcomes stay missing. Available counts and attempted counts expose incomplete pipeline coverage."
        )
    caveats.append(
        f"Outside this chart: {len(pilots)} initial pilot, {len(zero_calls)} zero-call transport attempts; "
        + (f"{other_omitted} other cohort attempts. " if other_omitted else "")
        + "All attempts remain in the CSV."
    )
    fig.text(
        0.06,
        0.315,
        "What these measurements establish",
        fontsize=12,
        weight="bold",
        color=ink,
    )
    fig.text(
        0.06,
        0.284,
        "\n".join(caveats),
        fontsize=9.3,
        color=muted,
        va="top",
        linespacing=1.65,
    )
    fig.text(
        0.06,
        0.055,
        f"Recorded analysis: {report['analysisVersion']} · source SHA-256 {source_hash[:16]}…",
        fontsize=8,
        color=muted,
    )
    for suffix in ("png", "svg", "pdf"):
        fig.savefig(
            args.output / f"planner-comparison.{suffix}", dpi=180, facecolor="white"
        )
    plt.close(fig)

    ledger = {
        "question": "Which recorded systems returned geometrically feasible plans that preserve the authored brief?",
        "source": str(args.report.resolve().relative_to(ROOT)),
        "sourceSha256": source_hash,
        "sourceLocator": "campaigns[].summary.qualitySuccessAmongAvailable",
        "selectedAttemptsInDisplayOrder": args.attempt,
        "selection": "Explicit CLI selection; no automatic latest or best-attempt selection",
        "omittedAttemptIds": [row["attemptId"] for row in omitted],
        "attemptSourceReceipts": {
            row["attemptId"]: row["receipts"] for row in report["campaigns"]
        },
        "scope": scope,
        "tasksSha256": rows[0]["manifest"]["tasksSha256"],
        "renderer": f"matplotlib {matplotlib.__version__}",
        "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "qualityMetric": {
            "numerator": "Productive outcomes passing recorded geometry and brief checks",
            "denominator": "Available graded outcomes, including explicit empty outcomes",
            "missingness": "Unavailable outcomes stay missing; no zero-quality imputation",
            "aggregation": "Analyzer-recorded task proportion; one trial per task",
            "rounding": "One decimal place as percentage for display; full precision in CSV",
        },
        "invalidColumn": "Geometry-invalid admitted plans / credited plans; plan units, not task units",
        "uncertainty": "No per-arm intervals invented; compatible paired comparisons are copied verbatim from analyzer",
        "comparisons": comparisons,
        "limitations": report["limitations"],
        "privacy": "Metadata only; no prompts, credentials, footage or signed URLs",
    }
    (args.output / "planner-comparison.provenance.json").write_text(
        json.dumps(ledger, indent=2) + "\n"
    )
    lines = [
        "# Recorded planner system comparison",
        "",
        "The plot shows explicit selected attempts from one analyzer report. It does not regrade outputs or select favorable attempts.",
        "",
        "| Attempt | Arm | Scope | Plotted | Productive / available | Available / scheduled | Invalid / admitted plans | Provider calls |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
    ]
    lines.extend(
        f"| {row['attemptId']} | {row['arm']} | {row['scope']} | {row['plotted']} | "
        f"{row['productiveOutcomes']} / {row['qualityDenominator']} | "
        f"{row['availableOutcomes']} / {row['scheduledTasks']} | "
        f"{row['geometryInvalidPlans']} / {row['creditedPlans']} | {row['providerCalls']} |"
        for row in table_rows
    )
    lines.extend(
        [
            "",
            *caveats,
            "",
            "Unavailable 0/0 quality cells have no score. An empty return is not necessarily a correct infeasibility explanation.",
            "",
        ]
    )
    for pair in comparisons:
        lines.append(
            f"Base / trained pair: `{pair['baseAttemptId']}` / `{pair['trainedAttemptId']}`."
        )
        if not pair["compatible"]:
            lines.append(
                f"Incompatible; no training-effect estimate: {json.dumps(pair['mismatches'])}."
            )
            continue
        for key in (
            "operationalSuccessAmongPairedScheduled",
            "qualitySuccessAmongPairedAvailable",
            "qualitySuccessAmongPairedAvailableWitnesses",
        ):
            value = pair[key]
            lines.append(f"`{key}`: exact analyzer estimate `{json.dumps(value)}`.")
    lines.extend(
        [
            "",
            "Full precision and every attempt: [CSV](planner-comparison.csv). Source, receipt hashes and limitations: [provenance](planner-comparison.provenance.json).",
            "",
        ]
    )
    (args.output / "README.md").write_text("\n".join(lines))
    print(
        json.dumps(
            {
                "output": str(args.output),
                "sourceSha256": source_hash,
                "plottedAttempts": len(rows),
                "allAttempts": len(table_rows),
            }
        )
    )


if __name__ == "__main__":
    main()
