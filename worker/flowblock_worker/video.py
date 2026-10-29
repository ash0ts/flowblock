"""Decode bounded local inputs into upright CFR frames and preserve source timing."""

from __future__ import annotations

import bisect
import json
import math
import subprocess
from pathlib import Path

FPS = 15
MAX_BYTES = 256 * 1024 * 1024
INPUT_FORMATS = "mov,matroska,avi,mpegts,mpeg,ogg,flv"


def run(args: list[str], timeout: int = 180) -> str:
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=True)
    except subprocess.TimeoutExpired as error:
        raise ValueError("Video decode exceeded its time limit") from error
    except subprocess.CalledProcessError as error:
        raise ValueError(f"Video decoder rejected the input: {error.stderr[-1500:]}") from error
    return result.stdout


def probe(path: Path) -> dict:
    path = path.resolve(strict=True)
    if not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES:
        raise ValueError("Video must be a nonempty file no larger than 256 MiB")
    raw = json.loads(
        run(
            [
                "ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                INPUT_FORMATS,
                "-select_streams",
                "v:0",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ],
            30,
        )
    )
    if not raw.get("streams"):
        raise ValueError("Input has no video stream")
    stream = raw["streams"][0]
    duration = float(stream.get("duration") or raw.get("format", {}).get("duration") or 0)
    if not math.isfinite(duration) or not 5 <= duration <= 15.1:
        raise ValueError("Video must be between 5 and 15 seconds")
    width, height = int(stream.get("width", 0)), int(stream.get("height", 0))
    if min(width, height) < 16 or max(width, height) > 8192 or width * height > 34_000_000:
        raise ValueError("Video dimensions are unsupported")
    sar = stream.get("sample_aspect_ratio", "1:1")
    try:
        a, b = map(float, sar.split(":"))
        ratio = a / b if a > 0 and b > 0 else 1
    except (ValueError, ZeroDivisionError):
        ratio = 1
    rotation = next(
        (float(x["rotation"]) for x in stream.get("side_data_list", []) if "rotation" in x),
        float(stream.get("tags", {}).get("rotate", 0)),
    )
    display_width, display_height = width * ratio, float(height)
    if round(rotation / 90) % 2:
        display_width, display_height = display_height, display_width
    landscape = display_width >= display_height
    max_width, max_height = (1280, 720) if landscape else (720, 1280)
    scale = min(1.0, max_width / display_width, max_height / display_height)
    upright_width = max(2, math.floor(display_width * scale / 2) * 2)
    upright_height = max(2, math.floor(display_height * scale / 2) * 2)
    return {
        "durationSeconds": duration,
        "sourceWidth": width,
        "sourceHeight": height,
        "rotationDegrees": rotation,
        "width": upright_width,
        "height": upright_height,
        "codec": stream.get("codec_name", "unknown"),
    }


def nearest_timestamp(timestamps: list[float], time: float) -> float:
    position = bisect.bisect_left(timestamps, time)
    choices = timestamps[max(0, position - 1) : position + 1]
    return min(choices, key=lambda source: abs(source - time))


def prepare_video(source: Path, directory: Path) -> dict:
    metadata = probe(source)
    directory.mkdir(parents=True, exist_ok=True)
    frames = directory / "frames"
    frames.mkdir()
    frame_data = json.loads(
        run(
            [
                "ffprobe",
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-format_whitelist",
                INPUT_FORMATS,
                "-select_streams",
                "v:0",
                "-show_frames",
                "-show_entries",
                "frame=best_effort_timestamp_time",
                "-of",
                "json",
                str(source.resolve()),
            ],
            60,
        )
    )
    timestamps = sorted(
        float(f["best_effort_timestamp_time"])
        for f in frame_data.get("frames", [])
        if "best_effort_timestamp_time" in f
    )
    if not timestamps:
        raise ValueError("Video has no decodable timestamped frames")
    origin = timestamps[0]
    relative_timestamps = [time - origin for time in timestamps]
    # FFmpeg autorotates before this filter. Explicit dimensions also normalize SAR.
    filters = f"setpts=PTS-STARTPTS,fps={FPS}:round=near:start_time=0,scale={metadata['width']}:{metadata['height']},setsar=1"
    run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            "-format_whitelist",
            INPUT_FORMATS,
            "-i",
            str(source.resolve()),
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-vf",
            filters,
            "-t",
            "15.1",
            "-frames:v",
            "227",
            "-q:v",
            "2",
            "-start_number",
            "0",
            str(frames / "%05d.jpg"),
        ]
    )
    files = sorted(frames.glob("*.jpg"))
    if not 74 <= len(files) <= 227:
        raise ValueError("Decoded frame count does not match a 5 to 15 second clip")
    proxy = directory / "proxy.mp4"
    run(
        [
            "ffmpeg",
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-framerate",
            str(FPS),
            "-i",
            str(frames / "%05d.jpg"),
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(proxy),
        ]
    )
    time_map = [
        {
            "frameIndex": index,
            "proxySeconds": index / FPS,
            "sourceSeconds": nearest_timestamp(relative_timestamps, index / FPS),
            "sourcePtsSeconds": nearest_timestamp(timestamps, origin + index / FPS),
        }
        for index in range(len(files))
    ]
    # sourceSeconds is the nearest source presentation timestamp, not physical capture time.
    metadata.update(
        {
            "fps": FPS,
            "sampledFrames": len(files),
            "sourceStartPtsSeconds": origin,
            "timestampMapping": "nearest-source-presentation-timestamp",
            "timeMap": time_map,
        }
    )
    (directory / "timestamps.json").write_text(json.dumps(metadata, indent=2))
    return metadata
