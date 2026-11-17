"""Recorded-outcome diagnostics must not reconstruct missing model successes."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SOURCE = Path(__file__).parents[1] / "experiments/next/diagnose-development.py"
spec = importlib.util.spec_from_file_location("recorded_diagnostics", SOURCE)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RecordedDiagnosticsTests(unittest.TestCase):
    def fixture(self, directory):
        task = {"id": "example", "sceneGroup": "group", "briefSpec": {"family": "hold"}}
        grade = {
            "productive": False, "planGrades": [], "knownFeasible": True,
            "falseAbstention": False, "emptyFinish": False,
            "unsupportedAbstention": False, "boundedEmpty": False,
            "uncheckedEmpty": False,
        }
        entry = {
            "taskId": "example", "available": True, "attempted": True,
            "status": "actor-failure", "termination": "fallback", "grade": grade,
        }
        action = {"action": "compile_candidate", "recipeId": "hero-hold"}
        raw = {
            "taskId": "example", "task": task, "entry": entry,
            "calls": [{"index": 0, "response": {"content": json.dumps(action)}},
                      {"index": 1, "response": {"content": "unlogged reply"}}],
            "result": {
                "plans": [{"id": "fallback-plan"}], "message": "fallback",
                "events": [{"action": action, "observation": {
                    "validation": {"valid": True, "violations": []},
                }}],
            },
        }
        (directory / "tasks.json").write_text(json.dumps([task]))
        manifest = {
            "split": "development", "taskFile": "tasks.json",
            "tasksSha256": module.digest(directory / "tasks.json"),
            "taskIds": ["example"], "attemptId": "one-offline-attempt",
            "arm": "gpt-oss", "model": "example", "checkerVersion": "frozen",
            "runtimeVersion": "frozen", "sourceHashes": {},
        }
        (directory / "manifest.json").write_text(json.dumps(manifest))
        (directory / "results.jsonl").write_text(json.dumps(entry) + "\n")
        (directory / "example.json").write_text(json.dumps(raw))
        (directory / "summary.json").write_text(json.dumps({"productive": 0}))

    def test_missing_events_and_valid_fallback_do_not_become_model_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.fixture(directory)
            result = module.diagnose(directory, directory / "diagnostic.json")
            self.assertEqual(result["outcomes"]["productiveAmongAvailable"]["count"], 0)
            self.assertEqual(result["outcomes"]["returnedPlans"], 0)
            self.assertEqual(result["outcomes"]["fallbackLibraryPlansExcludedFromModelCredit"], 1)
            self.assertEqual(result["tools"]["validCompiles"]["count"], 1)
            self.assertEqual(result["tools"]["providerCallMinusEventCount"], 1)
            self.assertEqual(result["tools"]["recordedSchemaInvalidReplies"]["count"], 0)
            text = module.markdown(result)
            self.assertIn("0/1 available tasks", text)
            self.assertIn("cannot assign those missing event observations", text)
            self.assertIn("excluded from model-success credit", text)
            self.assertNotIn("283 provider", text)

    def test_source_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.fixture(directory)
            path = directory / "example.json"
            raw = json.loads(path.read_text())
            raw["entry"]["grade"]["productive"] = True
            path.write_text(json.dumps(raw))
            with self.assertRaisesRegex(ValueError, "Raw receipt disagrees"):
                module.diagnose(directory, directory / "diagnostic.json")

    def test_confirmation_is_not_reclassified_as_development(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            self.fixture(directory)
            path = directory / "manifest.json"
            manifest = json.loads(path.read_text())
            manifest["split"] = "confirmation"
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "limited to development"):
                module.diagnose(directory, directory / "diagnostic.json")


if __name__ == "__main__":
    unittest.main()
