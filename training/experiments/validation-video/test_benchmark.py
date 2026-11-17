import importlib.util
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location(
    "video_stress", Path(__file__).with_name("benchmark.py")
)
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


def test_metrics_handle_missing_and_hidden_masks_without_fake_center_errors():
    empty = np.zeros((180, 320), dtype=bool)
    visible = empty.copy()
    visible[40:80, 100:140] = True
    assert benchmark.score_mask(empty, empty)["iou"] == 1
    missing = benchmark.score_mask(empty, visible)
    assert missing["iou"] == 0
    assert missing["center_error_frame_diagonal"] is None
    assert missing["extent_error_max_normalized"] is None
    assert benchmark.score_mask(visible, empty)["bad_mask"] is True


def test_truth_marks_hidden_and_recovered_target():
    for case in ("occlusion-recovery", "boundary-exit-reentry"):
        rendered = [benchmark.render(case, i) for i in range(75)]
        assert rendered[0][1].any()
        assert any(not mask.any() for _, mask, _ in rendered)
        assert rendered[-1][1].any()


def test_texture_ablation_preserves_mask_and_changes_pixels():
    control, truth, _ = benchmark.render("textured-translation", 20)
    ablated, other, _ = benchmark.render("textureless-translation", 20)
    assert np.array_equal(truth, other)
    assert not np.array_equal(np.asarray(control), np.asarray(ablated))


def test_same_shape_crossing_never_adds_distractor_to_truth():
    _, visible, _ = benchmark.render("similar-object-crossing", 0)
    target = benchmark.silhouette(80, 94, 1)
    assert np.array_equal(visible, target)
    assert not visible[:, 220:].any()
