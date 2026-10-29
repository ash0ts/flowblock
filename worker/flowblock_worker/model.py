"""Pinned SAM 2.1 video predictor with explicit device selection."""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def manifest() -> dict:
    return json.loads((ROOT / "models" / "manifest.json").read_text())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verified_paths() -> tuple[Path, Path, dict]:
    config = manifest()
    checkout = Path(os.environ.get("FLOWBLOCK_SAM2_DIR", str(ROOT / "vendor" / "sam2"))).resolve()
    checkpoint = Path(
        os.environ.get(
            "FLOWBLOCK_CHECKPOINT", str(ROOT / "models" / config["checkpoint"]["filename"])
        )
    ).resolve()
    if not checkpoint.is_file() or sha256(checkpoint) != config["checkpoint"]["sha256"]:
        raise RuntimeError(
            "SAM 2 checkpoint is missing or failed SHA-256 verification; run setup-model"
        )
    revision = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    if revision != config["repository"]["commit"]:
        raise RuntimeError("SAM 2 source commit does not match models/manifest.json")
    changed = subprocess.run(
        ["git", "-C", str(checkout), "status", "--porcelain", "--untracked-files=no"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    if changed:
        raise RuntimeError("SAM 2 tracked source files have uncommitted changes")
    return checkout, checkpoint, config


class Segmenter:
    def __init__(self, device: str = "cuda"):
        checkout, checkpoint, self.provenance = verified_paths()
        sys.path.insert(0, str(checkout))
        if device == "mps":
            # PyTorch 2.5.1 lacks MPS bicubic upsampling used by Hiera. This is an
            # explicit local smoke-test mode; its unsupported ops run on CPU.
            os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        import torch
        from sam2.build_sam import build_sam2_video_predictor

        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA was requested but is unavailable; explicitly use --device mps or cpu for a local smoke test"
            )
        if device == "mps" and not torch.backends.mps.is_available():
            raise RuntimeError("MPS was requested but is unavailable")
        if device not in ("cuda", "mps", "cpu"):
            raise ValueError("Device must be cuda, mps, or cpu")
        self.device = device
        self.torch = torch
        # Connected-component CUDA postprocessing is disabled consistently on all devices.
        self.predictor = build_sam2_video_predictor(
            self.provenance["config"],
            str(checkpoint),
            device=device,
            apply_postprocessing=False,
            hydra_overrides_extra=["++model.fill_hole_area=0"],
        )

    def track(
        self, frame_dir: Path, metadata: dict, prompts: list[dict], checkpoint_callback=None
    ) -> list[dict]:
        import numpy as np

        torch = self.torch
        count = metadata["sampledFrames"]
        width, height = metadata["width"], metadata["height"]
        autocast = (
            torch.autocast("cuda", dtype=torch.bfloat16)
            if self.device == "cuda"
            else contextlib.nullcontext()
        )
        with torch.inference_mode(), autocast:
            state = self.predictor.init_state(
                str(frame_dir),
                offload_video_to_cpu=True,
                offload_state_to_cpu=self.device != "cuda",
                async_loading_frames=False,
            )
            prompt_indices = []
            for prompt in prompts:
                index = min(
                    range(count),
                    key=lambda i: abs(
                        metadata["timeMap"][i]["sourceSeconds"] - prompt["timeSeconds"]
                    ),
                )
                box = prompt["box"]
                xyxy = np.array(
                    [
                        box["x"] * width,
                        box["y"] * height,
                        (box["x"] + box["width"]) * width,
                        (box["y"] + box["height"]) * height,
                    ],
                    dtype=np.float32,
                )
                self.predictor.add_new_points_or_box(state, frame_idx=index, obj_id=1, box=xyxy)
                prompt_indices.append(index)
            observations = {}
            start = min(prompt_indices)
            for reverse in (False, True):
                if reverse and start == 0:
                    continue
                for index, ids, logits in self.predictor.propagate_in_video(
                    state, start_frame_idx=start, reverse=reverse
                ):
                    if checkpoint_callback:
                        checkpoint_callback()
                    position = list(ids).index(1)
                    values = logits[position].detach().float().cpu().numpy().squeeze()
                    observations[index] = describe_mask(values, width, height)
            self.predictor.reset_state(state)
        return [
            {
                "frameIndex": index,
                "timestamp": metadata["timeMap"][index]["sourceSeconds"],
                "proxyTimestamp": index / metadata["fps"],
                **observations.get(
                    index,
                    {
                        "box": None,
                        "center": None,
                        "boundary": [],
                        "maskArea": 0.0,
                        "touchesBorder": False,
                        "uncertaintyReasons": [],
                    },
                ),
            }
            for index in range(count)
        ]


def describe_mask(logits, width: int, height: int) -> dict:
    import cv2
    import numpy as np

    mask = (logits > 0).astype(np.uint8)
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return {
            "box": None,
            "center": None,
            "boundary": [],
            "maskArea": 0.0,
            "touchesBorder": False,
            "uncertaintyReasons": [],
        }
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contour = max(contours, key=cv2.contourArea)
    approximation = cv2.approxPolyDP(
        contour, max(1, cv2.arcLength(contour, True) * 0.005), True
    ).reshape(-1, 2)
    if len(approximation) > 128:
        approximation = approximation[np.linspace(0, len(approximation) - 1, 128).astype(int)]
    components, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    reasons = []
    if components > 2 and max(stats[1:, cv2.CC_STAT_AREA]) / len(xs) < 0.6:
        reasons.append("fragmented-mask")
    if float(np.count_nonzero(np.abs(logits[mask.astype(bool)]) < 1)) / len(xs) > 0.4:
        reasons.append("weak-mask-logits")
    return {
        "box": {
            "x": float(xs.min() / width),
            "y": float(ys.min() / height),
            "width": float((xs.max() - xs.min() + 1) / width),
            "height": float((ys.max() - ys.min() + 1) / height),
        },
        "center": {"x": float((xs.mean() + 0.5) / width), "y": float((ys.mean() + 0.5) / height)},
        "boundary": [
            {"x": float((x + 0.5) / width), "y": float((y + 0.5) / height)}
            for x, y in approximation
        ],
        "maskArea": len(xs) / (width * height),
        "touchesBorder": bool(
            xs.min() <= 1 or ys.min() <= 1 or xs.max() >= width - 2 or ys.max() >= height - 2
        ),
        "uncertaintyReasons": reasons,
    }
