"""Pure measurements. No model imports and no inference of physical camera motion.

Thresholds are review rules, not model probabilities or validated quality scores.
"""

from __future__ import annotations

import math
from bisect import bisect_right


def finite(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise ValueError(f"{name} must be a finite number")
    return float(value)


def validate_box(box: dict) -> dict:
    result = {key: finite(box.get(key), f"box.{key}") for key in ("x", "y", "width", "height")}
    if result["x"] < 0 or result["y"] < 0 or min(result["width"], result["height"]) <= 0:
        raise ValueError("Prompt box must have a positive size inside the image")
    if result["x"] + result["width"] > 1.000001 or result["y"] + result["height"] > 1.000001:
        raise ValueError("Prompt box exceeds normalized image bounds")
    return result


def validate_manifest(manifest: dict, duration: float | None = None) -> dict:
    basis = manifest.get("targetTimeBasis", "absolute-seconds")
    if basis not in ("absolute-seconds", "normalized-phase"):
        raise ValueError("Target time basis must be absolute-seconds or normalized-phase")
    if manifest.get("plannedDurationSeconds") is not None:
        if finite(manifest["plannedDurationSeconds"], "planned duration") <= 0:
            raise ValueError("Planned duration must be positive")
    if basis == "normalized-phase" and manifest.get("targetKeyframes"):
        if finite(manifest.get("plannedDurationSeconds"), "planned duration") <= 0:
            raise ValueError("Phase-aligned targets require a positive planned duration")
    seed = manifest.get("seed", {})
    prompts = [seed, *manifest.get("corrections", [])]
    if len(prompts) > 21:
        raise ValueError("At most 20 corrections are supported")
    for prompt in prompts:
        validate_box(prompt.get("box", {}))
        time = finite(prompt.get("timeSeconds"), "prompt time")
        if time < 0 or (duration is not None and time >= duration):
            raise ValueError("Prompt time lies outside the clip")
    interval = manifest.get("expectedVisible", {})
    start = finite(interval.get("startSeconds"), "expectedVisible.startSeconds")
    end = finite(interval.get("endSeconds"), "expectedVisible.endSeconds")
    if not 0 <= start < end or (duration is not None and end > duration + 0.1):
        raise ValueError("Expected-visible interval lies outside the clip")
    if not start <= seed["timeSeconds"] <= end:
        raise ValueError("Seed must be inside the expected-visible interval")
    frames = manifest.get("targetKeyframes", [])
    if not frames and manifest.get("target"):
        frames = [
            {"timeSeconds": index, **manifest["target"][key]}
            for index, key in enumerate(("start", "end"))
        ]
    previous = -1.0
    for frame in frames:
        time = finite(frame.get("timeSeconds"), "target time")
        if time < 0 or time <= previous:
            raise ValueError("Target keyframe times must be ordered and unique")
        previous = time
        for key in ("centerX", "centerY", "width", "height"):
            value = finite(frame.get(key), f"target.{key}")
            if key in ("width", "height") and value <= 0:
                raise ValueError("Target extent must be positive")
    if len(frames) > 1000:
        raise ValueError("Too many target keyframes")
    for phase in manifest.get("phaseIntervals", []):
        a = finite(phase.get("startSeconds"), "phase start")
        b = finite(phase.get("endSeconds"), "phase end")
        if not 0 <= a < b:
            raise ValueError("Invalid phase interval")
    return manifest


def target_at(manifest: dict, time: float, duration: float) -> dict | None:
    keyframes = manifest.get("targetKeyframes", [])
    if keyframes and manifest.get("targetTimeBasis") == "normalized-phase":
        time = time * manifest["plannedDurationSeconds"] / duration
    if not keyframes and manifest.get("target"):
        keyframes = [
            {"timeSeconds": 0.0, **manifest["target"]["start"]},
            {"timeSeconds": duration, **manifest["target"]["end"]},
        ]
    if not keyframes:
        return None
    times = [frame["timeSeconds"] for frame in keyframes]
    index = bisect_right(times, time)
    if index == 0:
        return dict(keyframes[0])
    if index == len(keyframes):
        return dict(keyframes[-1])
    left, right = keyframes[index - 1], keyframes[index]
    t = (time - left["timeSeconds"]) / (right["timeSeconds"] - left["timeSeconds"])
    return {
        key: left[key] + t * (right[key] - left[key])
        for key in ("centerX", "centerY", "width", "height")
    }


def phase_at(manifest: dict, time: float, duration: float) -> str:
    phases = manifest.get("phaseIntervals") or [
        {"phase": "opening", "startSeconds": 0, "endSeconds": duration * 0.25},
        {"phase": "middle", "startSeconds": duration * 0.25, "endSeconds": duration * 0.75},
        {"phase": "ending", "startSeconds": duration * 0.75, "endSeconds": duration + 0.001},
    ]
    return next(
        (str(p["phase"]) for p in phases if p["startSeconds"] <= time < p["endSeconds"]), "take"
    )


def annotate_tracks(tracks: list[dict], manifest: dict) -> list[dict]:
    """Mark missing and abrupt masks without silently filling tracking gaps."""
    expected = manifest["expectedVisible"]
    previous = None
    result = []
    for original in tracks:
        track = {**original, "uncertaintyReasons": list(original.get("uncertaintyReasons", []))}
        time = track["timestamp"]
        if not expected["startSeconds"] <= time <= expected["endSeconds"]:
            track["visibility"] = "intentionally-hidden"
            previous = None
        elif track.get("box") is None or track.get("center") is None:
            track["visibility"] = "missing"
            track["uncertaintyReasons"].append("no-mask")
            previous = None
        else:
            area = track.get("maskArea", track["box"]["width"] * track["box"]["height"])
            if area < 0.0003:
                track["uncertaintyReasons"].append("very-small-mask")
            if area > 0.8:
                track["uncertaintyReasons"].append("mask-covers-most-of-frame")
            if previous and time - previous["timestamp"] <= 0.15:
                jump = math.hypot(
                    track["center"]["x"] - previous["center"]["x"],
                    track["center"]["y"] - previous["center"]["y"],
                )
                old_area = previous.get(
                    "maskArea", previous["box"]["width"] * previous["box"]["height"]
                )
                ratio = area / max(old_area, 1e-9)
                if jump > 0.15:
                    track["uncertaintyReasons"].append("abrupt-center-change")
                if ratio > 2.0 or ratio < 0.5:
                    track["uncertaintyReasons"].append("abrupt-area-change")
            track["visibility"] = "uncertain" if track["uncertaintyReasons"] else "visible"
            previous = track
        track["uncertaintyReasons"] = sorted(set(track["uncertaintyReasons"]))
        result.append(track)
    return result


def assess(tracks: list[dict], manifest: dict, duration: float) -> dict:
    tracks = annotate_tracks(tracks, manifest)
    expected = [t for t in tracks if t["visibility"] != "intentionally-hidden"]
    measured = [t for t in expected if t["visibility"] == "visible"]
    coverage = {
        "expectedFrames": len(expected),
        "measuredFrames": len(measured),
        "missingFrames": sum(t["visibility"] == "missing" for t in expected),
        "uncertainFrames": sum(t["visibility"] == "uncertain" for t in expected),
        "intentionallyHiddenFrames": len(tracks) - len(expected),
        "measuredFraction": len(measured) / len(expected) if expected else 0.0,
    }
    coverage["needsReview"] = coverage["measuredFraction"] < 0.8
    candidates: dict[tuple[str, str], list[tuple[dict, float]]] = {}
    for track in measured:
        time = track["timestamp"]
        phase = phase_at(manifest, time, duration)
        target = target_at(manifest, time, duration)
        box = track["box"]
        if track.get("touchesBorder", False):
            candidates.setdefault(("clipping", phase), []).append((track, 1.0))
        if target:
            drift = math.hypot(
                track["center"]["x"] - target["centerX"], track["center"]["y"] - target["centerY"]
            )
            if drift > 0.08:
                candidates.setdefault(("framing", phase), []).append((track, drift / 0.08))
            ratio = math.sqrt(box["width"] * box["height"] / (target["width"] * target["height"]))
            if ratio < 0.75 or ratio > 1.25:
                candidates.setdefault(("size", phase), []).append(
                    (track, abs(math.log(max(ratio, 1e-9))) / math.log(1.25))
                )
    findings = []
    titles = {
        "framing": "Product drifts from the planned framing",
        "size": "Product size differs from the plan",
        "clipping": "Product mask touches the image edge",
    }
    for (kind, phase), evidence in candidates.items():
        phase_frames = [
            t for t in measured if phase_at(manifest, t["timestamp"], duration) == phase
        ]
        # Require >=3 sampled frames and >=20% of a measured phase, not a single noisy mask.
        if len(evidence) < 3 or len(evidence) / max(len(phase_frames), 1) < 0.2:
            continue
        best, severity = max(evidence, key=lambda pair: pair[1])
        timestamps = sorted(
            {
                round(evidence[0][0]["timestamp"], 4),
                round(best["timestamp"], 4),
                round(evidence[-1][0]["timestamp"], 4),
            }
        )
        timestamp = best["timestamp"]
        target = target_at(manifest, timestamp, duration)
        count_detail = f"{len(evidence)} of {len(phase_frames)} reliable {phase} frames crossed the rule threshold."
        if kind == "framing":
            observed = math.hypot(
                best["center"]["x"] - target["centerX"], best["center"]["y"] - target["centerY"]
            )
            measurement = {
                "metric": "center-distance",
                "observed": observed,
                "target": 0.0,
                "delta": observed,
                "unit": "normalized-image-distance",
                "timestamp": timestamp,
            }
            detail = f"At {timestamp:.2f}s the product center was {observed:.3f} normalized x/y units from the target (threshold 0.080). {count_detail}"
        elif kind == "size":
            observed = math.sqrt(
                best["box"]["width"] * best["box"]["height"] / (target["width"] * target["height"])
            )
            measurement = {
                "metric": "size-ratio",
                "observed": observed,
                "target": 1.0,
                "delta": observed - 1,
                "unit": "relative-size",
                "timestamp": timestamp,
            }
            detail = f"At {timestamp:.2f}s the square root of the product bounding-box area was {observed:.2f} times the planned size (allowed 0.75 to 1.25). {count_detail}"
        else:
            observed = len(evidence) / len(phase_frames)
            measurement = {
                "metric": "border-contact-fraction",
                "observed": observed,
                "target": 0.0,
                "delta": observed,
                "unit": "fraction",
                "timestamp": timestamp,
            }
            detail = f"The mask reached the image edge in {len(evidence)} of {len(phase_frames)} reliable {phase} frames, including {timestamp:.2f}s. Border contact alone does not prove that the product was cropped."
        findings.append(
            {
                "kind": kind,
                "phase": phase,
                "title": titles[kind],
                "detail": detail,
                "measurement": measurement,
                "evidenceTimestamps": timestamps,
                "affectedFrames": len(evidence),
                "measuredPhaseFrames": len(phase_frames),
                "severity": severity,
                "suggestion": {
                    "framing": "Recenter the product in this phase or revise the framing target.",
                    "size": "Adjust the framing target or product size in the image for this phase.",
                    "clipping": "Leave more space around the product in this phase.",
                }[kind],
            }
        )
    planned_duration = manifest.get("plannedDurationSeconds")
    if isinstance(planned_duration, (int, float)) and planned_duration > 0:
        difference = duration - planned_duration
        if abs(difference) > max(0.5, planned_duration * 0.1):
            findings.append(
                {
                    "kind": "duration",
                    "phase": "take",
                    "title": "Take length differs from the plan",
                    "detail": f"The clip is {duration:.2f}s; the plan is {planned_duration:.2f}s.",
                    "measurement": {
                        "metric": "duration-seconds",
                        "observed": duration,
                        "target": planned_duration,
                        "delta": difference,
                        "unit": "seconds",
                        "timestamp": max(0, duration - 1 / 15),
                    },
                    "evidenceTimestamps": [round(max(0, duration - 1 / 15), 4)],
                    "affectedFrames": len(tracks),
                    "measuredPhaseFrames": len(tracks),
                    "severity": abs(difference) / planned_duration,
                    "suggestion": "Match the planned timing or update the plan duration.",
                }
            )
    findings.sort(key=lambda f: (-f["severity"], f["kind"], f["phase"]))
    findings = findings[:2]
    for finding in findings:
        finding.pop("severity")
    summary = (
        "Tracking needs correction before a reliable framing review."
        if coverage["needsReview"]
        else (
            "Review the timestamped framing observations below."
            if findings
            else "No rule-based framing issue was found in the measured frames."
        )
    )
    return {"tracks": tracks, "coverage": coverage, "findings": findings, "summary": summary}
