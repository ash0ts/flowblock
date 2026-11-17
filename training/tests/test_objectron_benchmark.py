"""Checks for coordinate and label semantics in the Objectron diagnostic."""

import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    "objectron_benchmark",
    Path(__file__).resolve().parents[1] / "experiments/next/objectron_benchmark.py",
)
benchmark = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(benchmark)


class ObjectronDiagnosticTest(unittest.TestCase):
    def test_prompt_clipping_does_not_change_reference(self):
        reference = {"x": -0.2, "y": 0.1, "width": 0.6, "height": 1.2}
        prompt = benchmark.prompt_box(reference)
        self.assertEqual(reference["x"], -0.2)
        self.assertEqual(prompt["x"], 0)
        self.assertAlmostEqual(prompt["width"], 0.4)
        self.assertAlmostEqual(prompt["height"], 0.9)
        with self.assertRaises(ValueError):
            benchmark.prompt_box({"x": 1.2, "y": 0.1, "width": 0.1, "height": 0.1})

    def test_discrepancy_uses_physical_frame_diagonal_and_projected_center(self):
        track = {"center": {"x": 0.5, "y": 0.5}, "box": {"width": 0.2, "height": 0.3}}
        reference = {
            "center": {"x": 0.6, "y": 0.5},
            "box": {"x": 0.3, "y": 0.2, "width": 0.4, "height": 0.6},
        }
        metrics = benchmark.proxy_metrics(track, reference, 300, 400)
        self.assertAlmostEqual(
            metrics["mask_centroid_to_projected_3d_center_frame_diagonal_discrepancy"],
            0.06,
        )
        self.assertTrue(metrics["mask_center_inside_projected_box"])
        self.assertAlmostEqual(metrics["mask_width_to_projected_box_width_ratio"], 0.5)
        self.assertIsNone(
            benchmark.proxy_metrics({"center": None}, reference, 300, 400)
        )

    def test_original_timestamp_mapping_preserves_irregular_intervals(self):
        timestamps = [0.0, 0.02, 0.08, 0.13]
        self.assertEqual(benchmark.nearest_index(timestamps, 0.0667), 2)
        self.assertEqual(benchmark.nearest_index(timestamps, 0.14), 3)
        self.assertEqual(benchmark.nearest_index(timestamps, 0.0), 0)

    def test_projection_requires_full_positive_depth_cuboid(self):
        corners = [
            {"id": i, "x": i % 2, "y": (i // 2) % 2, "depth_m": 1} for i in range(1, 9)
        ]
        box = benchmark.projected_box(corners)
        self.assertEqual(box, {"x": 0, "y": 0, "width": 1, "height": 1})
        corners[-1]["depth_m"] = -1
        with self.assertRaises(ValueError):
            benchmark.projected_box(corners)


if __name__ == "__main__":
    unittest.main()
