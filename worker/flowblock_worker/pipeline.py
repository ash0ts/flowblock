from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .measurement import assess, validate_manifest
from .video import prepare_video

LIMITATIONS = [
    "These are normalized image-space measurements. They do not recover a 3D camera path, distance, focal length, or physical speed.",
    "SAM 2 masks can drift, merge with occluders, or disappear. Uncertainty rules are review heuristics, not calibrated confidence probabilities.",
    "Intervals outside the declared expected-visible interval are excluded from tracking coverage and framing findings.",
    "Only reliable measured frames contribute to framing, size, and border-contact findings. Missing intervals are not interpolated.",
    "15 fps sampling may miss brief events. Timestamp mapping uses the nearest original presentation timestamp.",
    "Product-mask extent may differ from the planned 3D bounding-box projection. Size findings require visual review.",
]


def process(
    source: Path, manifest: dict, directory: Path, segmenter, checkpoint_callback=None
) -> dict:
    validate_manifest(manifest)
    metadata = prepare_video(source, directory)
    validate_manifest(manifest, metadata["durationSeconds"])
    if checkpoint_callback:
        checkpoint_callback()
    tracks = segmenter.track(
        directory / "frames",
        metadata,
        [manifest["seed"], *manifest.get("corrections", [])],
        checkpoint_callback,
    )
    assessment = assess(tracks, manifest, metadata["durationSeconds"])
    prefix = manifest.get("outputPrefix", "analysis").rstrip("/")
    artifacts = {
        "proxyObjectKey": f"{prefix}/proxy.mp4",
        "timestampsObjectKey": f"{prefix}/timestamps.json",
        "analysisObjectKey": f"{prefix}/analysis.json",
    }
    result = {
        "schemaVersion": "1.0",
        "analysisSpace": "upright-normalized-image",
        "jobId": str(manifest.get("jobId", "local")),
        "takeId": str(manifest.get("takeId", "local")),
        "planId": str(manifest.get("planId", "local")),
        "planVersion": str(manifest.get("planVersion", "1")),
        "provenance": {
            "model": "SAM 2.1 Small",
            "repositoryCommit": segmenter.provenance["repository"]["commit"],
            "checkpointSha256": segmenter.provenance["checkpoint"]["sha256"],
            "device": segmenter.device,
            "realInference": True,
            "rulesVersion": "framing-v1",
            "targetTimeBasis": manifest.get(
                "targetTimeBasis",
                "normalized-phase" if manifest.get("target") else "absolute-seconds",
            ),
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        },
        "video": metadata,
        **assessment,
        "artifacts": artifacts,
        "limitations": LIMITATIONS
        + (
            [
                "MPS local mode enables CPU fallback for unsupported PyTorch operations. This run is not CUDA validation."
            ]
            if segmenter.device == "mps"
            else []
        ),
    }
    write_evidence(result, directory, prefix)
    (directory / "analysis.json").write_text(json.dumps(result, indent=2, allow_nan=False))
    return result


def write_evidence(result: dict, directory: Path, prefix: str) -> None:
    from PIL import Image, ImageDraw

    evidence_dir = directory / "evidence"
    evidence_dir.mkdir()
    tracks = result["tracks"]
    for finding in result["findings"]:
        finding["evidence"] = []
        for timestamp in finding["evidenceTimestamps"]:
            track = min(tracks, key=lambda t: abs(t["timestamp"] - timestamp))
            index = track["frameIndex"]
            filename = f"frame-{index:05d}.jpg"
            with Image.open(directory / "frames" / f"{index:05d}.jpg") as original:
                image = original.convert("RGB")
                draw = ImageDraw.Draw(image)
                points = [(p["x"] * image.width, p["y"] * image.height) for p in track["boundary"]]
                if len(points) > 1:
                    draw.line(
                        [*points, points[0]], fill="#c9ff67", width=max(2, image.width // 300)
                    )
                draw.rectangle((0, 0, min(image.width, 430), 27), fill="#151712")
                draw.text(
                    (8, 7),
                    f"{track['timestamp']:.2f}s | mask boundary | {track['visibility']}",
                    fill="white",
                )
                image.save(evidence_dir / filename, quality=90)
            finding["evidence"].append(
                {"timestamp": track["timestamp"], "objectKey": f"{prefix}/evidence/{filename}"}
            )


def artifact_files(result: dict, directory: Path) -> list[tuple[Path, str, str]]:
    artifacts = result["artifacts"]
    output = [
        (directory / "proxy.mp4", artifacts["proxyObjectKey"], "video/mp4"),
        (directory / "timestamps.json", artifacts["timestampsObjectKey"], "application/json"),
        (directory / "analysis.json", artifacts["analysisObjectKey"], "application/json"),
    ]
    seen = set()
    for finding in result["findings"]:
        for evidence in finding.get("evidence", []):
            key = evidence["objectKey"]
            if key not in seen:
                output.append((directory / "evidence" / key.rsplit("/", 1)[-1], key, "image/jpeg"))
                seen.add(key)
    return output
