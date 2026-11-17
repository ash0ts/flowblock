"""SFT gates bind the one authorized job to verified train-only data."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "experiments/next/train.py"
SPEC = importlib.util.spec_from_file_location("train_next", SCRIPT)
training = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(training)


class TrainingEvidenceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.source = self.directory / "train.jsonl"
        self.row = {"messages": [{"role": "system", "content": "Typed planner actions."}, {"role": "user", "content": "A synthetic room."}, {"role": "assistant", "content": '{"action":"compile_candidate","recipeId":"hold-hero"}'}]}
        self.source.write_text(json.dumps(self.row) + "\n")
        self.manifest_path, self.protocol_path, self.receipt_path = [self.directory / name for name in ("manifest.json", "protocol.json", "publication.json")]
        self.manifest = {"schemaVersion": 1, "datasetId": "train-scenes-v2", "version": "v1", "description": "Authored train fixtures.", "files": [{"path": "train.jsonl", "role": "training_actions", "split": "train", "sha256": training.sha256(self.source), "license": {"id": "MIT", "url": "https://opensource.org/license/mit", "redistributionAllowed": True}}], "metadata": {"kind": "authored-synthetic"}}
        self.protocol = {"schemaVersion": 1, "experimentId": "flowblock-test-v2", "trainManifestSha256": "", "trainSourceSha256": "", "sourceHashes": {str(SCRIPT.relative_to(training.ROOT)): training.sha256(SCRIPT)}, "settings": copy.deepcopy(training.SETTINGS), "budget": {"authorizedUsd": 200, "maxRuns": 1, "maxExamples": 1600}, "checkpointSelection": "final-single-run"}
        self.receipt = {"status": "verified", "manifestSha256": "", "datasetArtifact": "team/project/train-scenes-v2-v1:v0", "dataset": {"id": "dataset-id", "digest": "digest"}}
        self.save()

    def save(self):
        self.manifest["files"][0]["sha256"] = training.sha256(self.source)
        self.manifest_path.write_text(json.dumps(self.manifest))
        self.protocol["trainManifestSha256"] = training.sha256(self.manifest_path)
        self.protocol["trainSourceSha256"] = training.sha256(self.source)
        self.receipt["manifestSha256"] = training.sha256(self.manifest_path)
        self.protocol_path.write_text(json.dumps(self.protocol))
        self.receipt_path.write_text(json.dumps(self.receipt))

    def load(self):
        return training.load_training(self.manifest_path, self.source, self.receipt_path, self.protocol_path)

    def test_verified_train_only_source_yields_durable_identity_without_importing_provider(self):
        evidence = self.load()
        self.assertEqual(evidence["rowCount"], 1)
        self.assertEqual(evidence["attempt"], "flowblock-test-v2-sft")
        self.assertEqual(evidence["datasetArtifactId"], "dataset-id")

    def test_rejects_confirmation_or_undeclared_split_in_training_artifact(self):
        for split in ("confirmation", "development", None):
            if split is None:
                self.manifest["files"][0].pop("split")
            else:
                self.manifest["files"][0]["split"] = split
            self.save()
            with self.assertRaisesRegex(ValueError, "only explicitly train"):
                self.load()

    def test_rejects_source_not_marked_training_actions(self):
        self.manifest["files"][0]["role"] = "metadata"
        self.save()
        with self.assertRaisesRegex(ValueError, "training_actions"):
            self.load()

    def test_rejects_partial_or_alias_dataset_publication(self):
        for change in ({"status": "publishing"}, {"datasetArtifact": "team/project/data:latest"}, {"manifestSha256": "0" * 64}):
            original = copy.deepcopy(self.receipt)
            self.receipt.update(change)
            self.receipt_path.write_text(json.dumps(self.receipt))
            with self.assertRaises(ValueError):
                self.load()
            self.receipt = original

    def test_rejects_budget_expansion_or_more_than_one_epoch(self):
        for key, value in (("authorizedUsd", 201), ("maxRuns", 2), ("maxExamples", 1601), ("maxRuns", True)):
            old = self.protocol["budget"][key]
            self.protocol["budget"][key] = value
            self.save()
            with self.assertRaisesRegex(ValueError, "Budget"):
                self.load()
            self.protocol["budget"][key] = old
        self.protocol["settings"]["epochs"] = 2
        self.save()
        with self.assertRaisesRegex(ValueError, "Training settings"):
            self.load()

    def test_rejects_changed_protocol_source_hash(self):
        self.protocol["sourceHashes"][str(SCRIPT.relative_to(training.ROOT))] = "0" * 64
        self.save()
        with self.assertRaisesRegex(ValueError, "Runtime source differs"):
            self.load()

    def test_rejects_manifest_or_training_hash_drift(self):
        self.protocol["trainSourceSha256"] = "0" * 64
        self.protocol_path.write_text(json.dumps(self.protocol))
        with self.assertRaisesRegex(ValueError, "frozen protocol"):
            self.load()

    def test_rejects_non_action_or_non_assistant_target(self):
        self.row["messages"][-1]["content"] = "A good shot."
        self.source.write_text(json.dumps(self.row) + "\n")
        self.save()
        with self.assertRaises(ValueError):
            self.load()
        self.row["messages"][-1] = {"role": "user", "content": "More input"}
        self.source.write_text(json.dumps(self.row) + "\n")
        self.save()
        with self.assertRaisesRegex(ValueError, "end in an assistant"):
            self.load()

    def test_rejects_more_than_authorized_examples(self):
        self.source.write_text((json.dumps(self.row) + "\n") * 1601)
        self.save()
        with self.assertRaisesRegex(ValueError, "1,600 examples"):
            self.load()

    def test_derived_shuffle_and_serialization_preserve_semantics_and_multiplicity(self):
        second = copy.deepcopy(self.row)
        second["messages"][-1]["content"] = '{"action":"finish","candidateIds":["plan-id"],"explanation":"A checked plan."}'
        derived = self.directory / "derived.jsonl"
        derived.write_text(json.dumps(second, separators=(",", ":")) + "\n" + json.dumps(self.row) + "\n")
        result = training.verify_derived_rows([self.row, second], derived)
        self.assertEqual(result["rows"], 2)
        derived.write_text((json.dumps(self.row) + "\n") * 2)
        with self.assertRaisesRegex(ValueError, "differ from the frozen"):
            training.verify_derived_rows([self.row, second], derived)

    def prior_registration(self, evidence):
        prior = {"status": "stopped-before-training", "registrationSubmitted": True, "trainingSubmitted": False,
                 "experimentId": evidence["experimentId"], "attempt": evidence["attempt"],
                 "manifestSha256": evidence["dataset"]["manifestSha256"], "sourceSha256": evidence["sourceSha256"],
                 "datasetArtifact": evidence["datasetArtifact"], "datasetArtifactId": evidence["datasetArtifactId"],
                 "datasetArtifactDigest": evidence["datasetArtifactDigest"], "settings": copy.deepcopy(training.SETTINGS),
                 "budget": copy.deepcopy(evidence["protocol"]["budget"]), "rows": evidence["rowCount"],
                 "trainingBaseUrl": "https://forge.coreweave.com/api/training/v1", "protocolSha256": "a" * 64, "adapterSha256": "b" * 64}
        path = self.directory / "original-attempt.json"
        path.write_text(json.dumps(prior))
        return prior, path

    def test_registration_recovery_preserves_prior_receipt_and_data_identity(self):
        evidence = self.load()
        prior, path = self.prior_registration(evidence)
        original = path.read_bytes()
        result = training.registration_recovery(evidence, path)
        self.assertEqual(result["receiptSha256"], training.sha256(path))
        self.assertEqual(result["priorProtocolSha256"], prior["protocolSha256"])
        self.assertEqual(result["registrationMode"], "same-name-return-existing")
        self.assertFalse(result["trainingPreviouslySubmitted"])
        self.assertEqual(path.read_bytes(), original)

    def test_registration_recovery_rejects_possible_paid_submission(self):
        evidence = self.load()
        prior, path = self.prior_registration(evidence)
        for change in ({"trainingSubmitted": True}, {"trainingSubmitted": None}, {"trainingJobId": "job"}, {"registrationSubmitted": False}, {"status": "submitted-outcome-unknown"}):
            path.write_text(json.dumps({**prior, **change}))
            with self.assertRaisesRegex(ValueError, "no training POST"):
                training.registration_recovery(evidence, path)

    def test_registration_recovery_rejects_identity_data_settings_or_endpoint_changes(self):
        evidence = self.load()
        prior, path = self.prior_registration(evidence)
        for change in ({"attempt": "another-model"}, {"sourceSha256": "c" * 64}, {"datasetArtifactId": "another-id"},
                       {"rows": 2}, {"settings": {**training.SETTINGS, "epochs": 2}}, {"budget": {"authorizedUsd": 100}},
                       {"trainingBaseUrl": "https://another.example"}):
            path.write_text(json.dumps({**prior, **change}))
            with self.assertRaisesRegex(ValueError, "preserve model identity"):
                training.registration_recovery(evidence, path)
        path.write_text(json.dumps({**prior, "protocolSha256": None}))
        with self.assertRaisesRegex(ValueError, "original protocol"):
            training.registration_recovery(evidence, path)


class TrainingReadbackTests(unittest.TestCase):
    def test_requires_completion_event_and_positive_checkpoint(self):
        ended = [{"type": "training_ended", "data": {}}]
        self.assertEqual(training.summarize_readback(ended, [{"id": "zero", "step": 0}], {})["status"], "pending")
        self.assertEqual(training.summarize_readback([], [{"id": "positive", "step": 1}], {})["status"], "pending")
        result = training.summarize_readback(ended, [{"id": "positive", "step": 1}], {"status": "completed"})
        self.assertEqual(result["status"], "trained")

    def test_failed_remote_job_is_not_recovered_as_success_from_checkpoint(self):
        result = training.summarize_readback([{"type": "training_failed", "data": {}}], [{"id": "positive", "step": 1}], {})
        self.assertEqual(result["status"], "failed")
        self.assertIsNone(result["checkpoint"])

    def test_conflicting_terminal_evidence_requires_review(self):
        with self.assertRaisesRegex(ValueError, "disagree"):
            training.summarize_readback([{"type": "training_ended", "data": {}}], [{"id": "positive", "step": 1}], {"status": "failed"})


class TrainingSdkReadbackTests(unittest.IsolatedAsyncioTestCase):
    async def test_job_response_uses_mapping_type_accepted_by_pinned_sdk(self):
        from openai._models import construct_type
        from types import SimpleNamespace
        job = {"id": "job-1", "model_id": "model-1", "status": "COMPLETED"}

        async def records(items):
            for item in items:
                yield SimpleNamespace(model_dump=lambda item=item: item)

        class Client:
            def __init__(self, **kwargs):
                self.sft_training_jobs = SimpleNamespace(events=SimpleNamespace(list=lambda **kwargs: records([
                    {"id": "gradient-1", "type": "gradient_step", "data": {"loss": 0.4}},
                    {"id": "ended-1", "type": "training_ended", "data": {}},
                ])))
                self.models = SimpleNamespace(checkpoints=SimpleNamespace(list=lambda **kwargs: records([
                    {"id": "checkpoint-1", "step": 1, "artifact_name": "attempt-1"},
                ])))

            async def get(self, url, *, cast_to):
                return construct_type(value=job, type_=cast_to)

            async def close(self):
                pass

        receipt = {"trainingBaseUrl": "https://example.test", "trainingJobId": "job-1", "modelId": "model-1", "rows": 8,
                   "attempt": "attempt-1", "datasetArtifact": "team/project/data:v0", "protocolSha256": "a" * 64,
                   "manifestSha256": "b" * 64, "sourceSha256": "c" * 64, "settings": training.SETTINGS, "runId": "run-1", "runUrl": "https://example.test/run-1"}
        with tempfile.TemporaryDirectory(dir=training.ROOT / "training/artifacts") as directory, patch("art.serverless.client.Client", Client):
            result = await training.readback(receipt, Path(directory))
        self.assertEqual(result["job"], job)
        self.assertEqual(result["gradientUpdates"], 1)
        self.assertEqual(result["status"], "trained")
        self.assertEqual(result["inferenceModel"], "wandb-artifact:///team/project/attempt-1:step1")


if __name__ == "__main__":
    unittest.main()
