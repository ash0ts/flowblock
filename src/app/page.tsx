"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Copy,
  FileImage,
  FolderOpen,
  Grid2X2,
  History,
  Link2,
  Loader2,
  MoreHorizontal,
  MoveUpRight,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  WifiOff,
  X,
} from "lucide-react";
import { recipes, samplePlan, planShots } from "@/domain";
import { PlanVersionSchema, type Family } from "@/domain/contracts";
import { useTakeHistory } from "@/client/takes";
import { getPendingWrites, subscribeStorage } from "@/client/storage";
import { selectedPlan, useWorkspace } from "@/client/store";
import { Inspector } from "@/components/Inspector";
import { FramingPreview, SceneCanvas } from "@/components/SceneCanvas";
import { Review } from "@/components/Review";
import Link from "next/link";
import { useConnections } from "@/client/connections";
import { VersionsDialog } from "@/components/VersionsDialog";

const subscribeOnline = (callback: () => void) => {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
};

type Tab = "plan" | "rehearse" | "review";
type Status = {
  inference: boolean;
  storage: boolean;
  database: boolean;
  auth: boolean;
  worker: boolean;
  mode: string;
  model: string;
  limitations: string[];
  training: { status: string };
};

function MoveGlyph({
  family,
  large = false,
}: {
  family: Family;
  large?: boolean;
}) {
  const paths: Record<Family, string> = {
    hold: "M9 16h14M16 9v14",
    "push-in": "M7 24L24 7M14 7h10v10",
    "pull-out": "M24 7L7 24M7 14v10h10",
    lateral: "M5 16h22M21 10l6 6-6 6",
    orbit: "M7 24C-1 8 24-2 26 16M21 12l5 5 4-6",
    reveal: "M5 25V8h22M21 3l6 5-6 5",
  };
  return (
    <svg
      className={large ? "move-glyph large" : "move-glyph"}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
    >
      <path
        d={paths[family]}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="16" cy="25" r="2" fill="currentColor" opacity=".3" />
    </svg>
  );
}

