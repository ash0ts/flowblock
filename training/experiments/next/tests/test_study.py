"""Synthetic unit fixtures only; these are not creator-study observations."""
import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("flowblock_study", Path(__file__).parents[1] / "study.py")
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)


def fixture():
    data = {table: [] for table in study.TABLES}
    data["creators"] = [{"creator_id": "synthetic-test", "experience_band": "beginner", "device_class": "phone", "consent_study": "true", "consent_training": "false"}]
    data["assignments"] = [{"assignment_id": "assignment", "creator_id": "synthetic-test", "arm": "flowblock-practice", "brief_id": "test-brief", "product_id": "test-product", "order_index": "1", "session_start_utc": "2026-10-29T00:00:00Z", "session_start_monotonic": "100", "session_cap_seconds": "100", "session_end_monotonic": "200", "abandoned_reason": ""}]
    for index, end in [(1, 140), (2, 175)]:
        data["attempts"].append({"attempt_id": f"take-{index}", "assignment_id": "assignment", "rating_id": f"blind-{index}", "plan_version": "test-plan", "record_start_monotonic": str(end-8), "record_end_monotonic": str(end), "original_sha256": str(index)*64})
        for reviewer in ["r1", "r2"]:
            data["ratings"].append({"rating_id": f"blind-{index}", "reviewer_id": reviewer, "role": "independent", "usable": "true", "reason": "Synthetic unit fixture"})
    return data


class StudyCollectionTests(unittest.TestCase):
    def test_earliest_usable_capture_includes_planning_time(self):
        result = study.score(fixture())
        self.assertEqual(result["records"][0]["first_usable_attempt"], "take-1")
        self.assertEqual(result["records"][0]["time_seconds"], 40)
        self.assertTrue(result["records"][0]["event"])

    def test_no_usable_take_is_censored_not_dropped(self):
        data = fixture()
        for row in data["ratings"]:
            row["usable"] = "false"
        record = study.score(data)["records"][0]
        self.assertFalse(record["event"])
        self.assertEqual(record["time_seconds"], 100)

    def test_unreviewed_earlier_take_keeps_entire_assignment_incomplete(self):
        data = fixture()
        data["ratings"] = [row for row in data["ratings"] if row["rating_id"] != "blind-1"]
        result = study.score(data)
        self.assertEqual(result["records"][0]["status"], "incomplete")
        self.assertIsNone(result["records"][0]["event"])

    def test_disagreement_requires_a_different_adjudicator(self):
        data = fixture()
        data["ratings"][0]["usable"] = "false"
        self.assertEqual(study.score(data)["records"][0]["status"], "incomplete")
        data["ratings"].append({"rating_id": "blind-1", "reviewer_id": "adjudicator", "role": "adjudicator", "usable": "true", "reason": "Synthetic adjudication"})
        self.assertEqual(study.score(data)["records"][0]["time_seconds"], 40)
        data["ratings"][-1]["reviewer_id"] = "r1"
        with self.assertRaises(ValueError):
            study.score(data)

    def test_control_arm_cannot_receive_a_correction(self):
        data = fixture()
        data["events"] = [{"event_id": "event", "assignment_id": "assignment", "attempt_id": "take-1", "kind": "review", "start_monotonic": "145", "end_monotonic": "150", "analysis_version": "test", "finding_ids": "test", "correction_shown": "true", "correction_accepted": "false", "reason": "Synthetic fixture"}]
        with self.assertRaisesRegex(ValueError, "withheld"):
            study.validate(data)

    def test_missing_consent_and_cross_arm_creators_are_rejected(self):
        data = fixture()
        data["creators"][0]["consent_study"] = "false"
        with self.assertRaises(ValueError):
            study.validate(data)
        data = fixture()
        next_assignment = copy.deepcopy(data["assignments"][0])
        next_assignment.update(assignment_id="other", order_index="2", arm="flowblock-feedback")
        data["assignments"].append(next_assignment)
        with self.assertRaisesRegex(ValueError, "one arm"):
            study.validate(data)

    def test_empty_collection_is_not_a_zero_success_human_experiment(self):
        result = study.score({table: [] for table in study.TABLES})
        self.assertEqual(result["status"], "empty-collection")
        self.assertTrue(all(row["usable_fraction_scored"] is None for row in result["arms"]))


if __name__ == "__main__":
    unittest.main()
