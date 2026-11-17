"""Publish recorded SFT telemetry to W&B Models without starting model work.

The default is a local dry run. Historical receipts remain unchanged. A separate,
deterministic run records the import time and references the original artifacts.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
VERSION = "flowblock-models-publication-v1"
METRICS = (
    "loss", "learning_rate", "grad_norm", "num_trajectories", "num_tokens",
    "num_trainable_tokens", "num_dropped_trajectories", "tokens_per_second",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_evidence(root: Path = ROOT) -> dict[str, Any]:
    paths = {
        "receipt": root / "training/results/training-receipt.json",
        "readback": root / "training/results/training-readback.json",
        "manifest": root / "training/frozen/manifest.json",
        "dataset": root / "training/frozen/train.jsonl",
    }
    receipt, readback, manifest = [json.loads(paths[key].read_text()) for key in ("receipt", "readback", "manifest")]
    hashes = {key: sha256(path) for key, path in paths.items()}
    if hashes["readback"] != receipt["readbackSha256"]:
        raise ValueError("Training readback differs from its verified receipt.")
    if hashes["manifest"] != receipt["manifestSha256"]:
        raise ValueError("Dataset manifest differs from the training receipt.")
    if hashes["dataset"] != receipt["datasetSha256"] or hashes["dataset"] != manifest["files"]["train.jsonl"]:
        raise ValueError("Training dataset differs from the frozen experiment.")
    if receipt["status"] != "trained" or not readback["completed"]:
        raise ValueError("A verified completed training attempt is required.")
    if not any(event["type"] == "training_ended" for event in readback["events"]):
        raise ValueError("Training completion event is missing.")
    if any(receipt[key] != readback[key] for key in ("trainingJobId", "modelId")):
        raise ValueError("Training receipt and readback identify different jobs.")
    checkpoints = [item for item in readback["checkpoints"] if item["step"] == receipt["trainedStep"] and item["step"] > 0]
    if len(checkpoints) != 1:
        raise ValueError("Expected one verified positive checkpoint.")
    checkpoint = checkpoints[0]
    if checkpoint["artifact_name"] != receipt["attempt"]:
        raise ValueError("Checkpoint belongs to a different model artifact.")
    history = []
    for event in readback["events"]:
        if event["type"] != "gradient_step":
            continue
        data = event["data"]
        if data["gradient_step"] != len(history) + 1:
            raise ValueError("Optimizer steps must be unique, contiguous, and ordered.")
        metrics = {f"train/{key}": data[key] for key in METRICS}
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in metrics.values()):
            raise ValueError("Training metrics must be finite numbers.")
        history.append({"optimizer_step": data["gradient_step"], **metrics})
    if not history or len(history) != readback["gradientUpdates"]:
        raise ValueError("Gradient history count does not match the readback.")
    if history[0]["train/loss"] != readback["firstLoss"] or history[-1]["train/loss"] != readback["lastLoss"]:
        raise ValueError("Loss endpoints do not match the readback.")
    if sum(row["train/num_tokens"] for row in history) != readback["totalReportedTokens"]:
        raise ValueError("Processed token total does not match the readback.")
    if sum(row["train/num_trainable_tokens"] for row in history) != readback["totalLossBearingTokens"]:
        raise ValueError("Loss-bearing token total does not match the readback.")
    digest = hashlib.sha256(json.dumps({"version": VERSION, "hashes": hashes}, sort_keys=True).encode()).hexdigest()
    return {
        "version": VERSION, "evidenceSha256": digest,
        "runId": f"sft-telemetry-{digest[:20]}", "sourceHashes": hashes,
        "originalRunId": receipt["runId"], "originalRunUrl": receipt["runUrl"],
        "trainingJobId": receipt["trainingJobId"], "modelId": receipt["modelId"],
        "baseModel": receipt["baseModel"], "checkpointId": checkpoint["id"],
        "checkpointStep": checkpoint["step"],
        "checkpointArtifactVersion": f"v{checkpoint['version']}",
        "datasetArtifact": receipt["trainingDataArtifact"].removeprefix("wandb-artifact:///"),
        "datasetPublication": "Recovered frozen dataset output; original artifact URI was not resolvable during audit. No historical input lineage is inferred.",
        "checkpointArtifact": receipt["inferenceModel"].removeprefix("wandb-artifact:///"),
        "trainingStartedAt": receipt["startedAt"], "recordedAt": readback["readAt"],
        "trainingRows": receipt["rows"], "epochs": receipt["epochs"],
        "batchSize": receipt["batchSize"], "peakLearningRate": receipt["peakLearningRate"],
        "assistantTurns": receipt["assistantTurns"], "history": history,
        "summary": {
            "training/optimizer_updates": len(history),
            "training/processed_tokens": readback["totalReportedTokens"],
            "training/loss_bearing_tokens": readback["totalLossBearingTokens"],
            "training/first_loss": readback["firstLoss"],
            "training/last_loss": readback["lastLoss"],
            "training/checkpoint_step": checkpoint["step"],
            "publication/recorded_telemetry": True,
        },
    }


def verify_run(run: Any, evidence: dict[str, Any]) -> dict[str, Any]:
    if run.config.get("evidenceSha256") != evidence["evidenceSha256"]:
        raise ValueError("Remote run evidence hash does not match.")
    expected = evidence["history"]
    actual = list(run.scan_history(keys=list(expected[0]), page_size=100))
    if len(actual) != len(expected):
        raise ValueError(f"Remote history contains {len(actual)} rows; expected {len(expected)}.")
    for wanted, observed in zip(expected, actual, strict=True):
        for key, value in wanted.items():
            if key not in observed or not math.isclose(observed[key], value, rel_tol=1e-12, abs_tol=1e-12):
                raise ValueError(f"Remote metric differs at optimizer step {wanted['optimizer_step']}: {key}.")
    for key, value in evidence["summary"].items():
        if run.summary.get(key) != value:
            raise ValueError(f"Remote summary differs: {key}.")
    used = [{"name": artifact.name, "id": artifact.id, "digest": artifact.digest} for artifact in run.used_artifacts()]
    outputs = list(run.logged_artifacts())
    logged = [{"name": artifact.name, "id": artifact.id, "digest": artifact.digest} for artifact in outputs]
    expected_ids = run.config.get("inputArtifactIds", {})
    if set(expected_ids) != {"checkpointArtifact"} or not set(expected_ids.values()).issubset({item["id"] for item in used}):
        raise ValueError("Remote checkpoint artifact lineage is missing.")
    if not any(item["name"].startswith(f"{evidence['runId']}-evidence:") for item in logged):
        raise ValueError("Remote recorded-evidence artifact is missing.")
    datasets = [item for item in outputs if item.name.startswith(f"{evidence['runId']}-dataset:")]
    if len(datasets) != 1 or datasets[0].metadata.get("datasetSha256") != evidence["sourceHashes"]["dataset"]:
        raise ValueError("Remote recovered-dataset artifact is missing.")
    if run.state != "finished":
        raise ValueError(f"Remote publication run is {run.state}, not finished.")
    return {"verifiedAt": now(), "rows": len(actual), "usedArtifacts": used, "loggedArtifacts": logged, "state": run.state}


def publish(evidence: dict[str, Any], directory: Path, *, verify_only: bool = False) -> dict[str, Any]:
    import wandb

    entity = os.environ["WANDB_ENTITY"]
    project = os.environ.get("WANDB_PROJECT", "flowblock")
    path = f"{entity}/{project}/{evidence['runId']}"
    if any(not evidence[key].startswith(f"{entity}/{project}/") for key in ("datasetArtifact", "checkpointArtifact")):
        raise ValueError("Publication must use the original training project.")
    api = wandb.Api(timeout=30)
    directory.mkdir(parents=True, exist_ok=True)
    receipt_path = directory / f"{evidence['runId']}.json"
    receipt = {
        "version": VERSION, "runId": evidence["runId"], "evidenceSha256": evidence["evidenceSha256"],
        "runUrl": f"https://forge.coreweave.com/wandb/{entity}/{project}/runs/{evidence['runId']}",
        "originalRunUrl": evidence["originalRunUrl"], "status": "preflight", "importedAt": now(),
    }
    if verify_only or receipt_path.exists():
        existing = json.loads(receipt_path.read_text()) if receipt_path.exists() else receipt
        result = verify_run(api.run(path), evidence)
        receipt = {**existing, "status": "verified", "readback": result}
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        return receipt
    # Querying project runs distinguishes absence from an authentication or transport failure.
    existing = list(api.runs(f"{entity}/{project}", filters={"name": evidence["runId"]}, per_page=1))
    if existing:
        receipt.update(status="verified", readback=verify_run(existing[0], evidence))
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        return receipt
    inputs = {"checkpointArtifact": api.artifact(evidence["checkpointArtifact"])}
    checkpoint = inputs["checkpointArtifact"]
    if checkpoint.type != "lora" or checkpoint.version != evidence["checkpointArtifactVersion"]:
        raise ValueError("Remote checkpoint alias no longer resolves to the recorded LoRA version.")
    config = {key: value for key, value in evidence.items() if key not in ("history", "summary")}
    config.update(importedAt=receipt["importedAt"], inputArtifactIds={key: artifact.id for key, artifact in inputs.items()})
    receipt.update(status="publishing")
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    packet_path = directory / f"{evidence['runId']}-evidence.json"
    packet_path.write_text(json.dumps({**evidence, "importedAt": receipt["importedAt"]}, indent=2) + "\n")
    try:
        with wandb.init(
            entity=entity, project=project, id=evidence["runId"], resume="never",
            name="Recorded SFT telemetry · planner v1", job_type="recorded-training-telemetry",
            group=evidence["originalRunId"], tags=["flowblock", "recorded-evidence", "telemetry-recovery"],
            notes="Imported from verified historical job events. No training or inference executed by this run. Loss is an optimization metric, not planning quality.",
            config=config, dir=str(directory),
            settings=wandb.Settings(disable_code=True, disable_git=True, disable_job_creation=True,
                                    x_disable_stats=True, x_disable_machine_info=True, init_timeout=45),
        ) as run:
            for artifact in inputs.values():
                run.use_artifact(artifact)
            dataset = wandb.Artifact(f"{evidence['runId']}-dataset", type="recovered-training-data",
                                    metadata={"datasetSha256": evidence["sourceHashes"]["dataset"],
                                              "originalRecordedArtifact": evidence["datasetArtifact"],
                                              "provenance": evidence["datasetPublication"]})
            dataset.add_file(str(ROOT / "training/frozen/train.jsonl"), name="train.jsonl")
            dataset.add_file(str(ROOT / "training/frozen/manifest.json"), name="manifest.json")
            run.log_artifact(dataset).wait()
            run.define_metric("optimizer_step")
            run.define_metric("train/*", step_metric="optimizer_step")
            for row in evidence["history"]:
                run.log(row)
            run.summary.update(evidence["summary"])
            artifact = wandb.Artifact(f"{evidence['runId']}-evidence", type="training-telemetry",
                                     metadata={"evidenceSha256": evidence["evidenceSha256"], "recordedAt": evidence["recordedAt"], "importedAt": receipt["importedAt"]})
            artifact.add_file(str(packet_path), name="recorded-evidence.json")
            run.log_artifact(artifact).wait()
        api.flush()
        receipt.update(status="verified", readback=verify_run(api.run(path), evidence))
    except Exception as error:
        receipt.update(status="publication-outcome-unknown", errorType=type(error).__name__)
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        raise
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--publish", action="store_true", help="Upload existing recorded evidence to the original private project.")
    action.add_argument("--verify", action="store_true", help="Read back the deterministic publication run without remote writes.")
    args = parser.parse_args()
    evidence = load_evidence()
    if not args.publish and not args.verify:
        print(json.dumps({"mode": "dry-run", **evidence}, indent=2))
        return
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env.local", override=False)
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    os.environ.setdefault("WANDB_SILENT", "true")
    # Forge's current Models API host; leave an explicitly configured deployment intact.
    os.environ.setdefault("WANDB_BASE_URL", "https://api.forge.coreweave.com")
    if not os.environ.get("WANDB_API_KEY") or not os.environ.get("WANDB_ENTITY"):
        raise SystemExit("WANDB_API_KEY and WANDB_ENTITY are required for publication/readback.")
    try:
        result = publish(evidence, ROOT / "training/artifacts/models-publication", verify_only=args.verify)
    except Exception as error:
        # SDK exceptions can contain signed storage URLs. Keep them out of CLI output.
        raise SystemExit(f"Models publication/readback failed: {type(error).__name__}. Inspect the local publication receipt before any retry.") from None
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
