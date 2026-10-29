import numpy as np
import pytest

from flowblock_worker.model import describe_mask
from flowblock_worker.measurement import annotate_tracks
from flowblock_worker.storage import ObjectStore, validate_key


@pytest.mark.parametrize(
    "key",
    [
        "../secret",
        "a/../../secret",
        "/etc/passwd",
        "https://example.com/video",
        "a//b",
        "a/./b",
        "a\\b",
    ],
)
def test_object_keys_reject_urls_and_path_traversal(key):
    with pytest.raises(ValueError):
        validate_key(key)


def test_symlink_cannot_escape_private_storage(tmp_path, monkeypatch):
    root = tmp_path / "private"
    root.mkdir()
    (root / "escape").symlink_to(tmp_path)
    monkeypatch.setenv("FLOWBLOCK_STORAGE_DIR", str(root))
    store = ObjectStore()
    with pytest.raises(ValueError):
        store.local_path("escape/secret")


def test_mask_measurement_uses_pixel_centers_and_normalized_extents():
    logits = np.full((100, 200), -10, dtype=np.float32)
    logits[20:60, 50:90] = 10
    result = describe_mask(logits, 200, 100)
    assert result["box"] == {"x": 0.25, "y": 0.2, "width": 0.2, "height": 0.4}
    assert result["center"] == {"x": 0.35, "y": 0.4}
    assert result["maskArea"] == 0.08
    assert result["boundary"]
    assert not result["touchesBorder"]


def test_empty_and_weak_masks_are_distinct():
    empty = describe_mask(np.full((10, 10), -1), 10, 10)
    assert empty["box"] is None
    weak = describe_mask(np.full((10, 10), 0.2), 10, 10)
    assert weak["box"] is not None
    assert "weak-mask-logits" in weak["uncertaintyReasons"]


@pytest.mark.parametrize("value", [np.nan, np.inf, -np.inf])
def test_nonfinite_model_output_is_uncertain_even_when_a_mask_exists(value):
    logits = np.full((100, 100), -10.0)
    logits[30:60, 30:60] = 10
    logits[40, 40] = value
    result = describe_mask(logits, 100, 100)
    assert result["box"] is not None
    frames = annotate_tracks(
        [{**result, "timestamp": 0}],
        {"expectedVisible": {"startSeconds": 0, "endSeconds": 5}},
    )
    assert frames[0]["visibility"] == "uncertain"
    assert "non-finite-mask-logits" in frames[0]["uncertaintyReasons"]
