"""Prepare private Weave evaluation metadata from completed, immutable receipts.

This adapter does not call a provider, import the actor runtime, or publish.
Use the existing publish-weave.ts dry run to validate the resulting contracts.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from pathlib import Path
from typing import Any

REPOSITORY = Path(__file__).resolve().parents[3]
ARMS = ("llama-base", "llama-sft")
CONDITIONS = ("original", "paraphrase", "geometry-perturbation", "unsupported")
IDENTITY = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
TERMINATIONS = {
    "finished",
    "action-budget",
    "repair-budget",
    "deadline",
    "provider-error",
    "tool-error",
}
WATCHDOG_STATUSES = {"completed", "failed", "timed_out", "spawn_failed"}
STOP_REASONS = {
    "new-inference-allocation-exhausted",
    "two-consecutive-pairs-unavailable",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def encoded(value: Any) -> bytes:
    return (
        json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
    ).encode()


def read_json(path: Path) -> tuple[Any, str]:
    data = path.read_bytes()
    return json.loads(data), digest(data)


def finite(value: Any) -> float | int | None:
    if value is None:
        return None
    require(type(value) in (int, float) and math.isfinite(value), "Nonfinite metric")
    require(value >= 0, "Negative duration or count")
    return value


def boolean(value: Any) -> bool:
    require(type(value) is bool, "Expected a recorded boolean")
    return value


def enum(value: Any, allowed: set[str] | tuple[str, ...], name: str) -> str:
    require(value in allowed, f"Unknown {name}")
    return value


def safe_identity(value: Any) -> str:
    require(
        isinstance(value, str) and bool(IDENTITY.fullmatch(value)), "Invalid identity"
    )
    return value


def reject_sensitive(value: Any) -> None:
    if isinstance(value, str):
        require(
            not re.search(
                r"Bearer\s|X-Amz-|X-Goog-|[?&](?:token|signature)=|data:[^;]+;base64,",
                value,
                re.I,
            ),
            "Sensitive value in publication metadata",
        )
    elif isinstance(value, list):
        for item in value:
            reject_sensitive(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            require(
                not re.search(
                    r"^(?:wandb[_-]?)?api[_-]?key$|^authorization$|^cookie$|^password$|^(?:access|refresh)[_-]?token$",
                    key,
                    re.I,
                ),
                "Sensitive field in publication metadata",
            )
            reject_sensitive(item)


def result_row(row: dict, condition: str) -> dict:
    """Explicit field selection prevents raw requests and model prose from escaping."""
    available, attempted = boolean(row["available"]), boolean(row["attempted"])
    output = {
        "sourceTaskId": safe_identity(row["taskId"]),
        "sceneGroup": safe_identity(row["sceneGroup"]),
        "trial": row["trial"],
        "condition": enum(condition, CONDITIONS, "condition"),
        "available": available,
        "attempted": attempted,
        "parentMonotonicElapsedMs": finite(row.get("monotonicElapsedMs")),
        "parentWallElapsedMs": finite(row.get("wallElapsedMs")),
    }
    if "watchdogStatus" in row:
        output["watchdogStatus"] = enum(
            row["watchdogStatus"], WATCHDOG_STATUSES, "watchdog status"
        )
    if "stopReason" in row:
        output["stopReason"] = enum(row["stopReason"], STOP_REASONS, "stop reason")
    recorded = row.get("result")
    if recorded:
        output["termination"] = enum(
            recorded["result"]["termination"], TERMINATIONS, "termination"
        )
        output["childMonotonicElapsedMs"] = finite(recorded.get("monotonicElapsedMs"))
        output["eventLoopDelayMaxMs"] = finite(recorded.get("eventLoopDelayMaxMs"))
        output["providerCallsRecorded"] = len(recorded["calls"])
        output["providerCallsCompleted"] = sum(
            c["status"] == "completed" for c in recorded["calls"]
        )
    scores = {"available": available}
    if available:
        require(
            attempted and recorded is not None, "Available outcome without execution"
        )
        require(
            row.get("watchdogStatus") == "completed",
            "Available outcome with failed watchdog",
        )
        require(recorded["available"] is True, "Nested availability disagrees")
        grade = recorded["grade"]
        require(isinstance(grade, dict), "Available outcome without a grade")
        require(
            grade["supportedRequest"] == (condition != "unsupported"),
            "Support status differs from frozen condition",
        )
        plans = recorded["result"]["plans"]
        require(len(plans) == len(grade["planGrades"]), "Plan grade count differs")
        require(
            len(plans) == len(recorded["independentChecks"]),
            "Independent check count differs",
        )
        output["returnedPlanCount"] = len(plans)
        output["compileActions"] = sum(
            isinstance(e.get("action"), dict)
            and e["action"].get("action") == "compile_candidate"
            for e in recorded["result"]["events"]
        )
        output["schemaRejections"] = sum(
            isinstance(e.get("observation"), dict)
            and e["observation"].get("error") == "invalid_action"
            for e in recorded["result"]["events"]
        )
        if condition == "unsupported":
            scores["checked_unsupported_abstention"] = boolean(
                grade["unsupportedAbstention"]
            )
        else:
            scores["productive"] = boolean(grade["productive"])
            scores["false_abstention"] = boolean(grade["falseAbstention"])
        scores["returned_invalid_plan"] = any(
            not boolean(g["checks"]["feasible"]) for g in grade["planGrades"]
        )
        scores["independent_sample_disagreement"] = any(
            not boolean(g["valid"]) for g in recorded["independentChecks"]
        )
        scores["protocol_failure"] = recorded["result"]["termination"] != "finished"
    return {
        "taskId": safe_identity(f"{row['taskId']}-trial{row['trial']}"),
        "output": output,
        "scores": scores,
    }


def counts(rows: list[dict]) -> dict:
    return {
        "scheduled": len(rows),
        "attempted": sum(r["output"]["attempted"] for r in rows),
        "available": sum(r["scores"]["available"] for r in rows),
        "productive": sum(r["scores"].get("productive", False) for r in rows),
        "checkedUnsupportedAbstentions": sum(
            r["scores"].get("checked_unsupported_abstention", False) for r in rows
        ),
    }


def prepare(directory: Path, output: Path) -> dict:
    directory, output = directory.resolve(), output.resolve()
    require(
        output.is_relative_to(REPOSITORY / "training/artifacts"),
        "Payloads must stay in ignored training/artifacts",
    )
    require(not output.exists(), "Refusing to replace a prior publication payload")
    names = (
        "protocol.json",
        "suite.json",
        "runtime.json",
        "execution-claim.json",
        "entries.json",
        "analysis.json",
        "completion.json",
    )
    records, hashes = {}, {}
    for name in names:
        records[name], hashes[name] = read_json(directory / name)
    protocol, suite = records["protocol.json"], records["suite.json"]
    entries, analysis = records["entries.json"], records["analysis.json"]
    require(
        records["execution-claim.json"]["protocolSha256"] == hashes["protocol.json"],
        "Protocol differs from execution claim",
    )
    require(protocol["suiteSha256"] == hashes["suite.json"], "Suite bytes changed")
    archived = {s["path"]: s for s in records["runtime.json"]}
    require(len(archived) == len(records["runtime.json"]), "Duplicate archived sources")
    require(
        set(archived) == set(protocol["sourceHashes"]),
        "Runtime source membership changed",
    )
    for path, expected in protocol["sourceHashes"].items():
        require(bool(SHA256.fullmatch(expected)), "Invalid source digest")
        require(
            archived[path]["sha256"]
            == expected
            == digest(archived[path]["source"].encode()),
            "Archived source hash mismatch",
        )
    checkpoint = protocol["checkpointEvidence"]
    checkpoint_path = (REPOSITORY / checkpoint["path"]).resolve()
    require(
        checkpoint_path.is_relative_to(REPOSITORY / "training/artifacts"),
        "Checkpoint receipt path escapes artifacts",
    )
    require(
        digest(checkpoint_path.read_bytes()) == checkpoint["sha256"],
        "Checkpoint evidence changed",
    )
    require(
        analysis["experimentId"] == protocol["experimentId"],
        "Analysis experiment mismatch",
    )
    require(
        len(entries) == len(protocol["schedule"]) == 192,
        "Expected every scheduled occurrence",
    )
    require(
        records["completion.json"]["scheduled"] == 192,
        "Campaign has no complete schedule receipt",
    )
    require(
        records["completion.json"]["available"]
        == sum(boolean(r["available"]) for r in entries),
        "Completion count mismatch",
    )
    by_id = {r["id"]: r for r in entries}
    require(len(by_id) == 192, "Duplicate occurrence identity")
    tasks = {t["id"]: t for t in suite["tasks"]}
    require(len(tasks) == len(suite["tasks"]) == 48, "Task identity mismatch")
    for planned in protocol["schedule"]:
        row = by_id[planned["id"]]
        require(
            all(
                row[k] == planned[k] for k in ("id", "taskId", "trial", "arm", "model")
            ),
            "Execution differs from frozen schedule",
        )
        require(
            row["arm"] in ARMS and row["trial"] in (0, 1),
            "Unexpected arm or repetition",
        )
        require(
            row["sceneGroup"] == tasks[row["taskId"]]["sceneGroup"],
            "Scene group mismatch",
        )
        require(safe_identity(row["id"]) == row["id"], "Invalid occurrence path")
        entry, _ = read_json(directory / "occurrences" / row["id"] / "entry.json")
        require(entry == row, "Combined and per-occurrence receipts disagree")

    dataset_rows = []
    for task_id, task in sorted(tasks.items()):
        for trial in (0, 1):
            condition = enum(suite["conditions"][task_id], CONDITIONS, "condition")
            dataset_rows.append(
                {
                    "id": safe_identity(f"{task_id}-trial{trial}"),
                    "sourceTaskId": safe_identity(task_id),
                    "sceneGroup": safe_identity(task["sceneGroup"]),
                    "trial": trial,
                    "condition": condition,
                    "topology": enum(
                        task["topology"],
                        ("u-shaped", "trapezoid", "offset-alcove"),
                        "topology",
                    ),
                    "family": enum(
                        task["briefSpec"]["family"],
                        ("hold", "push-in", "pull-out", "lateral", "orbit", "reveal"),
                        "family",
                    ),
                    "direction": enum(
                        task["briefSpec"]["direction"],
                        ("left", "right", "either"),
                        "direction",
                    ),
                    "expectedSupported": condition != "unsupported",
                    "authoredInputSha256": digest(encoded(task["input"])),
                    "provenance": "authored-synthetic; source geometry retained in private local suite",
                }
            )
    task_bytes = encoded(dataset_rows)
    provenance = {
        "schemaVersion": 1,
        "experimentId": protocol["experimentId"],
        "importOnly": True,
        "sourceReceiptSha256": hashes,
        "actorSourceHashes": protocol["sourceHashes"],
        "checkpointEvidenceSha256": checkpoint["sha256"],
        "adapterSha256": digest(Path(__file__).read_bytes()),
        "datasetRepresentation": "96 metadata rows shared across arms; full authored geometry is retained in the hashed local suite",
        "noNewInference": True,
        "budgetLedgerSuccessor": "training/artifacts/controlled-validation-v1/budget.json",
        "budgetLedgerPredecessor": protocol["budget"]["ledgerPredecessor"],
        "budgetLedgerPredecessorSha256": protocol["budget"]["ledgerPredecessorSha256"],
    }
    provenance_bytes = encoded(provenance)
    manifest = {
        "schemaVersion": 1,
        "datasetId": "flowblock-controlled-validation-v1-occurrences",
        "files": [
            {
                "path": name,
                "sha256": digest(data),
                "license": {
                    "id": "LicenseRef-FlowBlock-Authored",
                    "url": "https://github.com/ash0ts/flowblock",
                    "redistributionAllowed": True,
                },
            }
            for name, data in (
                ("tasks.json", task_bytes),
                ("provenance.json", provenance_bytes),
            )
        ],
        "metadata": {
            "scope": "controlled synthetic stress evaluation",
            "groups": 12,
            "tasks": 48,
            "repetitions": 2,
            "privateProjectRequired": True,
        },
    }
    manifest_bytes = encoded(manifest)

    def version(path: str, field: str) -> str:
        match = re.search(
            rf'export const {field} = "([^"]+)"', archived[path]["source"]
        )
        require(match is not None, f"Missing archived {field}")
        return match[1]

    payloads = {}
    for arm in ARMS:
        rows = sorted(
            (
                result_row(r, suite["conditions"][r["taskId"]])
                for r in entries
                if r["arm"] == arm
            ),
            key=lambda row: row["taskId"],
        )
        require(
            len(rows) == 96
            and [r["taskId"] for r in rows] == [t["id"] for t in dataset_rows],
            "Arm does not cover the shared dataset",
        )
        summary = {}
        for label, selected in (
            ("all", rows),
            (
                "positive",
                [r for r in rows if r["output"]["condition"] != "unsupported"],
            ),
            (
                "unsupported",
                [r for r in rows if r["output"]["condition"] == "unsupported"],
            ),
        ):
            summary[label] = counts(selected)
            require(
                all(
                    analysis["byArm"][arm][label][key] == value
                    for key, value in summary[label].items()
                ),
                "Analysis counts do not reconcile",
            )
        summary["importOnly"] = True
        summary["qualityDenominators"] = {
            "productive": "available supported occurrences only",
            "checked_unsupported_abstention": "available explicitly unsupported occurrences only; explanation accuracy is ungraded",
            "available": "all 96 scheduled occurrences; no replacement or retry",
        }
        payloads[f"{arm}-results.json"] = {
            "schemaVersion": 1,
            "experimentId": safe_identity(protocol["experimentId"]),
            "attemptId": safe_identity(f"{protocol['experimentId']}-{arm}-recorded"),
            "datasetManifestSha256": digest(manifest_bytes),
            "tasksSha256": digest(task_bytes),
            "model": {
                "name": f"controlled-validation-{arm}",
                "provider": "coreweave",
                "modelId": protocol["models"][arm],
                "promptSha256": protocol["promptSha256"],
                "runtimeVersion": version(
                    "training/experiments/next/planner.ts", "researchPlannerVersion"
                ),
                "checkerVersion": version(
                    "training/experiments/next/grade.ts", "checkerVersion"
                ),
                "sourceHashes": {
                    **protocol["sourceHashes"],
                    **{f"recorded/{name}": value for name, value in hashes.items()},
                    "recorded/checkpoint-evidence.json": checkpoint["sha256"],
                    "publication/publish_recorded.py": provenance["adapterSha256"],
                },
                "settings": {
                    **{
                        k: protocol["settings"][k]
                        for k in (
                            "actions",
                            "repairs",
                            "coordinatorDeadlineMs",
                            "externalWatchdogMs",
                            "temperature",
                            "maxTokens",
                            "repetitions",
                            "concurrency",
                            "tracing",
                        )
                    },
                    "evaluationImportPerformsInference": False,
                    "checkpointEvidenceAppliesToArm": arm == "llama-sft",
                },
            },
            "rows": rows,
            "summary": summary,
            "metadata": {
                "scope": "development",
                "recordedAt": analysis["recordedAt"],
                "limitations": [
                    "Controlled synthetic stress evaluation of existing models, not natural task prevalence or creator benefit.",
                    "Metadata-only dataset rows identify the full authored inputs through source hashes; raw requests, model prose and footage are not imported.",
                    "Unavailable occurrences have only an availability score; quality scores omit missing outcomes.",
                    "Supported-plan and unsupported-abstention scores use separate denominators. Unsupported explanation accuracy is not graded.",
                    "Repetitions and conditions are dependent within twelve scene groups. Dashboard score means do not replace grouped uncertainty analysis.",
                    "Independent geometry diagnostics sample 201 poses without optics or between-pose clearance guarantees.",
                    "Model calls and agent actions were recorded locally with telemetry disabled equally in both arms. Import durations are not inference latency.",
                ],
            },
        }
    for value in (manifest, dataset_rows, provenance, *payloads.values()):
        reject_sensitive(value)
    # No payload directory exists until every source and aggregate has reconciled.
    output.mkdir(parents=True, exist_ok=False)
    for name, data in {
        "manifest.json": manifest_bytes,
        "tasks.json": task_bytes,
        "provenance.json": provenance_bytes,
        **{name: encoded(value) for name, value in payloads.items()},
    }.items():
        with (output / name).open("xb") as stream:
            stream.write(data)
    return {
        "mode": "prepared-only",
        "published": False,
        "output": str(output),
        "arms": list(ARMS),
        "rowsPerArm": 96,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "directory", type=Path, help="Completed frozen campaign directory"
    )
    parser.add_argument("--output", type=Path, help="New private payload directory")
    args = parser.parse_args()
    print(
        json.dumps(
            prepare(args.directory, args.output or args.directory / "weave-payloads")
        )
    )


if __name__ == "__main__":
    main()
