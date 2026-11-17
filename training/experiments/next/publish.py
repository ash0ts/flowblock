"""Publish a frozen dataset and completed benchmark to W&B Models.

The default validates local evidence only. Publication creates a dataset producer
run and a benchmark consumer run, then verifies file bytes, metrics, and lineage.
No inference or training is performed here.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
import re
import shutil
import time
from types import SimpleNamespace
from typing import Any
from urllib.parse import urlsplit

# W&B's internal Artifact client captures this at import time. Set it before
# importing wandb, including when this module is imported by the SFT adapter.
os.environ.setdefault("WANDB_HTTP_TIMEOUT", "90")
os.environ.setdefault("WANDB_FILE_PUSHER_TIMEOUT", "120")

ROOT = Path(__file__).resolve().parents[3]
VERSION = "flowblock-experiment-publication-v1"
IDENTIFIER = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
METRIC = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_./-]{0,99}\Z")
ROLES = {"scenes", "tracking_labels", "source_manifest", "splits", "protocol", "training_actions", "metadata"}
ROW_FIELDS = {
    "taskId", "sceneId", "productId", "sourceId", "sequenceId", "frameId", "family", "split", "arm",
    "available", "feasible", "preservedBrief", "outcome", "durationMs", "inputTokens", "outputTokens",
    "score", "centerError", "extentError", "iou", "coverage", "frames", "visibleFrames", "trackedFrames",
    "truePositive", "falsePositive", "falseNegative", "abstentions", "source", "license", "note",
    "compileActions", "invalidCompileActions", "validCandidates", "matchingCandidates", "acceptedAbstention",
    "meanCenterError", "meanExtentError", "meanIoU", "precision", "recall", "runtimeVersion", "checkerVersion",
    "status", "sourceDataset", "licenseId", "imageCount", "annotationCount", "reason", "count",
    "maskCenterInsideProjectedBoxFraction", "maskCentroidToProjected3dCenterFrameDiagonalDiscrepancy",
    "maskWidthToProjectedBoxWidthRatio", "maskHeightToProjectedBoxHeightRatio",
    "evaluationSamplesExcludingSeed", "usableSamples", "usableFraction", "processingSeconds",
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strict_object(value: Any, required: set[str], optional: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) - required - optional or not required <= set(value):
        raise ValueError(f"{label} has missing or unsupported fields.")
    return value


def finite(value: Any) -> bool:
    return type(value) in (int, float) and math.isfinite(value)


def identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER.fullmatch(value):
        raise ValueError(f"{label} must be a simple identifier.")
    return value


def safe_text(value: Any, label: str, maximum: int = 4000) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"{label} must be nonempty bounded text.")
    if re.search(r"(?:Bearer\s|api[_-]?key\s*[:=]|X-Amz-|X-Goog-|[?&](?:token|signature)=)", value, re.I):
        raise ValueError(f"{label} contains credential or signed-URL material.")
    return value


def public_url(value: Any, label: str) -> str:
    safe_text(value, label)
    url = urlsplit(value)
    if url.scheme != "https" or not url.netloc or url.username or url.password or url.query:
        raise ValueError(f"{label} must be an unsigned HTTPS source URL.")
    return value


def load_json(path: Path) -> Any:
    def reject_constant(value: str) -> None:
        raise ValueError(f"Nonfinite JSON number: {value}.")
    return json.loads(path.read_text(), parse_constant=reject_constant)


def inspect_metadata_file(path: Path) -> None:
    if path.stat().st_size > 20_000_000:
        raise ValueError("Metadata files may not exceed 20 MB.")

    def inspect(value: Any) -> None:
        if isinstance(value, dict):
            for key, item in value.items():
                if re.fullmatch(r"(?:wandb[_-]?)?api[_-]?key|authorization|cookie|password|access[_-]?token|refresh[_-]?token", key, re.I):
                    raise ValueError("Dataset metadata contains a credential field.")
                inspect(item)
        elif isinstance(value, list):
            for item in value:
                inspect(item)
        elif isinstance(value, str) and value:
            safe_text(value, "Dataset metadata", maximum=max(len(value), 4000))
        elif isinstance(value, float) and not math.isfinite(value):
            raise ValueError("Dataset metadata contains a nonfinite number.")

    if path.suffix.lower() == ".json":
        inspect(load_json(path))
    elif path.suffix.lower() == ".jsonl":
        with path.open() as stream:
            for line in stream:
                if line.strip():
                    inspect(json.loads(line))
    else:
        with path.open(newline="") as stream:
            for row in csv.DictReader(stream):
                inspect(row)


def load_evidence(manifest_path: Path, results_path: Path | None = None) -> dict[str, Any]:
    manifest_path = manifest_path.resolve()
    results_path = results_path.resolve() if results_path else None
    manifest = strict_object(load_json(manifest_path), {"schemaVersion", "datasetId", "version", "description", "files", "metadata"}, set(), "Dataset manifest")
    result = strict_object(load_json(results_path), {"schemaVersion", "experimentId", "datasetManifestSha256", "status", "metrics", "rows", "metadata"}, set(), "Results") if results_path else None
    if manifest["schemaVersion"] != 1 or (result is not None and result["schemaVersion"] != 1):
        raise ValueError("Unsupported schema version.")
    dataset_id = identifier(manifest["datasetId"], "Dataset ID")
    identifier(manifest["version"], "Dataset version")
    if result is not None:
        identifier(result["experimentId"], "Experiment ID")
    safe_text(manifest["description"], "Dataset description")
    metadata = strict_object(manifest["metadata"], {"kind"}, {"splitUnit", "counts", "limitations"}, "Dataset metadata")
    if metadata["kind"] not in {"authored-synthetic", "licensed-derived", "licensed-public"}:
        raise ValueError("Dataset provenance must be authored or explicitly licensed.")
    if "splitUnit" in metadata:
        safe_text(metadata["splitUnit"], "Split unit")
    if "counts" in metadata:
        if not isinstance(metadata["counts"], dict) or any(not isinstance(k, str) or not METRIC.fullmatch(k) or type(v) is not int or v < 0 for k, v in metadata["counts"].items()):
            raise ValueError("Dataset counts must be named nonnegative integers.")
    if result is not None:
        strict_object(result["metadata"], {"runtimeVersion", "checkerVersion", "evaluationKind", "limitations"}, set(), "Results metadata")
    for item in [metadata] + ([result["metadata"]] if result is not None else []):
        if "limitations" in item:
            if not isinstance(item["limitations"], list):
                raise ValueError("Limitations must be a list.")
            for limitation in item["limitations"]:
                safe_text(limitation, "Limitation")
    if not isinstance(manifest["files"], list) or not manifest["files"]:
        raise ValueError("Dataset files must be a nonempty explicit list.")
    files = []
    seen = {"manifest.json"}
    for entry in manifest["files"]:
        strict_object(entry, {"path", "sha256", "role", "license"}, {"sourceUrl", "split"}, "Dataset file")
        relative = entry["path"]
        if not isinstance(relative, str) or "\\" in relative or Path(relative).is_absolute() or any(part in ("..", ".") for part in Path(relative).parts):
            raise ValueError("Dataset paths must stay inside the manifest directory.")
        path = (manifest_path.parent / relative).resolve()
        if not path.is_relative_to(manifest_path.parent) or path == manifest_path or relative in seen:
            raise ValueError("Dataset paths must be distinct and stay inside the manifest directory.")
        if path.suffix.lower() not in {".json", ".jsonl", ".csv"} or path.name.startswith("."):
            raise ValueError("Only explicitly listed JSON, JSONL, and CSV metadata can be published; media is excluded.")
        if entry["role"] not in ROLES:
            raise ValueError("Unsupported dataset file role.")
        if not isinstance(entry["sha256"], str) or not HASH.fullmatch(entry["sha256"]) or sha256(path) != entry["sha256"]:
            raise ValueError("Dataset file hash differs from the frozen manifest.")
        inspect_metadata_file(path)
        license_data = strict_object(entry["license"], {"id", "url", "redistributionAllowed"}, set(), "Dataset license")
        safe_text(license_data["id"], "License ID", 100)
        public_url(license_data["url"], "License URL")
        if license_data["redistributionAllowed"] is not True:
            raise ValueError("Every published file requires explicit redistribution permission.")
        if "sourceUrl" in entry:
            public_url(entry["sourceUrl"], "Source URL")
        if "split" in entry and entry["split"] not in {"train", "development", "confirmation", "benchmark", "diagnostic"}:
            raise ValueError("Unsupported dataset split.")
        files.append({"path": str(path), "name": relative, "sha256": entry["sha256"]})
        seen.add(relative)
    manifest_hash = sha256(manifest_path)
    common = {
        "version": VERSION, "manifestPath": str(manifest_path), "manifestSha256": manifest_hash,
        "manifest": manifest, "files": files, "datasetRunId": f"dataset-{manifest_hash[:24]}",
        "datasetArtifactName": f"{dataset_id}-{manifest['version']}",
    }
    if result is None:
        return {**common, "resultsPath": None, "resultsSha256": None, "results": None, "runId": common["datasetRunId"], "evidenceSha256": manifest_hash, "resultsArtifactName": None}
    if result["datasetManifestSha256"] != manifest_hash:
        raise ValueError("Results refer to a different dataset manifest.")
    if result["status"] != "completed":
        raise ValueError("Only completed measured results can be published.")
    result_metadata = strict_object(result["metadata"], {"runtimeVersion", "checkerVersion", "evaluationKind", "limitations"}, set(), "Results metadata")
    for key in ("runtimeVersion", "checkerVersion"):
        safe_text(result_metadata[key], key, 200)
    if result_metadata["evaluationKind"] not in {"development", "confirmation", "measurement-benchmark", "dataset-audit"}:
        raise ValueError("Unsupported evaluation kind.")
    if not isinstance(result["metrics"], dict) or not result["metrics"]:
        raise ValueError("Measured metrics must be a nonempty object.")
    for name, value in result["metrics"].items():
        if not METRIC.fullmatch(name) or name.lower().startswith(("target", "proposed", "acceptance")) or not finite(value):
            raise ValueError("Metrics must contain finite observed values, not targets.")
    if not isinstance(result["rows"], list) or not result["rows"]:
        raise ValueError("Results require nonempty evidence rows.")
    if len(result["rows"]) > 10000:
        raise ValueError("Publication supports at most 10,000 evidence rows.")
    for row in result["rows"]:
        if not isinstance(row, dict) or not row or set(row) - ROW_FIELDS:
            raise ValueError("Result rows contain unsupported fields.")
        for value in row.values():
            if isinstance(value, str):
                safe_text(value, "Result row value", 1000)
            elif value is not None and type(value) is not bool and not finite(value):
                raise ValueError("Result rows must contain finite scalars only.")
    result_hash = sha256(results_path)
    evidence_hash = hashlib.sha256(json.dumps({"version": VERSION, "manifest": manifest_hash, "results": result_hash}, sort_keys=True).encode()).hexdigest()
    return {
        **common, "resultsPath": str(results_path), "resultsSha256": result_hash,
        "evidenceSha256": evidence_hash, "results": result, "runId": f"benchmark-{evidence_hash[:24]}",
        "resultsArtifactName": f"{result['experimentId']}-{evidence_hash[:16]}-results",
    }


def verify_artifact(artifact: Any, expected: dict[str, str], directory: Path) -> dict[str, Any]:
    """Download just the declared evidence and verify bytes, not metadata alone."""
    actual = set(artifact.manifest.entries)
    if actual != set(expected):
        raise ValueError("Remote artifact file membership differs.")
    for name, digest in expected.items():
        downloaded = Path(artifact.get_entry(name).download(root=str(directory)))
        if sha256(downloaded) != digest:
            raise ValueError(f"Remote artifact file hash differs: {name}.")
    return {"id": artifact.id, "name": artifact.name, "digest": artifact.digest, "verifiedFiles": len(expected)}


def verify_dataset(run: Any, evidence: dict[str, Any], directory: Path) -> tuple[Any, dict[str, Any]]:
    if run.state != "finished" or run.config.get("manifestSha256") != evidence["manifestSha256"]:
        raise ValueError("Dataset producer is unfinished or has different evidence.")
    matches = [a for a in run.logged_artifacts() if a.name.startswith(evidence["datasetArtifactName"] + ":") and a.type == "dataset"]
    if len(matches) != 1 or matches[0].metadata.get("manifestSha256") != evidence["manifestSha256"]:
        raise ValueError("Dataset producer must log exactly one matching dataset artifact.")
    artifact = matches[0]
    expected = {"manifest.json": evidence["manifestSha256"], **{f["name"]: f["sha256"] for f in evidence["files"]}}
    return artifact, verify_artifact(artifact, expected, directory)


def verify_run(run: Any, evidence: dict[str, Any], dataset: Any, directory: Path) -> dict[str, Any]:
    if run.state != "finished" or run.config.get("evidenceSha256") != evidence["evidenceSha256"]:
        raise ValueError("Benchmark run is unfinished or has different evidence.")
    expected = evidence["results"]["metrics"]
    for key, value in expected.items():
        if not finite(run.summary.get(key)) or not math.isclose(run.summary[key], value, rel_tol=1e-12, abs_tol=1e-12):
            raise ValueError(f"Remote summary metric differs: {key}.")
    history = list(run.scan_history(keys=list(expected), page_size=100))
    if len(history) != 1 or any(not finite(history[0].get(k)) or not math.isclose(history[0][k], v, rel_tol=1e-12, abs_tol=1e-12) for k, v in expected.items()):
        raise ValueError("Remote metric history differs from the completed result.")
    used = [{"id": a.id, "name": a.name, "digest": a.digest} for a in run.used_artifacts()]
    if dataset.id not in {a["id"] for a in used} or run.config.get("datasetArtifactId") != dataset.id:
        raise ValueError("Benchmark dataset input lineage is missing.")
    outputs = [a for a in run.logged_artifacts() if a.name.startswith(evidence["resultsArtifactName"] + ":") and a.type == "evaluation-results"]
    if len(outputs) != 1:
        raise ValueError("Expected one results artifact.")
    output = verify_artifact(outputs[0], {"results.json": evidence["resultsSha256"]}, directory)
    if run.summary.get("publication/row_count") != len(evidence["results"]["rows"]):
        raise ValueError("Remote evidence row count differs.")
    return {"verifiedAt": now(), "metricCount": len(expected), "rowCount": len(evidence["results"]["rows"]), "usedArtifacts": used, "resultsArtifact": output, "state": run.state}


def find_run(api: Any, project: str, run_id: str) -> Any | None:
    rows = list(api.runs(project, filters={"name": run_id}, per_page=1))
    if len(rows) > 1:
        raise ValueError("Multiple runs have the same deterministic identity.")
    return rows[0] if rows else None


def require_private_project(api: Any, entity: str, project: str) -> None:
    import httpx
    # W&B 0.31's Project API omits access and no longer exposes Api.client.
    # This bounded read uses the same configured API and credentials. IPv4
    # succeeded in local preflight while default transports were intermittent.
    with httpx.Client(transport=httpx.HTTPTransport(local_address="0.0.0.0"), timeout=httpx.Timeout(60.0, connect=55.0), follow_redirects=False) as client:
        for attempt in range(3):
            try:
                response = client.post(api.settings["base_url"].rstrip("/") + "/graphql", auth=("api", os.environ["WANDB_API_KEY"]), json={"query": "query FlowBlockProjectAccess($entity: String!, $project: String!) { project(name: $project, entityName: $entity) { name access } }", "variables": {"entity": entity, "project": project}})
                response.raise_for_status()
                body = response.json()
                break
            except httpx.TransportError:
                if attempt == 2:
                    raise
                time.sleep(2)
    if body.get("errors"):
        raise ValueError("Project access preflight returned GraphQL errors.")
    result = body.get("data", {})
    record = result.get("project")
    if not record or str(record.get("access", "")).lower() not in {"private", "restricted"}:
        raise ValueError("Publication requires an existing private or restricted project.")


def authenticated_api(entity: str, project: str) -> Any:
    import wandb
    api_base = os.environ.get("WANDB_BASE_URL", "https://api.forge.coreweave.com")
    os.environ.setdefault("WANDB_HTTP_TIMEOUT", "90")
    os.environ.setdefault("WANDB_FILE_PUSHER_TIMEOUT", "120")
    if cached_project_proof(entity, project, api_base) is None:
        require_private_project(SimpleNamespace(settings={"base_url": api_base}), entity, project)
    # The HTTP preflight established that this key can read the private project.
    # Retry only SDK authentication transport failures, before any remote write.
    for attempt in range(3):
        try:
            return wandb.Api(api_key=os.environ["WANDB_API_KEY"], overrides={"base_url": api_base}, timeout=90)
        except wandb.errors.AuthenticationError:
            if attempt == 2:
                raise
            time.sleep(2)


def cached_project_proof(entity: str, project: str, api_base: str) -> dict[str, Any] | None:
    path = os.environ.get("FLOWBLOCK_PRIVATE_PROJECT_PROOF")
    if not path:
        return None
    proof = load_json(Path(path))
    age = (datetime.now(timezone.utc) - datetime.fromisoformat(proof["startedAt"])).total_seconds()
    original = proof.get("originalRun", {})
    if proof.get("mode") != "read-only" or proof.get("status") != "verified-read" or proof.get("privateProjectVerified") is not True or proof.get("sdkAuthenticated") is not True or proof.get("apiBase") != api_base or proof.get("entity") != entity or proof.get("project") != project or original.get("entity") != entity or original.get("project") != project or not 0 <= age <= 900:
        raise ValueError("Cached proof must verify this exact private project within the last 15 minutes.")
    return {"source": "cached-same-session-read", "proofSha256": sha256(Path(path)), "verifiedAt": proof["startedAt"], "apiBase": api_base}


def run_settings() -> Any:
    import wandb
    return wandb.Settings(api_key=os.environ["WANDB_API_KEY"], base_url=os.environ.get("WANDB_BASE_URL", "https://api.forge.coreweave.com"), disable_code=True, disable_git=True, disable_job_creation=True, x_disable_stats=True, x_disable_machine_info=True, init_timeout=120, finish_timeout=120, finish_timeout_raises=True, x_graphql_timeout_seconds=90, x_file_transfer_timeout_seconds=120, x_file_stream_timeout_seconds=120)


def publish(evidence: dict[str, Any], receipt_dir: Path, *, verify_only: bool = False) -> dict[str, Any]:
    import wandb
    entity, project = os.environ["WANDB_ENTITY"], os.environ.get("WANDB_PROJECT", "flowblock")
    identifier(entity, "Entity")
    identifier(project, "Project")
    project_path = f"{entity}/{project}"
    api = authenticated_api(entity, project)
    receipt_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = receipt_dir / f"{evidence['runId']}.json"
    receipt = {
        "version": VERSION, "runId": evidence["runId"], "datasetRunId": evidence["datasetRunId"],
        "evidenceSha256": evidence["evidenceSha256"], "manifestSha256": evidence["manifestSha256"],
        "status": "preflight", "startedAt": now(), "remoteMutationAttempted": False,
        "apiBase": api.settings["base_url"], "projectAccess": cached_project_proof(entity, project, api.settings["base_url"]) or {"source": "live-read", "verifiedAt": now()},
        "runUrl": f"https://forge.coreweave.com/wandb/{project_path}/runs/{evidence['runId']}",
        "datasetRunUrl": f"https://forge.coreweave.com/wandb/{project_path}/runs/{evidence['datasetRunId']}",
    }
    dataset_run = find_run(api, project_path, evidence["datasetRunId"])
    dataset_only = evidence["results"] is None
    benchmark_run = None if dataset_only else find_run(api, project_path, evidence["runId"])
    existing_receipt = load_json(receipt_path) if receipt_path.exists() else None
    if existing_receipt:
        if existing_receipt.get("evidenceSha256") != evidence["evidenceSha256"]:
            raise ValueError("Local publication receipt identifies different evidence.")
        receipt = existing_receipt
    if verify_only or existing_receipt or benchmark_run or (dataset_only and dataset_run):
        if not dataset_run or (not dataset_only and not benchmark_run):
            raise ValueError("Publication is incomplete or unknown. Read back before considering a separate recovery; no writes were retried.")
    else:
        # Upload a verified local snapshot so a concurrent edit cannot change the
        # bytes after the preflight while preserving the old manifest hash.
        snapshot = receipt_dir / "payloads" / evidence["evidenceSha256"]
        snapshot.mkdir(parents=True, exist_ok=True)
        paths = [(evidence["manifestPath"], "manifest.json", evidence["manifestSha256"])]
        if not dataset_only:
            paths.append((evidence["resultsPath"], "results.json", evidence["resultsSha256"]))
        paths += [(entry["path"], "dataset/" + entry["name"], entry["sha256"]) for entry in evidence["files"]]
        for source, name, expected in paths:
            destination = snapshot / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            if sha256(destination) != expected:
                raise ValueError("Evidence changed after validation; publication stopped before remote writes.")
        receipt.update(status="publishing", remoteMutationAttempted=True)
        with receipt_path.open("x") as stream:
            stream.write(json.dumps(receipt, indent=2) + "\n")
        settings = run_settings()
        try:
            if not dataset_run:
                with wandb.init(entity=entity, project=project, id=evidence["datasetRunId"], resume="never", name=f"Dataset: {evidence['manifest']['datasetId']} {evidence['manifest']['version']}", job_type="dataset-publication", tags=["flowblock", "dataset"], config={"publicationVersion": VERSION, "manifestSha256": evidence["manifestSha256"], "datasetMetadata": evidence["manifest"]["metadata"]}, settings=settings, dir=str(receipt_dir)) as run:
                    artifact = wandb.Artifact(evidence["datasetArtifactName"], type="dataset", description=evidence["manifest"]["description"], metadata={"manifestSha256": evidence["manifestSha256"], **evidence["manifest"]["metadata"]})
                    artifact.add_file(str(snapshot / "manifest.json"), name="manifest.json")
                    for entry in evidence["files"]:
                        artifact.add_file(str(snapshot / "dataset" / entry["name"]), name=entry["name"])
                    run.log_artifact(artifact).wait()
                api.flush()
                dataset_run = api.run(f"{project_path}/{evidence['datasetRunId']}")
            dataset, dataset_readback = verify_dataset(dataset_run, evidence, receipt_dir / "readback" / evidence["datasetRunId"])
            receipt.update(dataset=dataset_readback, status="dataset-verified")
            receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
            if not dataset_only:
                metadata = evidence["results"]["metadata"]
                with wandb.init(entity=entity, project=project, id=evidence["runId"], resume="never", name=evidence["results"]["experimentId"], job_type="recorded-benchmark", tags=["flowblock", "measured-results", metadata["evaluationKind"]], config={"publicationVersion": VERSION, "evidenceSha256": evidence["evidenceSha256"], "manifestSha256": evidence["manifestSha256"], "resultsSha256": evidence["resultsSha256"], "datasetArtifactId": dataset.id, "datasetArtifactVersion": dataset.name, "resultMetadata": metadata, "importedAt": now()}, settings=settings, dir=str(receipt_dir)) as run:
                    run.use_artifact(dataset)
                    rows = evidence["results"]["rows"]
                    columns = sorted({key for row in rows for key in row})
                    table = wandb.Table(columns=columns, data=[[row.get(key) for key in columns] for row in rows])
                    run.log({**evidence["results"]["metrics"], "results": table})
                    run.summary["publication/row_count"] = len(rows)
                    artifact = wandb.Artifact(evidence["resultsArtifactName"], type="evaluation-results", metadata={"resultsSha256": evidence["resultsSha256"], "manifestSha256": evidence["manifestSha256"]})
                    artifact.add_file(str(snapshot / "results.json"), name="results.json")
                    run.log_artifact(artifact).wait()
                api.flush()
                benchmark_run = api.run(f"{project_path}/{evidence['runId']}")
        except Exception as error:
            receipt.update(status="publication-outcome-unknown", errorType=type(error).__name__)
            receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
            raise
    dataset, dataset_readback = verify_dataset(dataset_run, evidence, receipt_dir / "readback" / evidence["datasetRunId"])
    readback = verify_run(benchmark_run, evidence, dataset, receipt_dir / "readback" / evidence["runId"]) if not dataset_only else None
    receipt.update(status="verified", dataset=dataset_readback, datasetArtifact=f"{project_path}/{dataset.name}", datasetArtifactUri=f"wandb-artifact:///{project_path}/{dataset.name}", readback=readback)
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def validate_recovery_producer(run: Any, evidence: dict[str, Any]) -> None:
    if evidence["results"] is not None or run is None or run.state not in {"failed", "crashed", "killed"}:
        raise ValueError("Dataset recovery requires an interrupted, existing dataset-only producer.")
    if run.id != evidence["datasetRunId"] or run.config.get("manifestSha256") != evidence["manifestSha256"]:
        raise ValueError("Recovery producer identity or frozen manifest differs.")
    if list(run.logged_artifacts()):
        raise ValueError("Producer already has artifacts. Verify them instead of uploading another version.")


def recover_dataset(evidence: dict[str, Any], receipt_dir: Path, prior_receipt_path: Path) -> dict[str, Any]:
    """Explicit same-ID recovery after independent readback found an empty failed producer."""
    import wandb
    prior = load_json(prior_receipt_path)
    if prior.get("status") != "publication-outcome-unknown" or prior.get("datasetRunId") != evidence["datasetRunId"] or prior.get("manifestSha256") != evidence["manifestSha256"]:
        raise ValueError("Recovery requires a matching preserved unknown-outcome receipt.")
    entity, project = os.environ["WANDB_ENTITY"], os.environ.get("WANDB_PROJECT", "flowblock")
    api = authenticated_api(entity, project)
    project_path = f"{entity}/{project}"
    producer = find_run(api, project_path, evidence["datasetRunId"])
    validate_recovery_producer(producer, evidence)
    receipt_dir.mkdir(parents=True, exist_ok=True)
    receipt_path = receipt_dir / f"{evidence['datasetRunId']}.json"
    snapshot = receipt_dir / "payload"
    snapshot.mkdir(exist_ok=True)
    for source, name, expected in [(evidence["manifestPath"], "manifest.json", evidence["manifestSha256"])] + [(entry["path"], entry["name"], entry["sha256"]) for entry in evidence["files"]]:
        target = snapshot / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        if sha256(target) != expected:
            raise ValueError("Frozen bytes changed before recovery.")
    receipt = {"version": VERSION, "runId": evidence["datasetRunId"], "datasetRunId": evidence["datasetRunId"], "evidenceSha256": evidence["evidenceSha256"], "manifestSha256": evidence["manifestSha256"], "startedAt": now(), "status": "recovering-same-producer", "remoteMutationAttempted": True, "apiBase": api.settings["base_url"], "priorReceiptSha256": sha256(prior_receipt_path), "priorState": producer.state, "priorArtifactCount": 0, "projectAccess": cached_project_proof(entity, project, api.settings["base_url"]) or {"source": "live-read", "verifiedAt": now()}, "runUrl": f"https://forge.coreweave.com/wandb/{project_path}/runs/{evidence['datasetRunId']}", "datasetRunUrl": f"https://forge.coreweave.com/wandb/{project_path}/runs/{evidence['datasetRunId']}"}
    with receipt_path.open("x") as stream:
        stream.write(json.dumps(receipt, indent=2) + "\n")
    try:
        with wandb.init(entity=entity, project=project, id=evidence["datasetRunId"], resume="must", job_type="dataset-publication", settings=run_settings(), dir=str(receipt_dir)) as run:
            artifact = wandb.Artifact(evidence["datasetArtifactName"], type="dataset", description=evidence["manifest"]["description"], metadata={"manifestSha256": evidence["manifestSha256"], **evidence["manifest"]["metadata"]})
            artifact.add_file(str(snapshot / "manifest.json"), name="manifest.json")
            for entry in evidence["files"]:
                artifact.add_file(str(snapshot / entry["name"]), name=entry["name"])
            run.log_artifact(artifact).wait(timeout=600)
        api.flush()
        producer = api.run(f"{project_path}/{evidence['datasetRunId']}")
        artifact, readback = verify_dataset(producer, evidence, receipt_dir / "readback")
        receipt.update(status="verified", dataset=readback, datasetArtifact=f"{project_path}/{artifact.name}", datasetArtifactUri=f"wandb-artifact:///{project_path}/{artifact.name}")
    except Exception as error:
        receipt.update(status="publication-outcome-unknown", errorType=type(error).__name__)
        receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
        raise
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("results", type=Path, nargs="?")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--publish", action="store_true")
    action.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    evidence = load_evidence(args.manifest, args.results)
    if not args.publish and not args.verify:
        print(json.dumps({"mode": "dry-run", "datasetRunId": evidence["datasetRunId"], "runId": evidence["runId"], "manifestSha256": evidence["manifestSha256"], "evidenceSha256": evidence["evidenceSha256"], "fileCount": len(evidence["files"]), "rowCount": len(evidence["results"]["rows"]) if evidence["results"] else None, "metrics": evidence["results"]["metrics"] if evidence["results"] else None}, indent=2))
        return
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env.local", override=False)
    os.environ["PYTHON_DOTENV_DISABLED"] = "1"
    os.environ.setdefault("WANDB_SILENT", "true")
    os.environ.setdefault("WANDB_BASE_URL", "https://api.forge.coreweave.com")
    if not os.environ.get("WANDB_API_KEY") or not os.environ.get("WANDB_ENTITY"):
        raise SystemExit("WANDB_API_KEY and WANDB_ENTITY are required.")
    try:
        result = publish(evidence, ROOT / "training/artifacts/next-publications", verify_only=args.verify)
    except Exception as error:
        raise SystemExit(f"Publication/readback failed: {type(error).__name__}. Inspect local receipts before retrying; no raw SDK error is printed.") from None
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
