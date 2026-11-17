"""The publication boundary permits scalar results, never source pixels or labels."""

from importlib import util
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
SPEC = util.spec_from_file_location(
    "field_publication", HERE / "prepare_publication.py"
)
publication = util.module_from_spec(SPEC)
SPEC.loader.exec_module(publication)


def test_metadata_rows_do_not_export_source_or_frame_labels():
    summary = {
        "rows": [
            {
                "sequence_id": "product/one",
                "status": "completed",
                "rawMedia": "never upload",
                "tracks": [{"box": {"x": 0.2}}],
                "elapsed_processing_seconds": 3.2,
                "summary": {
                    "evaluation_samples_excluding_seed": 74,
                    "usable_samples": 70,
                    "usable_fraction": 70 / 74,
                    "mean_proxy_metrics_on_usable_samples": {
                        "mask_center_inside_projected_box": 1.0
                    },
                },
            },
            {
                "sequence_id": "missing/two",
                "status": "excluded",
                "reason": "annotation unavailable",
            },
        ]
    }
    rows = publication.publication_rows(summary)
    assert len(rows) == 2
    assert rows[0]["usableSamples"] == 70
    assert rows[0]["evaluationSamplesExcludingSeed"] == 74
    assert rows[0]["maskCenterInsideProjectedBoxFraction"] == 1.0
    assert rows[1]["available"] is False
    assert "usableFraction" not in rows[1]
    assert rows[1]["reason"] == "annotation unavailable"
    assert all("rawMedia" not in row and "tracks" not in row for row in rows)
    assert all(row["split"] == "development" for row in rows)