export default function WorkspacePage() {
  const s = useWorkspace();
  const pendingWrites = useSyncExternalStore(
    subscribeStorage,
    getPendingWrites,
    () => 0,
  );
  const plan = useMemo(() => selectedPlan(s), [s]);
  const [tab, setTab] = useState<Tab>("plan");
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [storageFailed, setStorageFailed] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportsOpen, setExportsOpen] = useState(false);
  const offline = !useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [playbackPlanId, setPlaybackPlanId] = useState(plan.id);
  const [helpOpen, setHelpOpen] = useState(false);
  const [family, setFamily] = useState<string>("all");
  const requestId = useRef(0);
  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/status");
      if (response.ok) setStatus(await response.json());
    } catch {
      /* Offline planning remains available. */
    }
  }, []);
  useEffect(() => {
    let active = true;
    const failedStorage = () => {
      setStorageFailed(true);
      setNotice(
        "Browser storage is unavailable. Export your plan before closing this tab.",
      );
    };
    const recoveredStorage = () =>
      setNotice(
        "Some saved browser data could not be opened. A fresh workspace is available; other saved data is unchanged.",
      );
    window.addEventListener("flowblock-storage-error", failedStorage);
    window.addEventListener("flowblock-storage-recovered", recoveredStorage);
    Promise.all([
      useWorkspace.persist.rehydrate(),
      useConnections.persist.rehydrate(),
      useTakeHistory.persist.rehydrate(),
    ]).then(() => useWorkspace.getState().markHydrated());
    fetch("/api/status")
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (active && result) setStatus(result);
      })
      .catch(() => {});
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production")
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      active = false;
      window.removeEventListener("flowblock-storage-error", failedStorage);
      window.removeEventListener(
        "flowblock-storage-recovered",
        recoveredStorage,
      );
    };
  }, []);
  if (playbackPlanId !== plan.id) {
    setPlaybackPlanId(plan.id);
    setProgress(0);
    setPlaying(false);
  }
  useEffect(() => {
    if (!playing) return;
    let last: number | undefined;
    let frame: number;
    const tick = (now: number) => {
      // Use the frame clock throughout; its first timestamp can precede performance.now().
      last ??= now;
      const delta = (now - last) / 1000 / plan.durationSeconds;
      last = now;
      setProgress((p) => {
        if (p + delta >= 1) {
          setPlaying(false);
          return 1;
        }
        return p + delta;
      });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, plan.durationSeconds]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 9000);
    return () => clearTimeout(timer);
  }, [notice]);
  const generate = async () => {
    setBusy(true);
    const id = ++requestId.current;
    const intent = { ...s.intent, brief: s.prompt };
    s.updateIntent(intent);
    const inputSnapshot = JSON.stringify({
      scene: s.scene,
      gear: s.gear,
      intent,
      prompt: s.prompt,
      recipeId: s.recipeId,
    });
    const isCurrent = () => {
      const current = useWorkspace.getState();
      return (
        JSON.stringify({
          scene: current.scene,
          gear: current.gear,
          intent: current.intent,
          prompt: current.prompt,
          recipeId: current.recipeId,
        }) === inputSnapshot
      );
    };
    try {
      if (!navigator.onLine) throw new Error("offline");
      const response = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scene: s.scene,
          gear: s.gear,
          intent,
          prompt: s.prompt,
        }),
        signal: AbortSignal.timeout(45000),
      });
      const result = await response.json();
      const parsedPlans = PlanVersionSchema.array()
        .max(12)
        .safeParse(result.plans);
      if (!response.ok || !parsedPlans.success)
        throw new Error(
          result.error || "The planner returned an invalid response",
        );
      if (id === requestId.current) {
        if (!isCurrent()) {
          setNotice(
            "Your shot changed while planning. Kept your edits; generate again to use them.",
          );
          return;
        }
        const message =
          typeof result.message === "string" && result.message.trim()
            ? result.message
            : result.plans.length
              ? `${result.plans.length} moves compiled and checked against your space.`
              : "No camera move fits this brief with the current space and gear. Adjust the scene or direction and try again.";
        s.setPlans(
          parsedPlans.data.slice(0, 3),
          result.source === "forge" ? "forge" : "library",
          message,
        );
        setNotice(message);
      }
    } catch {
      if (id === requestId.current) {
        if (!isCurrent()) {
          setNotice(
            "Your shot changed while planning. Kept your edits; generate again to use them.",
          );
          return;
        }
        const plans = planShots(s.scene, s.gear, intent)
          .filter((candidate) => candidate.validation.valid)
          .slice(0, 3);
        const message = plans.length
          ? "Built from the local move library. Hosted planning is unavailable; your scene and controls still work."
          : "No recipe fits the current space and gear. Review the geometry notes, adjust the scene, and try again.";
        s.setPlans(plans, "local", message);
        setNotice(message);
      }
    } finally {
      setBusy(false);
    }
  };
  const exportPng = async () => {
    setExportsOpen(false);
    const svg = document.getElementById("shot-canvas");
    if (!svg) {
      setNotice("Open Plan or Rehearse to export the room canvas.");
      return;
    }
    const xml = new XMLSerializer().serializeToString(svg);
    const url = URL.createObjectURL(
      new Blob([xml], { type: "image/svg+xml;charset=utf-8" }),
    );
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1600;
      canvas.height = 1400;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#eeefe7";
        ctx.fillRect(0, 0, 1600, 1400);
        ctx.drawImage(img, 0, 80, 1600, 1200);
        ctx.fillStyle = "#163e35";
        ctx.font = "32px sans-serif";
        ctx.fillText(`FlowBlock / ${plan.name}`, 64, 58);
        ctx.font = "20px sans-serif";
        ctx.fillText(
          `${plan.durationSeconds}s · ${plan.gear.lens.focalLengthMm} mm · ${plan.cameraHeight.toFixed(2)} m camera height · Geometric plan only`,
          64,
          1352,
        );
        canvas.toBlob((blob) => {
          if (blob) {
            const link = document.createElement("a");
            link.href = URL.createObjectURL(blob);
            link.download = `flowblock-${plan.recipeId}.png`;
            link.click();
            setTimeout(() => URL.revokeObjectURL(link.href), 1000);
          }
        });
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setNotice("Image export failed. Use the print export instead.");
    };
    img.src = url;
  };
  const createShare = async () => {
    setExportsOpen(false);
    setNotice("Creating a read-only plan link…");
    try {
      const response = await fetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || "Sharing requires connected storage.");
      const shareUrl = new URL(body.url, location.origin).href;
      useConnections.getState().addShare({
        token: body.token,
        url: shareUrl,
        planId: plan.id,
        name: plan.name,
        createdAt: new Date().toISOString(),
      });
      try {
        await navigator.clipboard.writeText(shareUrl);
        setNotice(
          "Plan link copied. Manage or revoke it in Saved versions. The link does not include video.",
        );
      } catch {
        setNotice(
          "Plan link created. Open Saved versions to copy or revoke it.",
        );
      }
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Could not create a link.",
      );
    }
  };
  const togglePlayback = () => {
    if (progress >= 1) setProgress(0);
    setPlaying(!playing);
  };
  const recipe = recipes.find((r) => r.id === s.recipeId)!;
  const sample = samplePlan(plan, progress);
  const valid = plan.validation.valid;
  const visibleRecipes = recipes.filter(
    (r) => family === "all" || r.family === family,
  );
  return (
    <div className="app-shell" inert={!s.hydrated} aria-busy={!s.hydrated}>
      <header className="app-header">
        <Link href="/" className="brand" aria-label="FlowBlock home">
          <span className="brand-mark">
            <i />
            <i />
            <i />
          </span>
          <span>
            FlowBlock<span className="brand-dot">.</span>
          </span>
        </Link>
        <div className="project-crumb">
          <span>Workspace</span>
          <span className="crumb-slash">/</span>
          <strong>Product study</strong>
          <span className="project-tag">01</span>
        </div>
        <div className="header-actions">
          <span className="save-status">
            {offline ? <WifiOff size={12} /> : <span className="status-dot" />}
            {storageFailed
              ? "Storage unavailable"
              : !s.hydrated
                ? "Opening workspace"
                : pendingWrites > 0
                  ? "Saving on this device…"
                  : offline
                    ? "Offline · local workspace"
                    : "Saved on this device"}
          </span>
          <div className="export-wrap">
            <button
              className="button export-button"
              onClick={() => setExportsOpen(!exportsOpen)}
            >
              <ArrowDownToLine size={14} />
              <span>Export plan</span>
              <ChevronDown size={12} />
            </button>
            {exportsOpen && (
              <div className="dropdown export-menu">
                <button
                  onClick={() => {
                    setExportsOpen(false);
                    setHistoryOpen(true);
                  }}
                >
                  <History size={15} /> Saved versions
                </button>
                <button onClick={exportPng}>
                  <FileImage size={15} /> Download canvas PNG
                </button>
                <button
                  onClick={() => {
                    setExportsOpen(false);
                    window.print();
                  }}
                >
                  <Copy size={15} /> Print / save PDF
                </button>
                <button onClick={createShare}>
                  <Link2 size={15} /> Create read-only link
                </button>
              </div>
            )}
          </div>
          <button
            className="avatar"
            onClick={() => setStatusOpen(true)}
            aria-label="Open connection status"
          >
            S
          </button>
        </div>
      </header>
      <div className="workspace-layout">
        <aside className="sidebar">
          <div className="project-heading">
            <span className="eyebrow">YOUR WORKSPACE</span>
            <button
              className="icon-button"
              aria-label="Show saved versions"
              onClick={() => setHistoryOpen(true)}
            >
              <MoreHorizontal size={16} />
            </button>
          </div>
          <div className="project-card">
            <span className="project-icon">
              <FolderOpen size={18} />
            </span>
            <div>
              <strong>Product study</strong>
              <span>{s.scene.name}</span>
            </div>
          </div>
          <div className="sidebar-section-heading">
            <span className="eyebrow">SHOT LIBRARY</span>
            <span className="count">12</span>
          </div>
          <label className="sr-only" htmlFor="family-filter">
            Filter moves by family
          </label>
          <select
            className="family-filter"
            id="family-filter"
            value={family}
            onChange={(e) => setFamily(e.target.value)}
          >
            <option value="all">All movements</option>
            {["hold", "push-in", "pull-out", "lateral", "orbit", "reveal"].map(
              (f) => (
                <option key={f} value={f}>
                  {f[0].toUpperCase() + f.slice(1)}
                </option>
              ),
            )}
          </select>
          <div className="recipe-list">
            {visibleRecipes.map((r) => (
              <button
                key={r.id}
                className={`recipe-item ${s.recipeId === r.id ? "active" : ""}`}
                onClick={() => s.selectRecipe(r.id)}
              >
                <span className={`recipe-icon ${r.family}`}>
                  <MoveGlyph family={r.family} />
                </span>
                <span className="recipe-copy">
                  <strong>{r.name}</strong>
                  <span>
                    {r.family === "hold"
                      ? "Locked composition"
                      : r.family === "orbit"
                        ? "Curved camera path"
                        : r.family === "reveal"
                          ? "Angled entrance"
                          : r.family === "lateral"
                            ? "Across the product"
                            : r.family === "push-in"
                              ? "Toward the product"
                              : "Open up the scene"}
                  </span>
                </span>
                {s.recipeId === r.id && <span className="active-indicator" />}
              </button>
            ))}
          </div>
          <div className="sidebar-bottom">
            <button onClick={() => setHistoryOpen(true)}>
              <History size={15} /> Saved versions{" "}
              <span>{s.history.length}</span>
            </button>
            <button onClick={() => setHelpOpen(true)}>
              <CircleHelp size={15} /> A quick field guide
              <ArrowUpRight size={12} />
            </button>
            <button onClick={() => setStatusOpen(true)}>
              <Settings2 size={15} /> Connections & status
              <span
                className={`connection-dot ${status?.inference ? "connected" : ""}`}
              />
            </button>
            <div className="local-note">
              <span className="status-dot" />
              <span>Designed for your next take.</span>
            </div>
          </div>
        </aside>
        <main className={`main-workspace tab-${tab}`}>
          <nav className="workflow-tabs" aria-label="Shot workflow">
            {(["plan", "rehearse", "review"] as Tab[]).map((v, i) => (
              <button
                key={v}
                className={tab === v ? "active" : ""}
                onClick={() => {
                  setTab(v);
                  setPlaying(false);
                }}
              >
                <span className="step-number">{i + 1}</span>
                {v[0].toUpperCase() + v.slice(1)}
                {i < 2 && <span className="step-connector" />}
              </button>
            ))}
            <span className="workflow-caption">
              A little planning. A better take.
            </span>
          </nav>
          {tab !== "review" ? (
            <>
              <div className="shot-heading">
                <div>
                  <div className="eyebrow">
                    <span className="shot-index">SHOT 01</span>
                    <span className="separator-dot">·</span>
                    {tab === "rehearse" ? "WALK IT THROUGH" : "MAKE THE MOVE"}
                  </div>
                  <h1>
                    {plan.name}
                    <span className="heading-period">.</span>
                  </h1>
                  <p>{recipe.description}</p>
                </div>
                <div className="shot-heading-actions">
                  <button
                    className="icon-button"
                    onClick={() => {
                      s.saveVersion(plan);
                      setNotice("Plan version saved on this device.");
                    }}
                    title="Save this version"
                    aria-label="Save this version"
                  >
                    <Plus size={18} />
                  </button>
                  <span className={`validation-chip ${valid ? "" : "warning"}`}>
                    {valid ? (
                      <CheckCircle2 size={12} />
                    ) : (
                      <ShieldAlert size={12} />
                    )}{" "}
                    {valid ? "Geometry checked" : "Needs adjustment"}
                  </span>
                </div>
              </div>
              {tab === "plan" && (s.plans.length > 0 || s.planningResult) && (
                <section
                  className="candidate-section"
                  aria-label="Options for your brief"
                >
                  <div className="candidate-heading">
                    <span className="eyebrow">OPTIONS FOR YOUR BRIEF</span>
                    <span>
                      {s.plans.length} {s.plans.length === 1 ? "move" : "moves"}{" "}
                      · edits stay with each shot
                    </span>
                  </div>
                  {s.plans.length === 0 ? (
                    <div className="candidate-empty" role="status">
                      <ShieldAlert size={19} />
                      <div>
                        <h2>No moves fit this brief</h2>
                        <p>{s.planningResult?.message}</p>
                        <small>
                          Your current draft is kept below for inspection.
                          Change the setup or brief, then plan again.
                        </small>
                      </div>
                    </div>
                  ) : (
                    <div className="candidate-options">
                      {s.plans.slice(0, 3).map((candidate, i) => {
                        const draft = s.drafts[candidate.recipeId] ?? candidate;
                        return (
                          <button
                            key={candidate.recipeId}
                            className={
                              s.recipeId === candidate.recipeId
                                ? "selected"
                                : ""
                            }
                            onClick={() => s.selectRecipe(candidate.recipeId)}
                          >
                            <span className="candidate-number">0{i + 1}</span>
                            <span>
                              <strong>{draft.name}</strong>
                              <small>
                                {draft.durationSeconds} s ·{" "}
                                {draft.gear.lens.focalLengthMm} mm ·{" "}
                                {draft.validation.valid ? "Checked" : "Adjust"}
                              </small>
                            </span>
                            {s.recipeId === candidate.recipeId && (
                              <Check size={13} />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
              <div className="canvas-area">
                <div className="canvas-toolbar">
                  <span>
                    <Grid2X2 size={13} /> TOP VIEW <span className="tiny-dot" />{" "}
                    METERS
                  </span>
                  <div>
                    <button
                      className="icon-button"
                      title="Reset playback"
                      aria-label="Reset playback"
                      onClick={() => {
                        setProgress(0);
                        setPlaying(false);
                      }}
                    >
                      <RotateCcw size={14} />
                    </button>
                    <span className="canvas-scale">1 square = 25 cm</span>
                  </div>
                </div>
                <div className="canvas-stage">
                  <SceneCanvas
                    plan={plan}
                    progress={progress}
                    selected={selected}
                    onSelect={setSelected}
                  />
                  {tab === "rehearse" && (
                    <div className="rehearsal-overlay">
                      <FramingPreview plan={plan} progress={progress} />
                      <span>Approximate camera view</span>
                    </div>
                  )}
                  <div className="canvas-compass">
                    <span>N</span>
                    <MoveUpRight size={20} />
                  </div>
                </div>
                <div className="canvas-legend">
                  <span>
                    <i className="legend-start" /> Start
                  </span>
                  <span>
                    <i className="legend-end" /> End
                  </span>
                  <span>
                    <i className="legend-path" /> Camera path
                  </span>
                  <span className="legend-footprint">
                    <i className="legend-operator" /> Operator footprint
                  </span>
                  <span className="canvas-instruction">
                    Select an object to edit
                  </span>
                </div>
              </div>
              <div className="playback-panel">
                <button
                  className="play-button"
                  aria-label={playing ? "Pause preview" : "Play preview"}
                  onClick={togglePlayback}
                >
                  {playing ? (
                    <Pause size={16} fill="currentColor" />
                  ) : (
                    <Play size={16} fill="currentColor" />
                  )}
                </button>
                <div className="playback-track">
                  <div className="track-labels">
                    <span>
                      {playing
                        ? "Previewing the move"
                        : tab === "rehearse"
                          ? "Follow the pace"
                          : "Preview the move"}
                    </span>
                    <span className="mono">
                      {(progress * plan.durationSeconds).toFixed(1)}{" "}
                      <span>/ {plan.durationSeconds.toFixed(1)} s</span>
                    </span>
                  </div>
                  <input
                    type="range"
                    aria-label="Shot time"
                    min={0}
                    max={1}
                    step={0.001}
                    value={progress}
                    onChange={(e) => {
                      setProgress(Number(e.target.value));
                      setPlaying(false);
                    }}
                  />
                  <div className="track-ticks">
                    <span>Start</span>
                    <span>Hold your framing</span>
                    <span>Finish</span>
                  </div>
                </div>
                <div className="path-metric">
                  <span>
                    {plan.arcLength.toFixed(2)} <small>m</small>
                  </span>
                  <small>path length</small>
                </div>
              </div>
              {tab === "plan" ? (
                <div className="intent-panel">
                  <div className="intent-heading">
                    <span className="intent-spark">
                      <Sparkles size={16} />
                    </span>
                    <div>
                      <h2>What should this shot feel like?</h2>
                      <p>Your space, your gear, your direction.</p>
                    </div>
                    <span className="source-label">
                      {s.source === "forge"
                        ? "MODEL ASSISTED"
                        : "LOCAL MOVE LIBRARY"}
                    </span>
                  </div>
                  <div className="intent-input">
                    <textarea
                      aria-label="Shot intent"
                      value={s.prompt}
                      onChange={(e) => s.setPrompt(e.target.value)}
                      maxLength={4000}
                      rows={2}
                      placeholder="A slow, confident reveal with a close finish…"
                    />
                    <button
                      className="button primary"
                      onClick={generate}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 size={15} className="spin" />
                      ) : (
                        <Sparkles size={14} />
                      )}
                      <span>{busy ? "Planning…" : "Plan my shot"}</span>
                      <ArrowUpRight size={15} />
                    </button>
                  </div>
                </div>
              ) : valid ? (
                <div className="rehearsal-guide">
                  <div className="rehearsal-step">
                    <span>01</span>
                    <div>
                      <strong>Mark your start</strong>
                      <p>
                        Camera at {samplePlan(plan, 0).position.x.toFixed(2)} m
                        X, {samplePlan(plan, 0).position.z.toFixed(2)} m Z.
                        Height {plan.cameraHeight.toFixed(2)} m.
                      </p>
                    </div>
                  </div>
                  <div className="rehearsal-step">
                    <span>02</span>
                    <div>
                      <strong>Walk the path</strong>
                      <p>
                        Check the floor and cables. Keep the product in frame;
                        slow your start and finish.
                      </p>
                    </div>
                  </div>
                  <div className="rehearsal-step">
                    <span>03</span>
                    <div>
                      <strong>Make a take</strong>
                      <p>
                        Record 5–15 seconds, then open Review to check your
                        actual footage.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rehearsal-guide invalid-rehearsal">
                  <ShieldAlert size={22} />
                  <div>
                    <strong>Adjust the plan before rehearsing</strong>
                    <p>
                      The modeled camera or operator path does not meet the
                      current constraints. Review the geometry notes below, move
                      the obstacles, or choose a different recipe. You can still
                      inspect the draft animation.
                    </p>
                  </div>
                </div>
              )}
              <div className="validation-details">
                <details>
                  <summary>
                    {valid ? (
                      <CheckCircle2 size={12} />
                    ) : (
                      <ShieldAlert size={12} />
                    )}
                    <span>
                      {valid
                        ? "Camera and operator clear the modeled obstacles."
                        : "Review the geometry before rehearsing."}
                    </span>
                    <ChevronDown size={12} />
                  </summary>
                  <div>
                    {plan.validation.violations.length ? (
                      plan.validation.violations.map((v, i) => (
                        <p key={i}>
                          <strong>
                            {v.severity === "error" ? "Adjust" : "Note"}:
                          </strong>{" "}
                          {v.message}
                        </p>
                      ))
                    ) : (
                      <p>The modeled sweep fits the measured space.</p>
                    )}
                    <p>
                      Minimum modeled clearance:{" "}
                      {Number.isFinite(plan.validation.minClearance)
                        ? `${plan.validation.minClearance.toFixed(2)} m`
                        : "not available"}
                      . Measurements, cables, people, and real equipment still
                      need a physical check.
                    </p>
                  </div>
                </details>
                <span className="position-readout">
                  X {sample.position.x.toFixed(2)} / Z{" "}
                  {sample.position.z.toFixed(2)}
                </span>
              </div>
            </>
          ) : null}
          <div className="review-preserver" hidden={tab !== "review"}>
            <Review
              active={tab === "review"}
              plan={plan}
              connected={
                !!(status?.storage && status?.worker && status?.database)
              }
              onNotice={setNotice}
              onRevision={(revision, original) => {
                s.saveVersion(original);
                s.saveVersion(revision);
                s.restore(revision);
                setTab("plan");
                setNotice(
                  "One revised plan is ready. The original is in Saved versions.",
                );
              }}
            />
          </div>
          <div className="print-summary">
            <h2>{plan.name}</h2>
            <p>{s.prompt}</p>
            <p>
              {plan.durationSeconds} seconds · {plan.gear.lens.focalLengthMm} mm
              lens · {plan.cameraHeight} m camera height ·{" "}
              {plan.arcLength.toFixed(2)} m path
            </p>
            <p>{plan.validation.violations.map((v) => v.message).join(" ")}</p>
            <p>
              Geometry is an estimate. Check the physical space before filming.
            </p>
          </div>
        </main>
        {tab !== "review" && (
          <Inspector
            plan={plan}
            progress={progress}
            selected={selected}
            onSelect={setSelected}
          />
        )}
      </div>
      {notice && (
        <div className="toast" role="status">
          <span>{notice}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {statusOpen && (
        <div className="modal-backdrop" onClick={() => setStatusOpen(false)}>
          <section
            className="modal status-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="status-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close status"
              onClick={() => setStatusOpen(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">WORKSPACE CONNECTIONS</span>
            <h2 id="status-title">Ready when you are.</h2>
            <p>
              Planning and rehearsal run on this device. Connected services add
              model assistance and video analysis.
            </p>
            <div className="status-list">
              {[
                ["Local planner", true],
                ["Forge inference", status?.inference],
                ["Private video storage", status?.storage],
                ["Project database", status?.database],
                ["Authentication", status?.auth],
                ["Video worker", status?.worker],
              ].map(([label, ready]) => (
                <div key={String(label)}>
                  <span>{String(label)}</span>
                  <span className={ready ? "ready" : "not-ready"}>
                    {ready ? <Check size={13} /> : <Square size={12} />}{" "}
                    {ready ? "Available" : "Not configured"}
                  </span>
                </div>
              ))}
            </div>
            {status?.limitations?.map((limitation, i) => (
              <p className="help-text" key={i}>
                {limitation}
              </p>
            ))}
            <details className="developer-details">
              <summary>Developer status</summary>
              <pre>
                {JSON.stringify(
                  status ?? { status: "API status unavailable" },
                  null,
                  2,
                )}
              </pre>
              <p>
                Training status: {status?.training?.status ?? "not_run"}. Local
                recipe selection does not run a trained model.
              </p>
              <Link href="/developer" className="text-button">
                Open traces & training lineage <ArrowUpRight size={12} />
              </Link>
            </details>
            <div className="modal-actions">
              <button className="button" onClick={loadStatus}>
                <RefreshCw size={14} /> Refresh status
              </button>
              <button
                className="button primary"
                disabled={!status?.auth}
                onClick={() =>
                  window.location.assign(
                    new URL("/api/auth/signin", window.location.origin).href,
                  )
                }
              >
                Account sign-in <ArrowUpRight size={14} />
              </button>
            </div>
          </section>
        </div>
      )}
      {historyOpen && (
        <VersionsDialog
          plan={plan}
          onClose={() => setHistoryOpen(false)}
          onOpen={(version) => {
            s.restore(version);
            if (selectedPlan(useWorkspace.getState()).id !== version.id)
              setNotice(
                "This shot was rechecked with the current planner. Its saved version is unchanged.",
              );
            setHistoryOpen(false);
            setTab("plan");
          }}
          onNotice={setNotice}
        />
      )}
      {helpOpen && (
        <div className="modal-backdrop" onClick={() => setHelpOpen(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              aria-label="Close field guide"
              onClick={() => setHelpOpen(false)}
            >
              <X size={18} />
            </button>
            <span className="eyebrow">THE FIELD GUIDE</span>
            <h2 id="help-title">Start with your space.</h2>
            <ol className="field-guide">
              <li>
                <strong>Measure what is there.</strong> Open Your space and
                enter the room, product, table, and obstacles in meters.
              </li>
              <li>
                <strong>Match your camera.</strong> Use 35 mm equivalent focal
                length or enter physical sensor dimensions. Set your frame and
                support.
              </li>
              <li>
                <strong>Choose your move.</strong> The library has twelve
                recipes across six movement families. Check the geometry notes
                after every edit.
              </li>
              <li>
                <strong>Rehearse, then record.</strong> Walk the path, inspect
                the actual frame, and record a 5–15 second take.
              </li>
              <li>
                <strong>Review the evidence.</strong> Load your take, mark the
                product on a clear frame, and use connected analysis when
                configured.
              </li>
            </ol>
            <p className="help-text">
              Your workspace is saved in this browser. Use Export plan to keep a
              copy. A geometry check cannot account for unmeasured objects or
              people.
            </p>
          </section>
        </div>
      )}
      {(statusOpen || helpOpen || historyOpen || exportsOpen) && (
        <DialogKeys
          close={() => {
            setStatusOpen(false);
            setHelpOpen(false);
            setHistoryOpen(false);
            setExportsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function DialogKeys({ close }: { close: () => void }) {
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Tab") {
        const dialog = document.querySelector('[role="dialog"]');
        if (!dialog) return;
        const targets = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button,a,input,select,textarea,summary,[tabindex="0"]',
          ),
        ).filter(
          (element) =>
            !element.matches(":disabled") &&
            element.getClientRects().length > 0,
        );
        const first = targets[0],
          last = targets[targets.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>("button")?.focus();
    }
    return () => window.removeEventListener("keydown", key);
  }, [close]);
  return null;
}
