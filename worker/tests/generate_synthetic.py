"""Generate a clearly synthetic bottle fixture. This is not creator footage."""

import json
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw


def generate(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    frames = directory / "fixture-frames"
    frames.mkdir(exist_ok=True)
    truth = []
    for index in range(75):
        image = Image.new("RGB", (320, 180), "#ded9cd")
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 145, 320, 180), fill="#c4b8a3")
        x = 128 + round(index / 74 * 20)
        draw.ellipse((x - 12, 136, x + 54, 151), fill="#b7aa96")
        draw.rounded_rectangle((x, 56, x + 40, 142), radius=9, fill="#244a40")
        draw.rectangle((x + 9, 43, x + 31, 59), fill="#1c2420")
        draw.rectangle((x + 3, 79, x + 37, 119), fill="#f6f2dd")
        draw.text((x + 8, 90), "TEST", fill="#244a40")
        draw.text((8, 8), "SYNTHETIC PIPELINE FIXTURE", fill="#33372d")
        image.save(frames / f"{index:05d}.jpg", quality=95)
        truth.append(
            {
                "frameIndex": index,
                "box": {"x": x / 320, "y": 43 / 180, "width": 41 / 320, "height": 100 / 180},
            }
        )
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-framerate",
            "15",
            "-i",
            str(frames / "%05d.jpg"),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            str(directory / "synthetic-bottle.mp4"),
        ],
        check=True,
    )
    seed = truth[37]["box"]
    payload = {
        "fixtureLabel": "SYNTHETIC; not creator footage or an accuracy benchmark",
        "jobId": "synthetic-smoke",
        "takeId": "synthetic-bottle",
        "planId": "fixture",
        "planVersion": "1",
        "outputPrefix": "synthetic-smoke",
        "seed": {"timeSeconds": 37 / 15, "box": seed},
        "corrections": [{"timeSeconds": 4.0, "box": truth[60]["box"]}],
        "expectedVisible": {"startSeconds": 0, "endSeconds": 5},
        "plannedDurationSeconds": 5,
        "targetKeyframes": [
            {
                "timeSeconds": item["frameIndex"] / 15,
                "centerX": item["box"]["x"] + item["box"]["width"] / 2,
                "centerY": item["box"]["y"] + item["box"]["height"] / 2,
                "width": item["box"]["width"],
                "height": item["box"]["height"],
            }
            for item in truth
        ],
    }
    (directory / "manifest.json").write_text(json.dumps(payload, indent=2))
    (directory / "known-synthetic-boxes.json").write_text(json.dumps(truth, indent=2))


if __name__ == "__main__":
    generate(Path(sys.argv[1]))
