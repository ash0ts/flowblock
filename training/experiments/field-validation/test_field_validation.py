"""Integrity and missingness checks use fabricated bytes, never recorded study outcomes."""

from importlib import util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

SPEC = util.spec_from_file_location(
    "field_validation", Path(__file__).with_name("validate_real_footage.py")
)
validation = util.module_from_spec(SPEC)
SPEC.loader.exec_module(validation)


@pytest.fixture
def prepared(tmp_path, monkeypatch):
    previous = tmp_path / "previous"
    source = tmp_path / "source.py"
    source.write_text("frozen implementation")
    monkeypatch.setattr(validation, "ROOT", tmp_path)
    monkeypatch.setattr(validation, "source_paths", lambda: [Path("source.py")])
    monkeypatch.setattr(validation, "runtime_identity", lambda: {"python": "test-only"})
    dataset = tmp_path / "dataset"
    (dataset / "source").mkdir(parents=True)
    (dataset / "source/LICENSE").write_text("test fixture license, not public data")
    (dataset / "ATTRIBUTION.md").write_text("test fixture")
    rows = []
    for sequence in ("product/a", "product/b"):
        directory = previous / sequence.replace("/", "_")
        directory.mkdir(parents=True)
        row = {
            "sequence_id": sequence,
            "directory": directory.name,
            "status": "prepared",
        }
        for name, key in (
            ("first-five-seconds.mp4", "clip_sha256"),
            ("references.json", "references_sha256"),
            ("manifest.json", "manifest_sha256"),
        ):
            (directory / name).write_text(f"fabricated test input {sequence}/{name}")
            row[key] = validation.digest(directory / name)
        rows.append(row)
    rows.append(
        {
            "sequence_id": "missing/a",
            "status": "excluded",
            "reason": "annotation unavailable",
        }
    )
    validation.write_json(
        previous / "cohort.json", {"rows": rows, "limitations": ["test data only"]}
    )
    return previous, dataset, tmp_path / "attempt", source


def test_freeze_preserves_membership_exclusions_and_exact_input_bytes(prepared):
    previous, dataset, output, _ = prepared
    frozen = validation.freeze(previous, dataset, output, None)
    assert frozen["selected_sequence_ids"] == ["product/a", "product/b"]
    assert frozen["original_selected_count"] == 3
    assert (
        validation.read_json(output / "cohort.json")["rows"][2]["reason"]
        == "annotation unavailable"
    )
    assert (output / "product_a/first-five-seconds.mp4").read_bytes() == (
        previous / "product_a/first-five-seconds.mp4"
    ).read_bytes()
    validation.verify(output)
    with pytest.raises(FileExistsError):
        validation.freeze(previous, dataset, output, None)


@pytest.mark.parametrize(
    "mutation", ["input", "live-source", "snapshot", "scope", "dependency"]
)
def test_drift_rejected_before_any_inference(prepared, monkeypatch, mutation):
    previous, dataset, output, source = prepared
    validation.freeze(previous, dataset, output, None)
    if mutation == "input":
        (output / "product_a/manifest.json").write_text("changed prompt")
    elif mutation == "live-source":
        source.write_text("changed implementation")
    elif mutation == "snapshot":
        (output / "runtime/source.py.txt").write_text("changed historical bytes")
    elif mutation == "scope":
        manifest = validation.read_json(output / "freeze.json")
        manifest["scope"]["creator_outcome_measured"] = True
        (output / "freeze.json").write_text(json.dumps(manifest))
    else:
        monkeypatch.setattr(
            validation, "runtime_identity", lambda: {"python": "changed"}
        )
    monkeypatch.setattr(
        validation,
        "load_adapter",
        lambda: pytest.fail("Drift must stop before importing inference"),
    )
    with pytest.raises(ValueError):
        validation.run(output)
    assert not (output / "execution-started.json").exists()


def test_partial_attempt_is_retained_and_cannot_be_retried(prepared, monkeypatch):
    previous, dataset, output, _ = prepared
    validation.freeze(previous, dataset, output, None)

    def fail_run(output, limit):
        (output / "product_a/analysis").mkdir()
        raise RuntimeError("fabricated infrastructure failure")

    monkeypatch.setattr(
        validation, "load_adapter", lambda: SimpleNamespace(run_benchmark=fail_run)
    )
    with pytest.raises(RuntimeError, match="preserved summary"):
        validation.run(output)
    summary = validation.read_json(output / "summary.json")
    assert summary["counts"] == {"failed": 1, "unattempted": 1, "excluded": 1}
    assert summary["selected_for_execution"] == 2
    assert summary["usable_fraction"] is None
    monkeypatch.setattr(
        validation,
        "load_adapter",
        lambda: pytest.fail("Must not repeat an uncertain attempt"),
    )
    with pytest.raises(FileExistsError):
        validation.run(output)


def test_selection_is_frozen_without_replacing_missing_sources(prepared):
    previous, dataset, output, _ = prepared
    validation.freeze(previous, dataset, output, ["product/b"])
    rows = validation.read_json(output / "cohort.json")["rows"]
    assert [row["status"] for row in rows] == ["not_selected", "prepared", "excluded"]
    assert not (output / "product_a").exists()


@pytest.mark.parametrize("selection", [["missing/a"], ["product/a", "product/a"], []])
def test_invalid_selection_does_not_create_attempt(prepared, selection):
    previous, dataset, output, _ = prepared
    with pytest.raises(ValueError):
        validation.freeze(previous, dataset, output, selection)
    assert not output.exists()
