"""One separately authorized SFT attempt on a verified training-only artifact.

Defaults to local validation. Client timeouts stop monitoring, not the remote job.
Unknown submission outcomes are read back and are never submitted again here.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
from pathlib import Path
import re
from typing import Any

SPEC = importlib.util.spec_from_file_location("next_publication", Path(__file__).with_name("publish.py"))
publication = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publication)
ROOT = publication.ROOT
VERSION = "flowblock-sft-adapter-v2"
SETTINGS = {"baseModel": "meta-llama/Llama-3.1-8B-Instruct", "epochs": 1, "batchSize": 8, "peakLearningRate": 2e-4, "schedule": "cosine", "assistantTurns": "last"}
sha256 = publication.sha256
now = publication.now


def canonical_row(row: dict[str, Any]) -> str:
    if not isinstance(row, dict) or set(row) - {"messages", "tools"}:
        raise ValueError("SFT rows may contain only messages and optional tools.")
    messages = row.get("messages")
    if not isinstance(messages, list) or not messages or not isinstance(messages[0], dict) or not isinstance(messages[-1], dict) or messages[0].get("role") != "system" or messages[-1].get("role") != "assistant":
        raise ValueError("Every SFT row must start with a system message and end in an assistant action.")
    for message in messages:
        if not isinstance(message, dict) or set(message) != {"role", "content"} or message["role"] not in {"system", "user", "assistant"} or not isinstance(message["content"], str):
            raise ValueError("SFT messages must use the frozen text JSON-action protocol.")
    final = json.loads(messages[-1]["content"])
    if not isinstance(final, dict) or final.get("action") not in {"list_recipes", "compile_candidate", "validate_candidate", "finish"}:
        raise ValueError("The last assistant message must be a planner action.")
    return json.dumps({"messages": messages, **({"tools": row["tools"]} if row.get("tools") else {})}, sort_keys=True, separators=(",", ":"), allow_nan=False)


def load_rows(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not 1 <= len(rows) <= 1600:
        raise ValueError("The authorized attempt requires 1 through 1,600 examples.")
    for row in rows:
        canonical_row(row)
    return rows


def load_training(manifest_path: Path, source_path: Path, dataset_receipt_path: Path, protocol_path: Path) -> dict[str, Any]:
    dataset = publication.load_evidence(manifest_path)
    source_path = source_path.resolve()
    files = dataset["manifest"]["files"]
    if any(entry.get("split") != "train" for entry in files):
        raise ValueError("Training artifacts must contain only explicitly train-split files.")
    selected = [entry for entry, resolved in zip(files, dataset["files"], strict=True) if Path(resolved["path"]) == source_path and entry["role"] == "training_actions"]
    if len(selected) != 1:
        raise ValueError("The source JSONL must be a declared training_actions file.")
    rows = load_rows(source_path)
    protocol = publication.strict_object(publication.load_json(protocol_path), {"schemaVersion", "experimentId", "trainManifestSha256", "trainSourceSha256", "sourceHashes", "settings", "budget", "checkpointSelection"}, set(), "Training protocol")
    publication.identifier(protocol["experimentId"], "Experiment ID")
    if protocol["schemaVersion"] != 1 or protocol["settings"] != SETTINGS or protocol["checkpointSelection"] != "final-single-run":
        raise ValueError("Training settings or checkpoint-selection rule differ from the authorized protocol.")
    budget = publication.strict_object(protocol["budget"], {"authorizedUsd", "maxRuns", "maxExamples"}, set(), "Training budget")
    if not publication.finite(budget["authorizedUsd"]) or not 0 < budget["authorizedUsd"] <= 200 or type(budget["maxRuns"]) is not int or budget["maxRuns"] != 1 or type(budget["maxExamples"]) is not int or not len(rows) <= budget["maxExamples"] <= 1600:
        raise ValueError("Budget must authorize one run, at most 1,600 examples, and no more than $200 total.")
    if protocol["trainManifestSha256"] != dataset["manifestSha256"] or protocol["trainSourceSha256"] != sha256(source_path):
        raise ValueError("Training source or manifest differs from the frozen protocol.")
    if not isinstance(protocol["sourceHashes"], dict) or not protocol["sourceHashes"]:
        raise ValueError("The training protocol must freeze executable source hashes.")
    for relative, expected in protocol["sourceHashes"].items():
        path = (ROOT / relative).resolve()
        if Path(relative).is_absolute() or not path.is_relative_to(ROOT) or not re.fullmatch(r"[0-9a-f]{64}", expected) or sha256(path) != expected:
            raise ValueError("Runtime source differs from the frozen protocol.")
    receipt = publication.load_json(dataset_receipt_path)
    if receipt.get("status") != "verified" or receipt.get("manifestSha256") != dataset["manifestSha256"] or not receipt.get("dataset", {}).get("id") or not receipt.get("dataset", {}).get("digest"):
        raise ValueError("A verified dataset publication receipt is required.")
    artifact_ref = receipt.get("datasetArtifact", "")
    if not re.fullmatch(r"[\w-]+/[\w-]+/[\w-]+:v\d+", artifact_ref):
        raise ValueError("Training requires an immutable dataset artifact version, not an alias.")
    return {
        "version": VERSION, "experimentId": protocol["experimentId"], "attempt": f"{protocol['experimentId']}-sft",
        "protocolSha256": sha256(protocol_path), "protocol": protocol, "dataset": dataset,
        "sourcePath": str(source_path), "sourceName": selected[0]["path"], "sourceSha256": sha256(source_path),
        "datasetArtifact": artifact_ref, "datasetArtifactId": receipt["dataset"]["id"], "datasetArtifactDigest": receipt["dataset"]["digest"],
        "datasetReceiptSha256": sha256(dataset_receipt_path), "rowCount": len(rows), "rows": rows,
        "adapterSha256": sha256(Path(__file__)),
    }


def verify_derived_rows(source: list[dict[str, Any]], derived_path: Path) -> dict[str, Any]:
    derived = load_rows(derived_path)
    if Counter(map(canonical_row, source)) != Counter(map(canonical_row, derived)):
        raise ValueError("ART's uploaded trajectories differ from the frozen source examples.")
    return {"sha256": sha256(derived_path), "rows": len(derived), "comparison": "Canonical messages/tools multiset matches; ART may shuffle rows and change JSON serialization."}


def save_receipt(path: Path, value: dict[str, Any]) -> None:
    value["updatedAt"] = now()
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def registration_recovery(evidence: dict[str, Any], path: Path) -> dict[str, Any]:
    prior = publication.load_json(path)
    if prior.get("status") != "stopped-before-training" or prior.get("registrationSubmitted") is not True or prior.get("trainingSubmitted") is not False or prior.get("trainingJobId"):
        raise ValueError("Registration recovery requires proof that no training POST was attempted.")
    expected = {"experimentId": evidence["experimentId"], "attempt": evidence["attempt"], "manifestSha256": evidence["dataset"]["manifestSha256"], "sourceSha256": evidence["sourceSha256"], "datasetArtifact": evidence["datasetArtifact"], "datasetArtifactId": evidence["datasetArtifactId"], "datasetArtifactDigest": evidence["datasetArtifactDigest"], "settings": SETTINGS, "budget": evidence["protocol"]["budget"], "rows": evidence["rowCount"], "trainingBaseUrl": os.environ.get("WANDB_TRAINING_BASE_URL", "https://forge.coreweave.com/api/training/v1")}
    if any(prior.get(key) != value for key, value in expected.items()):
        raise ValueError("Recovery must preserve model identity, training bytes, artifact, settings, and budget.")
    if any(not isinstance(prior.get(key), str) or not re.fullmatch(r"[0-9a-f]{64}", prior[key]) for key in ("protocolSha256", "adapterSha256")):
        raise ValueError("Recovery requires the original protocol and adapter hashes.")
    return {"receiptPath": str(path.resolve()), "receiptSha256": sha256(path), "priorProtocolSha256": prior["protocolSha256"], "priorAdapterSha256": prior["adapterSha256"], "modelId": prior.get("modelId"), "runId": prior.get("runId"), "registrationMode": "same-name-return-existing", "trainingPreviouslySubmitted": False}


def summarize_readback(events: list[dict[str, Any]], checkpoints: list[dict[str, Any]], job: dict[str, Any]) -> dict[str, Any]:
    gradients = [item for item in events if item["type"] == "gradient_step"]
    ended = any(item["type"] == "training_ended" for item in events)
    failed = any(item["type"] == "training_failed" for item in events) or str(job.get("status", "")).lower() in {"failed", "cancelled", "canceled"}
    positive = [item for item in checkpoints if type(item.get("step")) is int and item["step"] > 0]
    if failed and ended:
        raise ValueError("Training events disagree about completion; manual review is required.")
    positive.sort(key=lambda item: item["step"], reverse=True)
    complete = ended and not failed and bool(positive)
    return {"verifiedAt": now(), "status": "trained" if complete else "failed" if failed else "pending", "completedEvent": ended, "gradientUpdates": len(gradients), "checkpoint": positive[0] if complete else None, "firstLoss": gradients[0]["data"].get("loss") if gradients else None, "lastLoss": gradients[-1]["data"].get("loss") if gradients else None, "processedTokens": sum(item["data"].get("num_tokens", 0) for item in gradients), "lossBearingTokens": sum(item["data"].get("num_trainable_tokens", 0) for item in gradients)}


async def readback(receipt: dict[str, Any], directory: Path) -> dict[str, Any]:
    from art.serverless.client import Client
    if not receipt.get("trainingJobId") or not receipt.get("modelId"):
        raise ValueError("No durable training job ID is available. Do not submit again; investigate the unknown submission.")
    client = Client(base_url=receipt["trainingBaseUrl"])
    client.timeout = 60.0
    client.max_retries = 1
    try:
        job = await client.get(f"/preview/training-jobs/{receipt['trainingJobId']}", cast_to=dict[str, Any])
        raw_events = [event.model_dump() async for event in client.sft_training_jobs.events.list(training_job_id=receipt["trainingJobId"])]
        raw_checkpoints = [checkpoint.model_dump() async for checkpoint in client.models.checkpoints.list(model_id=receipt["modelId"], order="desc", limit=10)]
    finally:
        await client.close()
    # Keep numeric telemetry and identifiers, never raw error messages or URLs.
    events = [{"id": item["id"], "type": item["type"], "data": {k: v for k, v in item.get("data", {}).items() if publication.finite(v)}} for item in raw_events]
    checkpoints = [{k: v for k, v in item.items() if k in {"id", "step", "artifact_name", "version"}} for item in raw_checkpoints]
    job_summary = {k: v for k, v in job.items() if k in {"id", "model_id", "status", "created_at", "started_at", "completed_at", "finished_at"} and isinstance(v, (str, int, float, type(None)))}
    result = {"trainingJobId": receipt["trainingJobId"], "modelId": receipt["modelId"], "job": job_summary, "events": events, "checkpoints": checkpoints, **summarize_readback(events, checkpoints, job_summary)}
    if result["status"] == "trained":
        if result["gradientUpdates"] != math.ceil(receipt["rows"] / 8):
            raise ValueError("Completed job's optimizer update count differs from the one-epoch protocol.")
        if result["checkpoint"].get("artifact_name", receipt["attempt"]) != receipt["attempt"]:
            raise ValueError("Positive checkpoint belongs to a different model artifact.")
        project_path = receipt["datasetArtifact"].rsplit("/", 1)[0]
        result.update(trainedStep=result["checkpoint"]["step"], checkpointId=result["checkpoint"]["id"], inferenceModel=f"wandb-artifact:///{project_path}/{receipt['attempt']}:step{result['checkpoint']['step']}", protocolSha256=receipt["protocolSha256"], manifestSha256=receipt["manifestSha256"], sourceSha256=receipt["sourceSha256"], settings=receipt["settings"], runId=receipt["runId"], runUrl=receipt["runUrl"])
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / ("readback-" + now().replace(":", "-") + ".json")
    target.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    result["readbackFile"] = str(target.relative_to(ROOT))
    result["readbackSha256"] = sha256(target)
    return result


async def execute_training(evidence: dict[str, Any], timeout_seconds: int, recovery_path: Path | None = None) -> dict[str, Any]:
    import art
    import wandb
    from art.serverless.backend import ServerlessBackend
    from art.utils.sft import train_sft_from_file

    entity, project = os.environ["WANDB_ENTITY"], os.environ.get("WANDB_PROJECT", "flowblock")
    if not evidence["datasetArtifact"].startswith(f"{entity}/{project}/"):
        raise ValueError("Train artifact and configured private project must match.")
    recovery = registration_recovery(evidence, recovery_path) if recovery_path else None
    directory = ROOT / "training/artifacts/next-training" / evidence["experimentId"]
    if recovery:
        directory = directory / ("registration-recovery-" + recovery["receiptSha256"][:12])
    directory.mkdir(parents=True, exist_ok=True)
    receipt_path = directory / "attempt.json"
    if receipt_path.exists():
        raise ValueError("This experiment already has an attempt receipt. Use --readback; no second submission is permitted.")
    api = publication.authenticated_api(entity, project)
    if not recovery and publication.find_run(api, f"{entity}/{project}", evidence["attempt"]):
        raise ValueError("A remote run already has this experiment identity. Investigate before any registration or training submission.")
    artifact = api.artifact(evidence["datasetArtifact"])
    if artifact.id != evidence["datasetArtifactId"] or artifact.digest != evidence["datasetArtifactDigest"]:
        raise ValueError("Remote training artifact differs from the verified publication.")
    expected = {"manifest.json": evidence["dataset"]["manifestSha256"], **{entry["name"]: entry["sha256"] for entry in evidence["dataset"]["files"]}}
    publication.verify_artifact(artifact, expected, directory / "dataset")
    downloaded_source = Path(artifact.get_entry(evidence["sourceName"]).download(root=str(directory / "dataset")))
    if sha256(downloaded_source) != evidence["sourceSha256"]:
        raise ValueError("Downloaded train bytes differ from the frozen source.")
    receipt = {
        "version": VERSION, "attempt": evidence["attempt"], "experimentId": evidence["experimentId"], "status": "preflight", "startedAt": now(),
        "protocolSha256": evidence["protocolSha256"], "adapterSha256": evidence["adapterSha256"], "manifestSha256": evidence["dataset"]["manifestSha256"], "sourceSha256": evidence["sourceSha256"],
        "datasetArtifact": evidence["datasetArtifact"], "datasetArtifactId": artifact.id, "datasetArtifactDigest": artifact.digest,
        "settings": SETTINGS, "budget": evidence["protocol"]["budget"], "rows": evidence["rowCount"], "artVersion": importlib.metadata.version("openpipe-art"), "wandbVersion": importlib.metadata.version("wandb"),
        "trainingBaseUrl": os.environ.get("WANDB_TRAINING_BASE_URL", "https://forge.coreweave.com/api/training/v1"),
        "registrationSubmitted": False, "trainingSubmitted": False, "monitoringTimeoutSeconds": timeout_seconds,
        "registrationRecovery": recovery,
        "costAccounting": {"publishedRateUsdPerGpuHour": 2.70, "source": "https://coreweave.com/forge-pricing/post-training", "rateCheckedAt": "2026-10-29", "billedGpuHours": None, "billedCostUsd": None, "timeoutCancelsRemoteJob": False, "cancellationApiAvailableInPinnedSdk": False, "limit": "One job and bounded examples/epochs. Client monitoring time is not a server-side spending cap; GPU count and active billable time require service readback."},
    }
    with receipt_path.open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    backend = ServerlessBackend(base_url=receipt["trainingBaseUrl"])
    backend._client.timeout = 120.0
    model = art.TrainableModel(name=evidence["attempt"], run_name=evidence["attempt"], entity=entity, project=project, base_model=SETTINGS["baseModel"])
    original_register = backend._client.models.create

    async def register_same_identity(**kwargs: Any):
        expected = {"entity": entity, "project": project, "name": evidence["attempt"], "base_model": SETTINGS["baseModel"], "return_existing": True}
        if kwargs != expected:
            raise ValueError("Registration must use the exact same named model and return_existing=true.")
        registered = await original_register(**kwargs)
        if any(getattr(registered, key) != expected[key] for key in ("entity", "project", "name", "base_model")):
            raise ValueError("Registered model identity differs from the authorized attempt.")
        if recovery and ((recovery["modelId"] and registered.id != recovery["modelId"]) or (recovery["runId"] and registered.run_id != recovery["runId"])):
            raise ValueError("Recovery returned a different registered model or run.")
        return registered

    backend._client.models.create = register_same_identity
    try:
        receipt.update(status="registering", registrationSubmitted=True)
        save_receipt(receipt_path, receipt)
        await asyncio.wait_for(model.register(backend), timeout=180)
        if not model.id or not model.run_id:
            raise ValueError("Model registration did not return durable model and run IDs.")
        receipt.update(status="registered", modelId=model.id, runId=model.run_id, runUrl=f"https://forge.coreweave.com/wandb/{entity}/{project}/runs/{model.run_id}")
        save_receipt(receipt_path, receipt)
        existing_checkpoints = [checkpoint async for checkpoint in backend._client.models.checkpoints.list(model_id=model.id, order="desc", limit=1)]
        if any(checkpoint.step > 0 for checkpoint in existing_checkpoints):
            raise ValueError("Registered model already has a positive checkpoint; this is not a fresh training attempt.")
        settings = publication.run_settings()
        with wandb.init(entity=entity, project=project, id=model.run_id, name=evidence["attempt"], resume="allow", job_type="serverless-sft", config={"experimentId": evidence["experimentId"], "trainingProtocolSha256": evidence["protocolSha256"], "trainManifestSha256": evidence["dataset"]["manifestSha256"], "trainSourceSha256": evidence["sourceSha256"], "trainArtifactId": artifact.id, "trainingSettings": SETTINGS, "budget": evidence["protocol"]["budget"]}, settings=settings, dir=str(directory)) as run:
            run.use_artifact(artifact)
        api.flush()
        native_run = api.run(f"{entity}/{project}/{model.run_id}")
        if artifact.id not in {item.id for item in native_run.used_artifacts()}:
            raise ValueError("Dataset input edge was not visible before training; submission stopped.")
        receipt.update(status="input-lineage-verified", inputLineageVerifiedAt=now())
        save_receipt(receipt_path, receipt)
        original_create = backend._client.sft_training_jobs.create

        async def record_submission(**kwargs: Any):
            if receipt["trainingSubmitted"]:
                raise ValueError("A second SFT submission is forbidden.")
            derived_ref = kwargs.get("training_data_url", "").removeprefix("wandb-artifact:///")
            if not derived_ref.startswith(f"{entity}/{project}/") or not derived_ref.endswith(":v0"):
                raise ValueError("ART's derived dataset must be an immutable artifact in the same project.")
            api.flush()
            derived = api.artifact(derived_ref)
            derived_path = Path(derived.get_entry("train.jsonl").download(root=str(directory / "derived-data")))
            identity = verify_derived_rows(evidence["rows"], derived_path)
            config = kwargs.get("config", {})
            if config.get("assistant_turns") != "last" or config.get("batch_size") != 8 or not isinstance(config.get("learning_rate"), list) or len(config["learning_rate"]) != math.ceil(evidence["rowCount"] / 8):
                raise ValueError("Submitted SFT configuration differs from the frozen one-epoch budget.")
            from art.utils.sft import create_lr_schedule
            schedule = create_lr_schedule(total_steps=len(config["learning_rate"]), peak_lr=2e-4, method="cosine", warmup_steps=int(len(config["learning_rate"]) * 0.1))
            if config["learning_rate"] != schedule:
                raise ValueError("Submitted learning-rate schedule differs from the frozen cosine schedule.")
            receipt.update(status="submitting-training", trainingSubmitted=True, submittedAt=now(), trainingDataArtifact=f"wandb-artifact:///{derived_ref}", derivedDataset={"artifactId": derived.id, "artifactDigest": derived.digest, **identity}, submittedConfig=config)
            save_receipt(receipt_path, receipt)
            job = await original_create(**kwargs)
            receipt.update(status="training", trainingJobId=job.id)
            save_receipt(receipt_path, receipt)
            return job

        backend._client.sft_training_jobs.create = record_submission
        await asyncio.wait_for(train_sft_from_file(model=model, file_path=str(downloaded_source), epochs=1, batch_size=8, peak_lr=2e-4, schedule_type="cosine", assistant_turns="last", verbose=False), timeout=timeout_seconds)
        receipt["clientTrainingLoopReturnedAt"] = now()
    except Exception as error:
        receipt.update(status="submitted-outcome-unknown" if receipt["trainingSubmitted"] else "stopped-before-training", errorType=type(error).__name__, httpStatus=getattr(error, "status_code", None))
        save_receipt(receipt_path, receipt)
    finally:
        await backend.close()
        if model._wandb_run is not None:
            try:
                model._wandb_run.finish()
            except Exception as error:
                receipt["clientTelemetryErrorType"] = type(error).__name__
        if receipt.get("trainingJobId"):
            try:
                checked = await asyncio.wait_for(readback(receipt, directory), timeout=240)
                receipt.update(readback=checked, status=checked["status"])
                if checked["status"] == "trained":
                    step = checked["checkpoint"]["step"]
                    receipt.update(trainedStep=step, checkpointId=checked["checkpoint"]["id"], inferenceModel=f"wandb-artifact:///{entity}/{project}/{evidence['attempt']}:step{step}", completedAt=now())
            except Exception as error:
                receipt["readbackErrorType"] = type(error).__name__
        save_receipt(receipt_path, receipt)
    return {**receipt, "receiptPath": str(receipt_path.relative_to(ROOT))}


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path, nargs="?")
    parser.add_argument("source", type=Path, nargs="?")
    parser.add_argument("--dataset-receipt", type=Path)
    parser.add_argument("--protocol", type=Path)
    parser.add_argument("--train", action="store_true")
    parser.add_argument("--readback", type=Path)
    parser.add_argument("--resume-registration", type=Path, help="Preserved receipt proving registration stopped before any SFT POST; reuses the same model name.")
    parser.add_argument("--timeout-seconds", type=int, default=1800)
    args = parser.parse_args()
    if not 60 <= args.timeout_seconds <= 3600:
        raise SystemExit("Monitoring timeout must be between 60 and 3,600 seconds; it does not cancel remote work.")
    if args.readback and (args.train or args.manifest or args.source or args.dataset_receipt or args.protocol or args.resume_registration):
        raise SystemExit("Readback is a separate read-only operation.")
    evidence = None
    if not args.readback:
        if not all([args.manifest, args.source, args.dataset_receipt, args.protocol]):
            raise SystemExit("MANIFEST SOURCE --dataset-receipt RECEIPT --protocol PROTOCOL are required.")
        evidence = load_training(args.manifest, args.source, args.dataset_receipt, args.protocol)
        if args.resume_registration:
            registration_recovery(evidence, args.resume_registration)
        if not args.train:
            print(json.dumps({"mode": "dry-run", **{k: evidence[k] for k in ("version", "experimentId", "attempt", "protocolSha256", "sourceSha256", "datasetArtifact", "rowCount", "adapterSha256")}, "settings": SETTINGS, "budget": evidence["protocol"]["budget"]}, indent=2))
            return
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env.local", override=False)
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    os.environ.setdefault("WANDB_SILENT", "true")
    os.environ.setdefault("WANDB_BASE_URL", "https://api.forge.coreweave.com")
    if not os.environ.get("WANDB_API_KEY") or not os.environ.get("WANDB_ENTITY"):
        raise SystemExit("WANDB_API_KEY and WANDB_ENTITY are required.")
    try:
        if args.readback:
            receipt = publication.load_json(args.readback)
            result = await asyncio.wait_for(readback(receipt, args.readback.resolve().parent), timeout=240)
            # Readback creates a new evidence record and leaves the submission receipt intact.
        else:
            result = await execute_training(evidence, args.timeout_seconds, args.resume_registration)
    except Exception as error:
        raise SystemExit(f"Training/readback stopped: {type(error).__name__}. Inspect durable receipts before considering another action. No raw provider error is printed.") from None
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
