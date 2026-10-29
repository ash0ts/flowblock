"use client";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Crosshair,
  Film,
  Loader2,
  LockKeyhole,
  Play,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { samplePlan } from "@/domain";
import type { PlanVersion } from "@/domain/contracts";
import { TakeAnalysisSchema, type TakeAnalysis } from "@/domain/take-analysis";
import { NumberField } from "./Inspector";
import { useTakeHistory, type SavedAttempt } from "@/client/takes";
import Image from "next/image";

type Rect = { x: number; y: number; width: number; height: number };
type Annotation = { timeSeconds: number; box: Rect };

export function Review({
  plan: currentPlan,
  active,
  connected,
  onNotice,
  onRevision,
}: {
  plan: PlanVersion;
  active: boolean;
  connected: boolean;
  onNotice: (text: string) => void;
  onRevision: (plan: PlanVersion, original: PlanVersion) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const takeHistory = useTakeHistory();
  const localFiles = useRef(new Map<string, File>());
  const pendingUploads = useRef(
    new Map<
      string,
      { url: string; method: string; headers: Record<string, string> }
    >(),
  );
  const [uploadComplete, setUploadComplete] = useState(false);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [attemptPlan, setAttemptPlan] = useState<PlanVersion | null>(null);
  const [fileName, setFileName] = useState("");
  const [compareId, setCompareId] = useState("");
  const [showTarget, setShowTarget] = useState(true);
  const plan = attemptPlan ?? currentPlan;
  const drag = useRef<{ x: number; y: number } | null>(null);
  const jobGeneration = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [ratio, setRatio] = useState(16 / 9);
  const [rect, setRect] = useState<Rect | null>(null);
  const [seed, setSeed] = useState<Annotation | null>(null);
  const [corrections, setCorrections] = useState<Annotation[]>([]);
  const [expectedStart, setExpectedStart] = useState(0);
  const [expectedEnd, setExpectedEnd] = useState(8);
  const [consent, setConsent] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [analysis, setAnalysis] = useState<TakeAnalysis | null>(null);
  const [revising, setRevising] = useState(false);
  const [revised, setRevised] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [takeId, setTakeId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<{
    plan: PlanVersion;
    reason: string;
    revisionId: string;
  } | null>(null);
  useEffect(() => {
    void useTakeHistory.persist.rehydrate();
    const requests = jobGeneration;
    return () => {
      requests.current++;
    };
  }, []);
  useEffect(
    () => () => {
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    },
    [url],
  );
  useEffect(() => {
    if (!active) video.current?.pause();
  }, [active]);
  const chooseFile = (next: File | undefined) => {
    if (!next) return;
    if (busy || revising) {
      onNotice(
        "Finish or cancel the current operation before replacing the take.",
      );
      return;
    }
    jobGeneration.current++;
    setBusy(false);
    setError("");
    if (next.size > 100 * 1024 * 1024) {
      setError(
        "This file is over 100 MB. Export a 5–15 second clip under 100 MB.",
      );
      return;
    }
    if (!/\.(mp4|mov|webm|m4v)$/i.test(next.name)) {
      setError("Choose an MP4, MOV, M4V, or WebM video.");
      return;
    }
    const id = crypto.randomUUID();
    setAttemptId(id);
    setAttemptPlan(currentPlan);
    setFileName(next.name);
    localFiles.current.set(id, next);
    takeHistory.save({
      id,
      name: next.name,
      createdAt: new Date().toISOString(),
      plan: currentPlan,
      takeId: null,
      duration: 0,
      ratio: 16 / 9,
      analysis: null,
      seed: null,
      corrections: [],
      expectedStart: 0,
      expectedEnd: 8,
      revised: false,
    });
    setFile(next);
    setUrl(URL.createObjectURL(next));
    setDuration(0);
    setTime(0);
    setRect(null);
    setSeed(null);
    setCorrections([]);
    setAnalysis(null);
    setRevised(false);
    setDrawing(false);
    setUploadPercent(null);
    setTakeId(null);
    setUploadComplete(false);
    setJobId(null);
    setProposal(null);
  };
  const remember = (patch: Partial<SavedAttempt>) => {
    if (!attemptId) return;
    const saved = useTakeHistory
      .getState()
      .attempts.find((item) => item.id === attemptId);
    if (saved)
      takeHistory.save({
        ...saved,
        plan,
        duration,
        ratio,
        seed,
        corrections,
        expectedStart,
        expectedEnd,
        analysis,
        revised,
        ...patch,
      });
  };
  const openAttempt = (saved: SavedAttempt) => {
    if (busy) {
      onNotice("Cancel the current analysis before switching takes.");
      return;
    }
    jobGeneration.current++;
    setCompareId("");
    setAttemptId(saved.id);
    setAttemptPlan(saved.plan);
    setFileName(saved.name);
    setFile(localFiles.current.get(saved.id) ?? null);
    setUrl(
      localFiles.current.has(saved.id)
        ? URL.createObjectURL(localFiles.current.get(saved.id)!)
        : saved.takeId
          ? `/api/takes/${encodeURIComponent(saved.takeId)}/media?artifact=${saved.analysis ? "proxy" : "original"}`
          : "",
    );
    setDuration(saved.duration);
    setRatio(saved.ratio);
    setTime(0);
    setSeed(saved.seed);
    setRect(saved.seed?.box ?? null);
    setCorrections(saved.corrections);
    setExpectedStart(saved.expectedStart);
    setExpectedEnd(saved.expectedEnd);
    setAnalysis(saved.analysis);
    setTakeId(saved.takeId);
    setUploadComplete(Boolean(saved.uploadComplete || saved.analysis));
    setRevised(saved.revised);
    setProposal(null);
    setDrawing(false);
    setError(
      !saved.takeId && !localFiles.current.has(saved.id)
        ? "This take was only stored locally. Choose the original video again to play it."
        : "",
    );
  };
  const setNumericBox = (patch: Partial<Rect>) => {
    const next = {
      x: 0.35,
      y: 0.2,
      width: 0.3,
      height: 0.6,
      ...rect,
      ...patch,
    };
    next.width = Math.min(next.width, 1 - next.x);
    next.height = Math.min(next.height, 1 - next.y);
    setRect(next);
    video.current?.pause();
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };
  const startBox = (event: PointerEvent<HTMLDivElement>) => {
    if (!drawing) return;
    video.current?.pause();
    drag.current = point(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setRect({ ...drag.current, width: 0, height: 0 });
  };
  const moveBox = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const p = point(event);
    setRect({
      x: Math.min(p.x, drag.current.x),
      y: Math.min(p.y, drag.current.y),
      width: Math.abs(p.x - drag.current.x),
      height: Math.abs(p.y - drag.current.y),
    });
  };
  const endBox = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const p = point(event),
      r = {
        x: Math.min(p.x, drag.current.x),
        y: Math.min(p.y, drag.current.y),
        width: Math.abs(p.x - drag.current.x),
        height: Math.abs(p.y - drag.current.y),
      };
    drag.current = null;
    if (r.width < 0.01 || r.height < 0.01) {
      setError(
        "Draw a box around the whole product, with some width and height.",
      );
      setRect(null);
      return;
    }
    setRect(r);
    setError("");
    if (!seed) {
      setSeed({ timeSeconds: video.current?.currentTime ?? time, box: r });
      setDrawing(false);
    }
  };
  const seek = (seconds: number) => {
    if (video.current) {
      video.current.currentTime = Math.min(duration, Math.max(0, seconds));
      video.current.pause();
      setTime(seconds);
    }
  };
  const uploadBytes = (
    target: string,
    method: string,
    headers: Record<string, string>,
    body: File,
  ) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, target);
      Object.entries(headers).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable)
          setUploadPercent(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve()
          : reject(new Error(`Video upload failed (${xhr.status}).`));
      xhr.onerror = () =>
        reject(
          new Error(
            "Video upload failed. Check your connection and try again.",
          ),
        );
      xhr.send(body);
    });
  const analyze = async () => {
    if ((!file && !takeId) || !seed || duration < 5 || duration > 15) return;
    setError("");
    setBusy(true);
    setAnalysis(null);
    setPhase("Preparing private upload");
    const generation = ++jobGeneration.current;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : result.message || "The service could not complete this request.",
        );
      return result;
    };
    try {
      let uploadedTakeId = takeId;
      let createdUpload = false;
      if (!uploadedTakeId) {
        if (!file) throw new Error("Choose the original video to upload.");
        const upload = await post("/api/uploads", {
          fileName: file.name,
          contentType: file.type || "video/mp4",
          sizeBytes: file.size,
          plan,
          trainingConsent: consent,
        });
        uploadedTakeId = upload.takeId;
        createdUpload = true;
        setTakeId(upload.takeId);
        setUploadComplete(false);
        remember({ takeId: upload.takeId, uploadComplete: false });
        pendingUploads.current.set(upload.takeId, {
          url: upload.uploadUrl,
          method: upload.method || "PUT",
          headers: upload.headers || {
            "Content-Type": file.type || "video/mp4",
          },
        });
      }
      if (!uploadComplete || createdUpload) {
        let confirmed = false;
        if (!createdUpload) {
          try {
            await post(
              `/api/uploads/${encodeURIComponent(uploadedTakeId!)}/complete`,
              {},
            );
            confirmed = true;
          } catch {
            /* Retry bytes only if the original upload did not complete. */
          }
        }
        if (!confirmed) {
          const pending = pendingUploads.current.get(uploadedTakeId!);
          if (!file || !pending)
            throw new Error(
              "The original upload did not complete. Delete the uploaded media, then choose the original clip and upload again.",
            );
          setPhase("Uploading your take");
          setUploadPercent(0);
          await uploadBytes(pending.url, pending.method, pending.headers, file);
          await post(
            `/api/uploads/${encodeURIComponent(uploadedTakeId!)}/complete`,
            {},
          );
        }
        setUploadComplete(true);
        remember({ takeId: uploadedTakeId, uploadComplete: true });
      }
      if (generation !== jobGeneration.current) return;
      const job = await post(
        `/api/takes/${encodeURIComponent(uploadedTakeId!)}/analyze`,
        {
          seed,
          corrections,
          expectedVisible: {
            startSeconds: expectedStart,
            endSeconds: expectedEnd,
          },
        },
      );
      setJobId(job.jobId);
      setPhase("Queued for product tracking");
      setUploadPercent(null);
      for (let attempt = 0; attempt < 600; attempt++) {
        if (generation !== jobGeneration.current) return;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const response = await fetch(
          `/api/jobs/${encodeURIComponent(job.jobId)}`,
        );
        const state = await response.json();
        if (!response.ok)
          throw new Error(state.error || "Could not read analysis status.");
        if (generation !== jobGeneration.current) return;
        if (state.status === "cancelled")
          throw new Error(
            "Analysis was canceled. Your uploaded take is still available.",
          );
        if (state.status === "failed")
          throw new Error(
            typeof state.error === "string"
              ? state.error
              : "Analysis failed. Try another clear seed frame.",
          );
        if (["succeeded", "completed", "needs_review"].includes(state.status)) {
          const result = TakeAnalysisSchema.safeParse(state.result);
          if (!result.success)
            throw new Error(
              "The analysis response was incomplete. Your local video is still available.",
            );
          setAnalysis(result.data);
          remember({
            analysis: result.data,
            takeId: uploadedTakeId,
            uploadComplete: true,
            revised: false,
          });
          setPhase(
            result.data.coverage.needsReview
              ? "Needs a tracking correction"
              : "Analysis ready",
          );
          setRevised(false);
          return;
        }
        setPhase(
          state.status === "running"
            ? "Tracking product and measuring framing"
            : "Queued for product tracking",
        );
      }
      throw new Error(
        "Analysis is still taking time. Refresh the service status before trying again.",
      );
    } catch (err) {
      if (generation === jobGeneration.current)
        setError(
          err instanceof Error ? err.message : "Analysis could not finish.",
        );
    } finally {
      if (generation === jobGeneration.current) setBusy(false);
    }
  };
  const revise = async () => {
    if (!analysis || revised) return;
    setRevising(true);
    setError("");
    try {
      const response = await fetch("/api/revisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan, analysis: { jobId: analysis.jobId } }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          result.error || result.message || "Revision could not be created.",
        );
      if (!result.plan) throw new Error("The revision did not include a plan.");
      setProposal({
        plan: result.plan,
        reason: result.reason,
        revisionId: result.revisionId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revision unavailable.");
    } finally {
      setRevising(false);
    }
  };
  const acceptRevision = async () => {
    if (!proposal) return;
    setRevising(true);
    try {
      const response = await fetch(
        `/api/revisions/${encodeURIComponent(proposal.revisionId)}/accept`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPlanId: plan.id }),
        },
      );
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || "Could not apply this revision.");
      setRevised(true);
      remember({ revised: true });
      onRevision(proposal.plan, plan);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not apply revision.",
      );
    } finally {
      setRevising(false);
    }
  };
  const cancelJob = async () => {
    jobGeneration.current++;
    setBusy(false);
    setPhase("Analysis canceled");
    if (jobId) {
      try {
        const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
          method: "DELETE",
        });
        if (!response.ok) throw new Error();
      } catch {
        setError("Could not cancel the server job. Check service status.");
      }
    }
  };
  const deleteTake = async () => {
    if (!takeId) return;
    try {
      const response = await fetch(`/api/takes/${encodeURIComponent(takeId)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error();
      jobGeneration.current++;
      setBusy(false);
      setTakeId(null);
      setJobId(null);
      setAnalysis(null);
      setProposal(null);
      setUploadComplete(false);
      remember({ takeId: null, analysis: null, uploadComplete: false });
      if (!file) setUrl("");
      onNotice(
        "Uploaded media deleted. Your local video remains on this device.",
      );
    } catch {
      setError("Could not delete uploaded media. Try again when connected.");
    }
  };
  const nearest = analysis?.tracks.reduce(
    (best, frame) =>
      Math.abs(frame.timestamp - time) < Math.abs(best.timestamp - time)
        ? frame
        : best,
    analysis.tracks[0],
  );
  const overlay = analysis ? nearest?.box : rect;
  const intended = samplePlan(
    plan,
    duration ? Math.min(1, time / duration) : 0,
  ).framingBox;
  const comparison = takeHistory.attempts.find((item) => item.id === compareId);
  const completedAttempts = takeHistory.attempts.filter(
    (item) => item.analysis,
  );
  return (
    <div className="review-workspace">
      <div className="shot-heading">
        <div>
          <div className="eyebrow">
            <span className="shot-index">SHOT 01</span>
            <span className="separator-dot">·</span>WATCH THE ACTUAL TAKE
          </div>
          <h1>
            From plan to playback<span className="heading-period">.</span>
          </h1>
          <p>
            Find the moments worth adjusting. Carry one change into the next
            take.
          </p>
        </div>
        <span className="review-badge">
          <Film size={14} /> {plan.name}
        </span>
      </div>
      {takeHistory.attempts.length > 0 && (
        <div className="attempt-bar">
          <div>
            <span className="eyebrow">YOUR TAKES</span>
            <div className="attempt-tabs">
              {takeHistory.attempts.map((saved, i) => (
                <button
                  key={saved.id}
                  className={saved.id === attemptId ? "active" : ""}
                  disabled={busy}
                  onClick={() => openAttempt(saved)}
                >
                  <span>Take {i + 1}</span>
                  <small>
                    {saved.analysis
                      ? "Analyzed"
                      : saved.takeId
                        ? "Uploaded"
                        : "Local clip"}
                  </small>
                </button>
              ))}
              <label className="new-take-button">
                + New take
                <input
                  type="file"
                  accept="video/*"
                  disabled={busy || revising}
                  aria-label="Choose another take"
                  onChange={(e) => chooseFile(e.target.files?.[0])}
                />
              </label>
            </div>
          </div>
          <span className="attempt-note">
            Each take keeps its original plan.
          </span>
        </div>
      )}
      <div className="review-columns">
        <div className="review-main">
          {!url ? (
            <label
              className="upload-zone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                chooseFile(e.dataTransfer.files[0]);
              }}
            >
              <span className="upload-art">
                <Film size={30} />
                <span>
                  <PlusMark />
                </span>
              </span>
              <h2>Your first take starts here.</h2>
              <p>
                Drop in the actual clip to review your framing.
                <br />
                MP4, MOV, or WebM · 5–15 seconds · up to 100 MB
              </p>
              <span className="button primary">
                <Upload size={14} /> Choose a take
              </span>
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm,.m4v"
                aria-label="Choose a take"
                onChange={(e) => chooseFile(e.target.files?.[0])}
              />
              <span className="upload-private">
                <LockKeyhole size={12} /> Playback stays on this device until
                you upload.
              </span>
            </label>
          ) : (
            <>
              <div className="video-panel">
                <div className="video-heading">
                  <span>
                    <Film size={14} />
                    {fileName}
                  </span>
                  <label className="text-button">
                    Replace
                    <input
                      type="file"
                      accept="video/*"
                      disabled={busy || revising}
                      className="sr-only"
                      onChange={(e) => chooseFile(e.target.files?.[0])}
                    />
                  </label>
                </div>
                <div
                  className={`video-stage ${drawing ? "drawing" : ""}`}
                  style={{ aspectRatio: ratio }}
                  onPointerDown={startBox}
                  onPointerMove={moveBox}
                  onPointerUp={endBox}
                >
                  <video
                    ref={video}
                    src={url}
                    playsInline
                    controls={!drawing}
                    onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
                    onLoadedMetadata={(e) => {
                      const v = e.currentTarget;
                      setDuration(v.duration);
                      if (!seed && !analysis)
                        setExpectedEnd(
                          Number(Math.min(15, v.duration).toFixed(2)),
                        );
                      setRatio(v.videoWidth / v.videoHeight || 16 / 9);
                      remember({
                        duration: v.duration,
                        ratio: v.videoWidth / v.videoHeight || 16 / 9,
                      });
                      if (
                        !Number.isFinite(v.duration) ||
                        v.duration < 5 ||
                        v.duration > 15
                      )
                        setError(
                          "Use a clip between 5 and 15 seconds. Local playback is available, but analysis needs a shorter take.",
                        );
                    }}
                    onError={() =>
                      setError(
                        "This browser cannot play the clip. Export it as H.264 MP4 and try again.",
                      )
                    }
                  />
                  {showTarget && !drawing && (
                    <div
                      className="intended-box"
                      style={{
                        left: `${(intended.centerX - intended.width / 2) * 100}%`,
                        top: `${(intended.centerY - intended.height / 2) * 100}%`,
                        width: `${intended.width * 100}%`,
                        height: `${intended.height * 100}%`,
                      }}
                    >
                      <span>Planned framing</span>
                    </div>
                  )}
                  {overlay && (
                    <div
                      className={`product-box ${analysis && nearest?.visibility !== "visible" ? "uncertain" : ""}`}
                      style={{
                        left: `${overlay.x * 100}%`,
                        top: `${overlay.y * 100}%`,
                        width: `${overlay.width * 100}%`,
                        height: `${overlay.height * 100}%`,
                      }}
                    >
                      <span>
                        {analysis
                          ? nearest?.visibility === "visible"
                            ? "Tracked product"
                            : nearest?.visibility
                          : "Your product"}
                      </span>
                    </div>
                  )}
                  {drawing && (
                    <span className="draw-instruction">
                      Drag a box around the product
                    </span>
                  )}
                </div>
                <div className="annotation-toolbar">
                  <button
                    className={`button ${drawing ? "primary" : ""}`}
                    onClick={() => {
                      video.current?.pause();
                      setDrawing(!drawing);
                      setAnalysis(null);
                    }}
                  >
                    <Crosshair size={14} />
                    {drawing ? "Finish marking" : "Mark product"}
                  </button>
                  <span>
                    {seed
                      ? `Seed at ${seed.timeSeconds.toFixed(2)} s`
                      : "Pause on a clear frame, then mark the product."}
                  </span>
                  {seed && (
                    <button
                      className="icon-button"
                      aria-label="Clear product annotations"
                      title="Clear product annotations"
                      onClick={() => {
                        setSeed(null);
                        setRect(null);
                        setCorrections([]);
                        setAnalysis(null);
                      }}
                    >
                      <RotateCcw size={14} />
                    </button>
                  )}
                </div>
              </div>
              <label className="target-toggle">
                <input
                  type="checkbox"
                  checked={showTarget}
                  onChange={(e) => setShowTarget(e.target.checked)}
                />{" "}
                Show planned framing at the same take progress
              </label>
              <div className="frame-scrubber">
                <span className="mono">{time.toFixed(2)} s</span>
                <input
                  aria-label="Review time"
                  type="range"
                  min={0}
                  max={duration || 1}
                  value={Math.min(time, duration)}
                  step={0.01}
                  onChange={(e) => seek(Number(e.target.value))}
                />
                <span className="mono">{duration.toFixed(2)} s</span>
              </div>
            </>
          )}
          {analysis && (
            <>
              <section className="analysis-summary">
                <span className="eyebrow">YOUR TAKE, MEASURED</span>
                <h2>
                  {analysis.coverage.needsReview
                    ? "Check the product track."
                    : "A closer look at the take."}
                </h2>
                <p>{analysis.summary}</p>
                <div className="analysis-stats">
                  <div>
                    <strong>
                      {analysis.coverage.measuredFrames}
                      <small> / {analysis.coverage.expectedFrames}</small>
                    </strong>
                    <span>Reliable expected frames</span>
                  </div>
                  <div>
                    <strong>{analysis.coverage.missingFrames}</strong>
                    <span>Untracked frames</span>
                  </div>
                  <div>
                    <strong>{analysis.coverage.uncertainFrames}</strong>
                    <span>Uncertain frames</span>
                  </div>
                </div>
                <CoverageChart analysis={analysis} plan={plan} seek={seek} />
              </section>
              <div className="findings-list">
                {analysis.findings.map((finding, i) => (
                  <article className="finding-card" key={i}>
                    <div>
                      <span className="finding-number">0{i + 1}</span>
                      <span className="tiny-label">
                        {finding.phase} · {finding.kind}
                      </span>
                    </div>
                    <h3>{finding.title}</h3>
                    <p>{finding.detail}</p>
                    <p className="finding-suggestion">{finding.suggestion}</p>
                    {finding.evidence?.map((evidence, j) => (
                      <button
                        className="evidence-thumbnail"
                        key={j}
                        onClick={() => seek(evidence.timestamp)}
                      >
                        <Image
                          unoptimized
                          src={`/api/takes/${encodeURIComponent(analysis.takeId)}/media?artifact=${encodeURIComponent(evidence.objectKey)}`}
                          alt={`Tracked product mask boundary at ${evidence.timestamp.toFixed(2)} seconds`}
                          width={480}
                          height={270}
                        />
                        <span>
                          Tracked mask boundary ·{" "}
                          {evidence.timestamp.toFixed(2)} s
                        </span>
                      </button>
                    ))}
                    <div className="evidence-times">
                      {finding.evidenceTimestamps.map((timestamp, j) => (
                        <button key={j} onClick={() => seek(timestamp)}>
                          <Play size={11} />
                          {timestamp.toFixed(2)} s
                        </button>
                      ))}
                    </div>
                    <small>
                      {finding.affectedFrames} affected /{" "}
                      {finding.measuredPhaseFrames} measured phase frames
                    </small>
                  </article>
                ))}
              </div>
              {completedAttempts.length > 1 && (
                <section className="take-comparison">
                  <div className="section-heading">
                    <h3>Compare your takes</h3>
                    <label>
                      <span className="sr-only">Compare with take</span>
                      <select
                        aria-label="Compare with take"
                        value={compareId}
                        onChange={(e) => setCompareId(e.target.value)}
                      >
                        <option value="">Choose another take</option>
                        {completedAttempts
                          .filter((item) => item.id !== attemptId)
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  {comparison?.analysis && (
                    <table>
                      <thead>
                        <tr>
                          <th>Measurement</th>
                          <th>This take</th>
                          <th>{comparison.name}</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>Duration</td>
                          <td>{analysis.video.durationSeconds.toFixed(2)} s</td>
                          <td>
                            {comparison.analysis.video.durationSeconds.toFixed(
                              2,
                            )}{" "}
                            s
                          </td>
                        </tr>
                        <tr>
                          <td>Reliable expected frames</td>
                          <td>
                            {analysis.coverage.measuredFrames}/
                            {analysis.coverage.expectedFrames}
                          </td>
                          <td>
                            {comparison.analysis.coverage.measuredFrames}/
                            {comparison.analysis.coverage.expectedFrames}
                          </td>
                        </tr>
                        <tr>
                          <td>Uncertain frames</td>
                          <td>{analysis.coverage.uncertainFrames}</td>
                          <td>
                            {comparison.analysis.coverage.uncertainFrames}
                          </td>
                        </tr>
                        <tr>
                          <td>Findings</td>
                          <td>
                            {analysis.findings
                              .map((item) => item.title)
                              .join("; ") || "None reported"}
                          </td>
                          <td>
                            {comparison.analysis.findings
                              .map((item) => item.title)
                              .join("; ") || "None reported"}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  )}
                  <p className="help-text">
                    Different plans and tracking coverage can change the
                    findings. These counts are not a quality score.
                  </p>
                </section>
              )}
              <details className="analysis-provenance">
                <summary>Analysis evidence & limits</summary>
                <p>
                  {analysis.provenance.model}; real inference on{" "}
                  {analysis.provenance.device}. Rules:{" "}
                  {analysis.provenance.rulesVersion}.
                </p>
                {analysis.limitations.map((limitation, i) => (
                  <p key={i}>{limitation}</p>
                ))}
                <p>
                  Image measurements describe framing, not the physical camera
                  path.
                </p>
              </details>
            </>
          )}
        </div>
        <aside className="review-inspector">
          <section>
            <span className="eyebrow">SET UP THE REVIEW</span>
            <h2>Give tracking a clear start.</h2>
            <ol className="review-steps">
              <li>
                <span className={url ? "done" : ""}>
                  {url ? <CheckCircle2 size={14} /> : "1"}
                </span>
                <div>
                  <strong>Load your take</strong>
                  <p>A short, original clip from your camera.</p>
                </div>
              </li>
              <li>
                <span className={seed ? "done" : ""}>
                  {seed ? <CheckCircle2 size={14} /> : "2"}
                </span>
                <div>
                  <strong>Mark the product</strong>
                  <p>
                    Pause on a clear frame. Draw a box around the entire
                    product.
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <strong>Set the visible interval</strong>
                  <p>Exclude an intentionally hidden reveal or exit.</p>
                </div>
              </li>
            </ol>
            {url && (
              <details className="numeric-annotation">
                <summary>Mark with coordinates</summary>
                <p className="help-text">
                  Enter percentages of the upright frame. This also works with a
                  keyboard.
                </p>
                <NumberField
                  label="Annotation time"
                  unit="s"
                  value={time}
                  min={0}
                  max={duration || 15}
                  step={0.1}
                  onChange={seek}
                />
                <div className="field-grid">
                  <NumberField
                    label="Box left"
                    unit="%"
                    value={(rect?.x ?? 0.35) * 100}
                    min={0}
                    max={99}
                    step={1}
                    onChange={(v) => setNumericBox({ x: v / 100 })}
                  />
                  <NumberField
                    label="Box top"
                    unit="%"
                    value={(rect?.y ?? 0.2) * 100}
                    min={0}
                    max={99}
                    step={1}
                    onChange={(v) => setNumericBox({ y: v / 100 })}
                  />
                  <NumberField
                    label="Box width"
                    unit="%"
                    value={(rect?.width ?? 0.3) * 100}
                    min={1}
                    max={100 - (rect?.x ?? 0.35) * 100}
                    step={1}
                    onChange={(v) => setNumericBox({ width: v / 100 })}
                  />
                  <NumberField
                    label="Box height"
                    unit="%"
                    value={(rect?.height ?? 0.6) * 100}
                    min={1}
                    max={100 - (rect?.y ?? 0.2) * 100}
                    step={1}
                    onChange={(v) => setNumericBox({ height: v / 100 })}
                  />
                </div>
                <button
                  className="button"
                  onClick={() => {
                    const marked = {
                      timeSeconds: time,
                      box: rect ?? { x: 0.35, y: 0.2, width: 0.3, height: 0.6 },
                    };
                    setSeed(marked);
                    setRect(marked.box);
                    setDrawing(false);
                    setAnalysis(null);
                    remember({ seed: marked, analysis: null });
                  }}
                >
                  Use box at this frame
                </button>
              </details>
            )}
            <div className="field-grid">
              <NumberField
                label="Visible from"
                unit="s"
                value={expectedStart}
                min={0}
                max={Math.max(0, expectedEnd - 0.01)}
                step={0.1}
                onChange={setExpectedStart}
              />
              <NumberField
                label="Visible until"
                unit="s"
                value={expectedEnd}
                min={expectedStart + 0.01}
                max={duration || 15}
                step={0.1}
                onChange={setExpectedEnd}
              />
            </div>
            {seed && (
              <div className="correction-controls">
                <button
                  className="text-button"
                  disabled={!rect || corrections.length >= 4}
                  onClick={() => {
                    if (rect) {
                      setCorrections([
                        ...corrections,
                        { timeSeconds: time, box: rect },
                      ]);
                      setDrawing(false);
                      onNotice(
                        `Correction saved at ${time.toFixed(2)} seconds.`,
                      );
                    }
                  }}
                >
                  + Save this frame as a correction
                </button>
                <p className="help-text">
                  Mark the box again on a difficult frame, then save it.{" "}
                  {corrections.length}/4 corrections.
                </p>
                {corrections.map((correction, i) => (
                  <div className="correction-row" key={i}>
                    <button onClick={() => seek(correction.timeSeconds)}>
                      Frame at {correction.timeSeconds.toFixed(2)} s
                    </button>
                    <button
                      aria-label={`Remove correction ${i + 1}`}
                      onClick={() =>
                        setCorrections(corrections.filter((_, j) => i !== j))
                      }
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
          <section className="analysis-action">
            <div className="private-heading">
              <LockKeyhole size={15} />
              <strong>Private by default</strong>
            </div>
            <p>
              Your take is uploaded only when you start analysis. Product
              tracking and measurements run on the connected worker.
            </p>
            <label className="consent-checkbox">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                Allow this take to be used for training. Optional; off by
                default.
              </span>
            </label>
            <button
              className="button primary wide"
              disabled={
                !connected ||
                !seed ||
                (!file && !takeId) ||
                busy ||
                duration < 5 ||
                duration > 15
              }
              onClick={analyze}
            >
              {busy ? (
                <Loader2 size={15} className="spin" />
              ) : (
                <Upload size={14} />
              )}{" "}
              {busy
                ? "Analyzing take…"
                : takeId
                  ? "Analyze again"
                  : "Upload & analyze"}{" "}
              {!busy && <ArrowRight size={14} />}
            </button>
            {busy && (
              <div role="status" className="job-progress">
                <span>
                  {phase}
                  {uploadPercent !== null ? ` · ${uploadPercent}%` : ""}
                </span>
                <div>
                  <i
                    style={{
                      width:
                        uploadPercent !== null ? `${uploadPercent}%` : "40%",
                    }}
                  />
                </div>
              </div>
            )}
            {busy && jobId && (
              <button className="text-button job-cancel" onClick={cancelJob}>
                Cancel analysis
              </button>
            )}
            {takeId && !busy && (
              <button className="text-button job-cancel" onClick={deleteTake}>
                Delete uploaded media
              </button>
            )}
            {!connected && (
              <p className="connection-note">
                Hosted analysis is not configured. You can play and mark your
                take locally. Connect private storage and the video worker to
                run tracking.
              </p>
            )}
          </section>
          {analysis && (
            <section className="revision-action">
              <span className="eyebrow">THE NEXT TAKE</span>
              <h2>One considered revision.</h2>
              <p>
                {analysis.coverage.needsReview
                  ? "Add a correction and analyze again. Uncertain tracking needs review before changing your plan."
                  : "Use the measured findings to create one revised plan. Your original version is kept for comparison."}
              </p>
              {proposal && (
                <div className="revision-proposal">
                  <strong>Proposed: {proposal.plan.name}</strong>
                  <p>{proposal.reason}</p>
                  <p>
                    {proposal.plan.durationSeconds.toFixed(1)} s ·{" "}
                    {proposal.plan.cameraHeight.toFixed(2)} m high ·{" "}
                    {proposal.plan.arcLength.toFixed(2)} m path
                  </p>
                  <button
                    className="button primary wide"
                    disabled={revising || revised}
                    onClick={acceptRevision}
                  >
                    Apply this revision <ArrowRight size={14} />
                  </button>
                  <button
                    className="text-button"
                    onClick={() => setProposal(null)}
                  >
                    Keep original plan
                  </button>
                </div>
              )}
              {!proposal && (
                <button
                  className="button primary wide"
                  disabled={
                    analysis.coverage.needsReview ||
                    revising ||
                    revised ||
                    !analysis.findings.length
                  }
                  onClick={revise}
                >
                  {revising ? (
                    <Loader2 size={15} className="spin" />
                  ) : (
                    <ArrowRight size={15} />
                  )}{" "}
                  {revising
                    ? "Revising…"
                    : revised
                      ? "Revision created"
                      : "Propose one revision"}
                </button>
              )}
            </section>
          )}
        </aside>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function PlusMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
function CoverageChart({
  analysis,
  plan,
  seek,
}: {
  analysis: TakeAnalysis;
  plan: PlanVersion;
  seek: (t: number) => void;
}) {
  const width = 600,
    height = 110,
    duration = analysis.video.durationSeconds;
  const d = analysis.tracks
    .map((track, i) => {
      if (!track.box || track.visibility !== "visible") return "";
      const previous = analysis.tracks[i - 1];
      return `${previous?.box && previous.visibility === "visible" ? "L" : "M"} ${((track.timestamp / duration) * width).toFixed(2)} ${(height - track.box.height * height).toFixed(2)}`;
    })
    .join(" ");
  const target = Array.from(
    { length: 41 },
    (_, i) =>
      `${i ? "L" : "M"} ${((i / 40) * width).toFixed(2)} ${(height - samplePlan(plan, i / 40).framingBox.height * height).toFixed(2)}`,
  ).join(" ");
  return (
    <div className="coverage-chart">
      <div>
        <strong>Product height in frame</strong>
        <span>Green: observed · amber: planned</span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Observed product coverage over time"
        onClick={(e) => {
          const bounds = e.currentTarget.getBoundingClientRect();
          seek(((e.clientX - bounds.left) / bounds.width) * duration);
        }}
      >
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={0}
            x2={width}
            y1={height * fraction}
            y2={height * fraction}
            stroke="#e0e4d9"
            strokeDasharray="3 5"
          />
        ))}
        <path
          d={target}
          fill="none"
          stroke="#bb8c4b"
          strokeWidth={1.5}
          strokeDasharray="6 5"
        />
        <path d={d} fill="none" stroke="#2c6d54" strokeWidth={2} />
      </svg>
      <div>
        <span>0 s</span>
        <span>{duration.toFixed(1)} s</span>
      </div>
    </div>
  );
}
