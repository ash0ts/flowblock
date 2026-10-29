"""Real FFmpeg decoding tests using explicitly synthetic test patterns."""

import subprocess
from pathlib import Path

import pytest

from flowblock_worker.video import nearest_timestamp, prepare_video, probe


def fixture_video(path: Path, codec="libx264", seconds=5, size="320x180"):
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={size}:rate=24:duration={seconds}",
            "-an",
            "-c:v",
            codec,
            str(path),
        ],
        check=True,
    )


def test_non_h264_codec_decodes_and_timing_is_preserved(tmp_path):
    source = tmp_path / "synthetic.mkv"
    fixture_video(source, codec="ffv1")
    metadata = prepare_video(source, tmp_path / "output")
    assert metadata["codec"] == "ffv1"
    assert metadata["sampledFrames"] == 75
    assert metadata["fps"] == 15
    assert len(metadata["timeMap"]) == 75
    assert all(abs(t["sourceSeconds"] - t["proxySeconds"]) <= 1 / 24 for t in metadata["timeMap"])
    assert (tmp_path / "output" / "proxy.mp4").exists()


def test_rotation_is_applied_to_proxy(tmp_path):
    original, rotated = tmp_path / "synthetic.mp4", tmp_path / "rotated.mov"
    fixture_video(original)
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-display_rotation",
            "90",
            "-i",
            str(original),
            "-c",
            "copy",
            str(rotated),
        ],
        check=True,
    )
    result = prepare_video(rotated, tmp_path / "output")
    assert result["width"] == 180 and result["height"] == 320
    proxy = probe(tmp_path / "output" / "proxy.mp4")
    assert proxy["sourceWidth"] == 180 and proxy["sourceHeight"] == 320
    assert proxy["rotationDegrees"] == 0


@pytest.mark.parametrize("seconds", [1, 16])
def test_duration_limits(tmp_path, seconds):
    source = tmp_path / "synthetic.mp4"
    fixture_video(source, seconds=seconds)
    with pytest.raises(ValueError, match="5 and 15"):
        probe(source)


def test_invalid_media_fails_cleanly(tmp_path):
    source = tmp_path / "invalid.mp4"
    source.write_text("this is not video")
    with pytest.raises(ValueError, match="decoder rejected"):
        probe(source)


def test_nearest_timestamp_bounds_and_vfr_mapping():
    assert nearest_timestamp([0.0, 0.04, 0.13, 0.5], 0.1) == 0.13
    assert nearest_timestamp([0.0, 0.04, 0.13, 0.5], 1) == 0.5


def test_longer_audio_track_cannot_inflate_video_duration_or_coverage(tmp_path):
    original, mixed = tmp_path / "video.mkv", tmp_path / "long-audio.mkv"
    fixture_video(original, codec="ffv1")
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(original),
            "-f",
            "lavfi",
            "-t",
            "10",
            "-i",
            "anullsrc=r=8000:cl=mono",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "pcm_s16le",
            str(mixed),
        ],
        check=True,
    )
    assert probe(mixed)["durationSeconds"] == 10
    with pytest.raises(ValueError, match="Decoded video duration differs"):
        prepare_video(mixed, tmp_path / "output")
