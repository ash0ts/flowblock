"""Synthetic measurements exercise rules, not model accuracy on real footage."""

import math

import pytest

from flowblock_worker.measurement import (
    annotate_tracks,
    assess,
    target_at,
    validate_box,
    validate_manifest,
)


@pytest.fixture
def manifest():
    return {
        "seed": {"timeSeconds": 0, "box": {"x": 0.4, "y": 0.3, "width": 0.2, "height": 0.4}},
        "expectedVisible": {"startSeconds": 0, "endSeconds": 5},
        "targetKeyframes": [
            {"timeSeconds": 0, "centerX": 0.5, "centerY": 0.5, "width": 0.2, "height": 0.4},
            {"timeSeconds": 5, "centerX": 0.5, "centerY": 0.5, "width": 0.2, "height": 0.4},
        ],
    }


def track(index, x=0.5, box=None, reasons=None):
    return {
        "frameIndex": index,
        "timestamp": index / 15,
        "proxyTimestamp": index / 15,
        "box": box or {"x": x - 0.1, "y": 0.3, "width": 0.2, "height": 0.4},
        "center": {"x": x, "y": 0.5},
        "boundary": [],
        "maskArea": 0.08,
        "touchesBorder": False,
        "uncertaintyReasons": reasons or [],
    }


def test_missing_masks_are_not_interpolated_or_judged(manifest):
    frames = [{**track(i), "box": None, "center": None} for i in range(75)]
    result = assess(frames, manifest, 5)
    assert result["coverage"]["measuredFraction"] == 0
    assert result["coverage"]["needsReview"]
    assert result["findings"] == []
    assert all(t["visibility"] == "missing" and t["box"] is None for t in result["tracks"])


def test_uncertain_masks_excluded_from_findings(manifest):
    frames = [track(i, x=0.8, reasons=["fragmented-mask"]) for i in range(75)]
    result = assess(frames, manifest, 5)
    assert result["coverage"]["uncertainFrames"] == 75
    assert result["findings"] == []


def test_intentional_hidden_interval_does_not_reduce_coverage(manifest):
    manifest["expectedVisible"] = {"startSeconds": 1, "endSeconds": 3}
    frames = [
        track(i) if 15 <= i <= 45 else {**track(i), "box": None, "center": None} for i in range(75)
    ]
    result = assess(frames, manifest, 5)
    assert result["coverage"]["measuredFraction"] == 1
    assert result["coverage"]["intentionallyHiddenFrames"] == 44
    assert result["coverage"]["missingFrames"] == 0


def test_abrupt_mask_change_is_uncertain(manifest):
    result = annotate_tracks([track(0), track(1, x=0.9)], manifest)
    assert result[1]["visibility"] == "uncertain"
    assert "abrupt-center-change" in result[1]["uncertaintyReasons"]


def test_interpolation_clamps_to_explicit_keyframes(manifest):
    manifest["targetKeyframes"][1].update(centerX=0.7, width=0.4)
    middle = target_at(manifest, 2.5, 5)
    assert middle["centerX"] == pytest.approx(0.6)
    assert middle["width"] == pytest.approx(0.3)
    assert target_at(manifest, 8, 5)["width"] == 0.4
    assert target_at(manifest, -1, 5)["width"] == 0.2


def test_findings_have_phase_and_evidence_and_maximum_two(manifest):
    frames = [{**track(i, x=0.85), "touchesBorder": True} for i in range(75)]
    result = assess(frames, manifest, 5)
    assert len(result["findings"]) == 2
    assert all(
        f["phase"] in ("opening", "middle", "ending") and f["evidenceTimestamps"]
        for f in result["findings"]
    )
    assert all("confidence" not in f for f in result["findings"])


def test_single_frame_drift_does_not_produce_finding(manifest):
    frames = [track(i, x=0.6 if i == 10 else 0.5) for i in range(75)]
    assert assess(frames, manifest, 5)["findings"] == []


def test_duration_difference_is_explicit_not_inferred_speed(manifest):
    manifest["plannedDurationSeconds"] = 8
    result = assess([track(i) for i in range(75)], manifest, 5)
    assert result["findings"][0]["kind"] == "duration"
    assert "5.00s" in result["findings"][0]["detail"]
    assert result["findings"][0]["measurement"]["delta"] == -3


def test_size_measurement_preserves_direction_and_actual_value(manifest):
    frames = [track(i, box={"x": 0.45, "y": 0.4, "width": 0.1, "height": 0.2}) for i in range(75)]
    findings = assess(frames, manifest, 5)["findings"]
    assert findings[0]["kind"] == "size"
    assert findings[0]["measurement"]["observed"] == pytest.approx(0.5)
    assert findings[0]["measurement"]["target"] == 1
    assert findings[0]["measurement"]["delta"] == pytest.approx(-0.5)
    assert "0.50 times" in findings[0]["detail"]


@pytest.mark.parametrize("bad", [math.nan, math.inf, -math.inf, True, "0.2"])
def test_nonfinite_or_non_numeric_prompt_rejected(bad):
    with pytest.raises(ValueError):
        validate_box({"x": bad, "y": 0, "width": 0.2, "height": 0.2})


@pytest.mark.parametrize(
    "box",
    [
        {"x": -0.1, "y": 0, "width": 0.2, "height": 0.2},
        {"x": 0.9, "y": 0, "width": 0.2, "height": 0.2},
        {"x": 0, "y": 0, "width": 0, "height": 0.2},
    ],
)
def test_out_of_bounds_or_empty_prompt_rejected(box):
    with pytest.raises(ValueError):
        validate_box(box)


def test_seed_must_be_within_clip_and_expected_interval(manifest):
    manifest["seed"]["timeSeconds"] = 6
    with pytest.raises(ValueError):
        validate_manifest(manifest, 5)


def test_target_keys_must_be_monotonic(manifest):
    manifest["targetKeyframes"][1]["timeSeconds"] = 0
    with pytest.raises(ValueError):
        validate_manifest(manifest, 5)


def test_normalized_phase_targets_match_ui_despite_duration_difference(manifest):
    manifest["targetKeyframes"][1].update(timeSeconds=8, centerX=0.9)
    manifest["plannedDurationSeconds"] = 8
    assert target_at(manifest, 2.5, 5)["centerX"] == pytest.approx(0.625)
    manifest["targetTimeBasis"] = "normalized-phase"
    assert target_at(manifest, 2.5, 5)["centerX"] == pytest.approx(0.7)
    assert target_at(manifest, 5, 5)["centerX"] == pytest.approx(0.9)


def test_phase_basis_requires_planned_duration(manifest):
    manifest["targetTimeBasis"] = "normalized-phase"
    with pytest.raises(ValueError, match="planned duration"):
        validate_manifest(manifest, 5)


def test_input_measurements_not_mutated(manifest):
    original = track(0, reasons=[])
    original["maskArea"] = 0.000001
    annotate_tracks([original], manifest)
    assert original["uncertaintyReasons"] == []
