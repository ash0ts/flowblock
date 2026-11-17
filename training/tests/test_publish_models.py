"""Recorded telemetry publication preserves evidence and refuses ambiguous data."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / "publish-models.py"
SPEC = importlib.util.spec_from_file_location("publish_models", SCRIPT)
publisher = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(publisher)


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ["results/training-receipt.json", "results/training-readback.json", "frozen/manifest.json", "frozen/train.jsonl"]:
            destination = self.root / "training" / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(SCRIPT.parent / name, destination)

    def alter_readback(self, change):
        path = self.root / "training/results/training-readback.json"
        readback = json.loads(path.read_text())
        change(readback)
        path.write_text(json.dumps(readback))
        receipt_path = self.root / "training/results/training-receipt.json"
        receipt = json.loads(receipt_path.read_text())
        receipt["readbackSha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        receipt_path.write_text(json.dumps(receipt))

    def test_real_receipts_produce_all_original_updates_and_stable_identity(self):
        evidence = publisher.load_evidence(self.root)
        self.assertEqual(evidence, publisher.load_evidence(self.root))
        self.assertEqual(len(evidence["history"]), 30)
        self.assertEqual(evidence["history"][0]["train/loss"], 2.08699581772089)
        self.assertEqual(evidence["history"][-1]["train/loss"], 0.09211441418301547)
        self.assertEqual(evidence["summary"]["training/processed_tokens"], 368623)
        self.assertNotIn("error", evidence)
        self.assertNotIn("messages", evidence)

    def test_rejects_changed_training_data(self):
        with (self.root / "training/frozen/train.jsonl").open("a") as stream:
            stream.write("\n")
        with self.assertRaisesRegex(ValueError, "dataset differs"):
            publisher.load_evidence(self.root)

    def test_rejects_changed_unverified_readback(self):
        path = self.root / "training/results/training-readback.json"
        path.write_text(path.read_text() + "\n")
        with self.assertRaisesRegex(ValueError, "differs from its verified receipt"):
            publisher.load_evidence(self.root)

    def test_rejects_duplicate_optimizer_steps(self):
        self.alter_readback(lambda value: value["events"][2]["data"].update(gradient_step=1))
        with self.assertRaisesRegex(ValueError, "unique, contiguous"):
            publisher.load_evidence(self.root)

    def test_rejects_nonfinite_loss(self):
        self.alter_readback(lambda value: value["events"][1]["data"].update(loss=float("nan")))
        with self.assertRaisesRegex(ValueError, "finite numbers"):
            publisher.load_evidence(self.root)

    def test_rejects_different_checkpoint(self):
        self.alter_readback(lambda value: value["checkpoints"][0].update(artifact_name="other-model"))
        with self.assertRaisesRegex(ValueError, "different model artifact"):
            publisher.load_evidence(self.root)

    def test_rejects_missing_completion_event(self):
        self.alter_readback(lambda value: value.update(events=[event for event in value["events"] if event["type"] != "training_ended"]))
        with self.assertRaisesRegex(ValueError, "completion event"):
            publisher.load_evidence(self.root)


class ReadbackTests(unittest.TestCase):
    def setUp(self):
        self.evidence = publisher.load_evidence()
        artifact = lambda name, identity: SimpleNamespace(name=name, id=identity, digest="digest", metadata={"datasetSha256": self.evidence["sourceHashes"]["dataset"]})
        self.run = SimpleNamespace(
            config={"evidenceSha256": self.evidence["evidenceSha256"], "inputArtifactIds": {"checkpointArtifact": "checkpoint"}},
            summary=self.evidence["summary"], state="finished",
            scan_history=lambda **kwargs: copy.deepcopy(self.evidence["history"]),
            used_artifacts=lambda: [artifact("checkpoint:v1", "checkpoint")],
            logged_artifacts=lambda: [artifact(f"{self.evidence['runId']}-evidence:v0", "evidence"), artifact(f"{self.evidence['runId']}-dataset:v0", "dataset")],
        )

    def test_reads_back_every_metric_checkpoint_input_and_recovered_outputs(self):
        result = publisher.verify_run(self.run, self.evidence)
        self.assertEqual(result["rows"], 30)
        self.assertEqual(len(result["usedArtifacts"]), 1)
        self.assertEqual(len(result["loggedArtifacts"]), 2)

    def test_rejects_partial_remote_history(self):
        self.run.scan_history = lambda **kwargs: self.evidence["history"][:-1]
        with self.assertRaisesRegex(ValueError, "29 rows"):
            publisher.verify_run(self.run, self.evidence)

    def test_rejects_mutated_remote_metric(self):
        history = copy.deepcopy(self.evidence["history"])
        history[10]["train/loss"] += 0.1
        self.run.scan_history = lambda **kwargs: history
        with self.assertRaisesRegex(ValueError, "differs at optimizer step 11"):
            publisher.verify_run(self.run, self.evidence)

    def test_rejects_missing_artifact_lineage(self):
        self.run.used_artifacts = lambda: []
        with self.assertRaisesRegex(ValueError, "lineage is missing"):
            publisher.verify_run(self.run, self.evidence)

    def test_rejects_missing_recovered_dataset(self):
        self.run.logged_artifacts = lambda: [SimpleNamespace(name=f"{self.evidence['runId']}-evidence:v0", id="evidence", digest="digest")]
        with self.assertRaisesRegex(ValueError, "recovered-dataset artifact"):
            publisher.verify_run(self.run, self.evidence)


if __name__ == "__main__":
    unittest.main()
