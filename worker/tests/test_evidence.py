"""Synthetic JPEG and mask records verify evidence selection, not model quality."""

from PIL import Image

from flowblock_worker.measurement import assess
from flowblock_worker.pipeline import write_evidence


def test_repeated_source_timestamp_keeps_the_actual_worst_frame(tmp_path):
    manifest = {
        "expectedVisible": {"startSeconds": 0, "endSeconds": 5},
        "targetKeyframes": [
            {"timeSeconds": 0, "centerX": 0.5, "centerY": 0.5, "width": 0.2, "height": 0.4},
        ],
    }
    frames = []
    (tmp_path / "frames").mkdir()
    for index, timestamp in enumerate([0, 0, 0, 0.5, 0.6]):
        frames.append(
            {
                "frameIndex": index,
                "timestamp": timestamp,
                "proxyTimestamp": index / 15,
                "box": {"x": 0.4, "y": 0.3, "width": 0.2, "height": 0.4},
                "center": {"x": 0.65 if index == 2 else 0.6, "y": 0.5},
                "boundary": [],
                "maskArea": 0.08,
                "touchesBorder": False,
                "uncertaintyReasons": [],
            }
        )
        color = (0, 255, 0) if index == 2 else (255, 0, 0)
        Image.new("RGB", (120, 80), color).save(tmp_path / "frames" / f"{index:05d}.jpg")
    result = assess(frames, manifest, 5)
    finding = result["findings"][0]
    assert finding["measurement"]["timestamp"] == 0
    write_evidence(result, tmp_path, "private/analysis")
    assert "_evidenceFrameIndices" not in finding
    assert {item["objectKey"] for item in finding["evidence"]} == {
        "private/analysis/evidence/frame-00000.jpg",
        "private/analysis/evidence/frame-00002.jpg",
        "private/analysis/evidence/frame-00004.jpg",
    }
    with Image.open(tmp_path / "evidence" / "frame-00002.jpg") as image:
        red, green, _ = image.getpixel((60, 60))
        assert green > 240 and red < 10
