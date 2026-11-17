"""New benchmark publications preserve measured values and native input lineage."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "experiments/next/publish.py"
SPEC = importlib.util.spec_from_file_location("publish_next", SCRIPT)
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.dataset_path = self.directory / "scenes.jsonl"
        self.dataset_path.write_text('{"sceneId":"development-1"}\n')
        self.manifest_path = self.directory / "dataset.json"
        self.result_path = self.directory / "benchmark.json"
        self.manifest = {
            "schemaVersion": 1, "datasetId": "flowblock-scenes-v2", "version": "v1",
            "description": "Authored fixtures, not creator outcomes.",
            "files": [{"path": "scenes.jsonl", "sha256": publisher.sha256(self.dataset_path), "role": "scenes", "split": "development", "license": {"id": "MIT", "url": "https://opensource.org/license/mit", "redistributionAllowed": True}}],
            "metadata": {"kind": "authored-synthetic", "splitUnit": "scene family", "counts": {"scenes": 1}, "limitations": ["No creator outcomes."]},
        }
        self.result = {
            "schemaVersion": 1, "experimentId": "development-library-v2", "datasetManifestSha256": "", "status": "completed",
            "metrics": {"planner/feasible": 1, "planner/brief_preserved": 0},
            "rows": [{"taskId": "development-1-orbit", "arm": "library", "available": True, "feasible": True, "preservedBrief": False}],
            "metadata": {"runtimeVersion": "planner-v2", "checkerVersion": "checker-v2", "evaluationKind": "development", "limitations": ["Deterministic synthetic result only."]},
        }
        self.save()

    def save(self):
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.result["datasetManifestSha256"] = publisher.sha256(self.manifest_path)
        self.result_path.write_text(json.dumps(self.result))

    def load(self):
        return publisher.load_evidence(self.manifest_path, self.result_path)

    def test_content_ids_are_stable_and_change_with_measured_evidence(self):
        first = self.load()
        self.assertEqual(first, self.load())
        self.result["metrics"]["planner/brief_preserved"] = 1
        self.save()
        second = self.load()
        self.assertNotEqual(first["runId"], second["runId"])
        self.assertEqual(first["datasetRunId"], second["datasetRunId"])

    def test_cached_privacy_proof_is_bound_to_project_host_and_recent_verified_read(self):
        path = self.directory / "private-read.json"
        proof = {"mode": "read-only", "status": "verified-read", "privateProjectVerified": True, "sdkAuthenticated": True, "apiBase": "https://api.wandb.ai", "entity": "team", "project": "flowblock", "originalRun": {"entity": "team", "project": "flowblock"}, "startedAt": publisher.now()}
        path.write_text(json.dumps(proof))
        with patch.dict("os.environ", {"FLOWBLOCK_PRIVATE_PROJECT_PROOF": str(path)}):
            actual = publisher.cached_project_proof("team", "flowblock", "https://api.wandb.ai")
            self.assertEqual(actual["proofSha256"], publisher.sha256(path))
            for entity, project, host in (("other", "flowblock", "https://api.wandb.ai"), ("team", "other", "https://api.wandb.ai"), ("team", "flowblock", "https://api.forge.coreweave.com")):
                with self.assertRaisesRegex(ValueError, "exact private project"):
                    publisher.cached_project_proof(entity, project, host)
            proof["startedAt"] = "2020-01-01T00:00:00+00:00"
            path.write_text(json.dumps(proof))
            with self.assertRaisesRegex(ValueError, "15 minutes"):
                publisher.cached_project_proof("team", "flowblock", "https://api.wandb.ai")

    def test_dataset_only_has_no_invented_benchmark_and_keeps_same_artifact_identity(self):
        dataset = publisher.load_evidence(self.manifest_path)
        benchmark = self.load()
        self.assertIsNone(dataset["results"])
        self.assertIsNone(dataset["resultsPath"])
        self.assertEqual(dataset["runId"], dataset["datasetRunId"])
        self.assertEqual(dataset["datasetRunId"], benchmark["datasetRunId"])
        self.assertEqual(dataset["datasetArtifactName"], benchmark["datasetArtifactName"])

    def test_explicit_recovery_only_accepts_same_failed_producer_without_artifacts(self):
        evidence = publisher.load_evidence(self.manifest_path)
        run = SimpleNamespace(id=evidence["datasetRunId"], state="failed", config={"manifestSha256": evidence["manifestSha256"]}, logged_artifacts=lambda: [])
        publisher.validate_recovery_producer(run, evidence)
        for state in ("running", "finished"):
            run.state = state
            with self.assertRaisesRegex(ValueError, "interrupted"):
                publisher.validate_recovery_producer(run, evidence)
        run.state = "failed"
        run.logged_artifacts = lambda: [object()]
        with self.assertRaisesRegex(ValueError, "already has artifacts"):
            publisher.validate_recovery_producer(run, evidence)

    def test_explicit_recovery_rejects_changed_manifest_or_identity(self):
        evidence = publisher.load_evidence(self.manifest_path)
        run = SimpleNamespace(id="other-producer", state="failed", config={"manifestSha256": evidence["manifestSha256"]}, logged_artifacts=lambda: [])
        with self.assertRaisesRegex(ValueError, "identity"):
            publisher.validate_recovery_producer(run, evidence)
        run.id = evidence["datasetRunId"]
        run.config["manifestSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "manifest differs"):
            publisher.validate_recovery_producer(run, evidence)

    def test_rejects_data_changed_after_manifest_freeze(self):
        self.dataset_path.write_text("modified")
        with self.assertRaisesRegex(ValueError, "file hash differs"):
            self.load()

    def test_rejects_results_from_different_dataset(self):
        self.result["datasetManifestSha256"] = "0" * 64
        self.result_path.write_text(json.dumps(self.result))
        with self.assertRaisesRegex(ValueError, "different dataset"):
            self.load()

    def test_rejects_missing_redistribution_permission(self):
        self.manifest["files"][0]["license"]["redistributionAllowed"] = False
        self.save()
        with self.assertRaisesRegex(ValueError, "redistribution"):
            self.load()

    def test_rejects_raw_media_even_with_declared_license(self):
        path = self.directory / "clip.mp4"
        path.write_bytes(b"media")
        self.manifest["files"][0].update(path="clip.mp4", sha256=publisher.sha256(path))
        self.save()
        with self.assertRaisesRegex(ValueError, "media is excluded"):
            self.load()

    def test_rejects_path_escape_and_external_symlink(self):
        for path in ("../other.json", str(self.dataset_path)):
            self.manifest["files"][0]["path"] = path
            self.save()
            with self.assertRaisesRegex(ValueError, "inside the manifest"):
                self.load()
        with tempfile.TemporaryDirectory() as other:
            target = Path(other) / "external.json"
            target.write_text("{}")
            (self.directory / "link.json").symlink_to(target)
            self.manifest["files"][0].update(path="link.json", sha256=publisher.sha256(target))
            self.save()
            with self.assertRaisesRegex(ValueError, "inside the manifest"):
                self.load()

    def test_rejects_duplicate_file_and_reserved_manifest_path(self):
        self.manifest["files"].append(copy.deepcopy(self.manifest["files"][0]))
        self.save()
        with self.assertRaisesRegex(ValueError, "distinct"):
            self.load()

    def test_rejects_signed_source_url(self):
        self.manifest["files"][0]["sourceUrl"] = "https://example.com/labels?X-Amz-Signature=secret"
        self.save()
        with self.assertRaisesRegex(ValueError, "signed-URL"):
            self.load()

    def test_rejects_incomplete_and_nonfinite_or_target_metrics(self):
        self.result["status"] = "planned"
        self.save()
        with self.assertRaisesRegex(ValueError, "completed measured"):
            self.load()
        self.result["status"] = "completed"
        for value in (float("nan"), True, "1"):
            self.result["metrics"] = {"score": value}
            self.save()
            with self.assertRaises(ValueError):
                self.load()
        self.result["metrics"] = {"target/precision": 0.9}
        self.save()
        with self.assertRaisesRegex(ValueError, "not targets"):
            self.load()

    def test_rejects_arbitrary_or_nested_evidence_payloads(self):
        for row in ({"footage": "private"}, {"taskId": {"secret": "value"}}, {"note": "Bearer secret"}):
            self.result["rows"] = [row]
            self.save()
            with self.assertRaises(ValueError):
                self.load()

    def test_rejects_credentials_inside_listed_metadata_files(self):
        self.dataset_path.write_text('{"WANDB_API_KEY":"secret"}\n')
        self.manifest["files"][0]["sha256"] = publisher.sha256(self.dataset_path)
        self.save()
        with self.assertRaisesRegex(ValueError, "credential field"):
            self.load()

    def fake_artifact(self, name, kind, identity, files, metadata=None):
        return SimpleNamespace(name=name, type=kind, id=identity, digest="digest", metadata=metadata or {}, manifest=SimpleNamespace(entries={key: {} for key in files}), get_entry=lambda key: SimpleNamespace(download=lambda **kwargs: str(files[key])))

    def fake_runs(self):
        evidence = self.load()
        dataset = self.fake_artifact(evidence["datasetArtifactName"] + ":v0", "dataset", "dataset-id", {"manifest.json": self.manifest_path, "scenes.jsonl": self.dataset_path}, {"manifestSha256": evidence["manifestSha256"]})
        output = self.fake_artifact(evidence["resultsArtifactName"] + ":v0", "evaluation-results", "results-id", {"results.json": self.result_path})
        dataset_run = SimpleNamespace(state="finished", config={"manifestSha256": evidence["manifestSha256"]}, logged_artifacts=lambda: [dataset])
        metrics = copy.deepcopy(self.result["metrics"])
        benchmark_run = SimpleNamespace(state="finished", config={"evidenceSha256": evidence["evidenceSha256"], "datasetArtifactId": dataset.id}, summary={**metrics, "publication/row_count": 1}, scan_history=lambda **kwargs: [metrics], used_artifacts=lambda: [dataset], logged_artifacts=lambda: [output])
        return evidence, dataset_run, benchmark_run, dataset, output

    def test_reads_back_remote_bytes_metrics_and_dataset_input_edge(self):
        evidence, dataset_run, run, dataset, _ = self.fake_runs()
        actual, readback = publisher.verify_dataset(dataset_run, evidence, self.directory)
        self.assertEqual(actual.id, dataset.id)
        self.assertEqual(readback["verifiedFiles"], 2)
        result = publisher.verify_run(run, evidence, dataset, self.directory)
        self.assertEqual(result["metricCount"], 2)
        self.assertEqual(result["rowCount"], 1)

    def test_remote_metadata_is_not_sufficient_without_matching_file_bytes(self):
        evidence, dataset_run, _, _, _ = self.fake_runs()
        self.dataset_path.write_text("remote-file-mutated")
        with self.assertRaisesRegex(ValueError, "file hash differs"):
            publisher.verify_dataset(dataset_run, evidence, self.directory)

    def test_rejects_partial_or_extra_remote_artifact_files(self):
        evidence, dataset_run, _, dataset, _ = self.fake_runs()
        dataset.manifest.entries["unexpected.json"] = {}
        with self.assertRaisesRegex(ValueError, "membership"):
            publisher.verify_dataset(dataset_run, evidence, self.directory)

    def test_rejects_changed_remote_metric_history_and_summary(self):
        evidence, _, run, dataset, _ = self.fake_runs()
        run.summary["planner/feasible"] = 0
        with self.assertRaisesRegex(ValueError, "summary metric"):
            publisher.verify_run(run, evidence, dataset, self.directory)
        run.summary["planner/feasible"] = 1
        run.scan_history = lambda **kwargs: []
        with self.assertRaisesRegex(ValueError, "metric history"):
            publisher.verify_run(run, evidence, dataset, self.directory)

    def test_rejects_missing_input_edge_despite_config_reference(self):
        evidence, _, run, dataset, _ = self.fake_runs()
        run.used_artifacts = lambda: []
        with self.assertRaisesRegex(ValueError, "input lineage"):
            publisher.verify_run(run, evidence, dataset, self.directory)

    def test_rejects_unfinished_remote_run(self):
        evidence, _, run, dataset, _ = self.fake_runs()
        run.state = "running"
        with self.assertRaisesRegex(ValueError, "unfinished"):
            publisher.verify_run(run, evidence, dataset, self.directory)

    def test_result_artifact_bytes_are_required_beyond_summary_numbers(self):
        evidence, _, run, dataset, _ = self.fake_runs()
        self.result_path.write_text("changed")
        with self.assertRaisesRegex(ValueError, "file hash differs"):
            publisher.verify_run(run, evidence, dataset, self.directory)


if __name__ == "__main__":
    unittest.main()
