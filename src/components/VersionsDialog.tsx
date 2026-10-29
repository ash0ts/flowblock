"use client";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CloudUpload,
  Copy,
  History,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { PlanVersionSchema, type PlanVersion } from "@/domain/contracts";
import { useWorkspace } from "@/client/store";
import { useConnections, type ProjectBinding } from "@/client/connections";

type RemoteProject = {
  id: string;
  name: string;
  current_version_id: string;
  updated_at: string;
  plan: PlanVersion;
};

export function VersionsDialog({
  plan,
  onClose,
  onOpen,
  onNotice,
}: {
  plan: PlanVersion;
  onClose: () => void;
  onOpen: (plan: PlanVersion) => void;
  onNotice: (message: string) => void;
}) {
  const workspace = useWorkspace();
  const connections = useConnections();
  const [remote, setRemote] = useState<RemoteProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<{
    local: PlanVersion;
    remote: RemoteProject;
  } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const fetchProjects = async () => {
    const response = await fetch("/api/projects");
    const result = await response.json();
    if (!response.ok)
      throw new Error(
        result.error ||
          "Server projects are unavailable. Your local versions are still here.",
      );
    return (Array.isArray(result.projects) ? result.projects : []).filter(
      (item: RemoteProject) => PlanVersionSchema.safeParse(item.plan).success,
    ) as RemoteProject[];
  };
  useEffect(() => {
    let active = true;
    void useConnections.persist.rehydrate();
    fetchProjects()
      .then((projects) => {
        if (active) setRemote(projects);
      })
      .catch((err) => {
        if (active)
          setError(
            err instanceof Error ? err.message : "Server projects unavailable.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const refresh = async () => {
    setLoading(true);
    setError("");
    try {
      setRemote(await fetchProjects());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Server projects unavailable.",
      );
    } finally {
      setLoading(false);
    }
  };
  const sync = async (draft: PlanVersion, binding?: ProjectBinding) => {
    workspace.saveVersion(draft);
    setSyncing(true);
    setError("");
    try {
      const current = binding ?? connections.bindings[draft.recipeId];
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${draft.scene.name} / ${draft.name}`,
          plan: draft,
          ...(current
            ? {
                projectId: current.projectId,
                expectedVersionId: current.versionId,
              }
            : {}),
        }),
      });
      const result = await response.json();
      if (response.status === 409) {
        const projects = await fetchProjects();
        setRemote(projects);
        const newest = projects.find((item) => item.id === current?.projectId);
        if (newest) setConflict({ local: draft, remote: newest });
        throw new Error(
          "The server has another version. Your local draft has been kept in Saved versions. Choose which version to use.",
        );
      }
      if (!response.ok)
        throw new Error(
          result.error || "Sync did not complete. Your local version is saved.",
        );
      connections.bind(draft.recipeId, {
        projectId: result.projectId,
        versionId: result.versionId,
      });
      setConflict(null);
      setRemote(await fetchProjects());
      onNotice(
        "Plan synced. Future updates will check for a newer server version.",
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Sync failed. Your local version is saved.",
      );
    } finally {
      setSyncing(false);
    }
  };
  const openRemote = (project: RemoteProject) => {
    workspace.saveVersion(plan);
    connections.bind(project.plan.recipeId, {
      projectId: project.id,
      versionId: project.current_version_id,
    });
    onOpen(project.plan);
    onNotice("Server copy opened. Your previous draft is in Saved versions.");
  };
  const revoke = async (token: string) => {
    setRevoking(token);
    setError("");
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(token)}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(body.error || "Could not revoke this link.");
      }
      connections.removeShare(token);
      onNotice("Read-only link revoked.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not revoke this link.",
      );
    } finally {
      setRevoking(null);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <section
        className="modal versions-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          className="modal-close icon-button"
          aria-label="Close saved versions"
          onClick={onClose}
        >
          <X size={18} />
        </button>
        <span className="eyebrow">KEEP YOUR NEXT TAKE IN REACH</span>
        <h2 id="history-title">Saved versions</h2>
        <p>
          Local drafts sync only when you choose. A server update never merges
          into your shot automatically.
        </p>
        <div className="version-actions">
          <button
            className="button"
            onClick={() => {
              workspace.saveVersion(plan);
              onNotice("Current plan saved on this device.");
            }}
          >
            <Plus size={14} /> Save on this device
          </button>
          <button
            className="button primary"
            disabled={syncing}
            onClick={() => sync(plan)}
          >
            {syncing ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <CloudUpload size={14} />
            )}{" "}
            Sync current plan
          </button>
        </div>
        {error && (
          <p className="sync-error" role="alert">
            {error}
          </p>
        )}
        {conflict && (
          <section className="sync-conflict">
            <h3>Two versions, both kept.</h3>
            <p>
              <strong>Your draft:</strong> {conflict.local.name},{" "}
              {conflict.local.durationSeconds} s,{" "}
              {conflict.local.gear.lens.focalLengthMm} mm.
            </p>
            <p>
              <strong>Server copy:</strong> {conflict.remote.plan.name},{" "}
              {conflict.remote.plan.durationSeconds} s,{" "}
              {conflict.remote.plan.gear.lens.focalLengthMm} mm.
            </p>
            <div>
              <button
                className="button"
                onClick={() => openRemote(conflict.remote)}
              >
                Open server copy
              </button>
              <button
                className="button primary"
                disabled={syncing}
                onClick={() =>
                  sync(conflict.local, {
                    projectId: conflict.remote.id,
                    versionId: conflict.remote.current_version_id,
                  })
                }
              >
                Sync this local draft instead
              </button>
            </div>
          </section>
        )}
        <section className="versions-section">
          <div className="section-heading">
            <h3>On this device</h3>
            <History size={14} />
          </div>
          <div className="version-list">
            {workspace.history.length ? (
              workspace.history.map((version, i) => (
                <div className="local-version-row" key={`${version.id}-${i}`}>
                  <button onClick={() => onOpen(version)}>
                    <span>
                      <strong>{version.name}</strong>
                      <small>
                        {version.durationSeconds} s ·{" "}
                        {version.gear.lens.focalLengthMm} mm ·{" "}
                        {version.validation.valid
                          ? "Geometry checked"
                          : "Needs adjustment"}
                      </small>
                    </span>
                    <ArrowRight size={15} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Sync ${version.name}`}
                    disabled={syncing}
                    onClick={() => sync(version)}
                  >
                    <CloudUpload size={15} />
                  </button>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <History size={25} />
                <h3>No versions saved yet</h3>
                <p>Save your current plan before trying a new direction.</p>
              </div>
            )}
          </div>
        </section>
        <section className="versions-section">
          <div className="section-heading">
            <h3>Server projects</h3>
            <button
              className="text-button"
              onClick={refresh}
              disabled={loading}
            >
              <RefreshCw size={12} className={loading ? "spin" : ""} /> Refresh
            </button>
          </div>
          {loading ? (
            <p className="help-text">Loading your projects…</p>
          ) : remote.length ? (
            <div className="remote-project-list">
              {remote.map((project) => (
                <button key={project.id} onClick={() => openRemote(project)}>
                  <span>
                    <strong>{project.name}</strong>
                    <small>
                      {project.plan.durationSeconds} s ·{" "}
                      {project.plan.gear.lens.focalLengthMm} mm · server version{" "}
                      {project.current_version_id.slice(0, 8)}
                    </small>
                  </span>
                  <ArrowRight size={15} />
                </button>
              ))}
            </div>
          ) : (
            <p className="help-text">
              No server projects loaded. Sync a local plan when the project
              service is connected.
            </p>
          )}
        </section>
        <section className="versions-section">
          <div className="section-heading">
            <h3>Shared plan links</h3>
            <Link2 size={14} />
          </div>
          {connections.shares.length ? (
            <div className="shared-links">
              {connections.shares.map((link) => (
                <div key={link.token}>
                  <span>
                    <strong>{link.name}</strong>
                    <small>{link.url}</small>
                  </span>
                  <button
                    className="icon-button"
                    aria-label={`Copy link for ${link.name}`}
                    onClick={() => {
                      navigator.clipboard
                        .writeText(link.url)
                        .then(() => onNotice("Plan link copied."))
                        .catch(() =>
                          setError(
                            "Clipboard access is unavailable. Select and copy the visible link.",
                          ),
                        );
                    }}
                  >
                    <Copy size={13} />
                  </button>
                  <button
                    className="icon-button danger"
                    disabled={revoking === link.token}
                    aria-label={`Revoke link for ${link.name}`}
                    onClick={() => revoke(link.token)}
                  >
                    {revoking === link.token ? (
                      <Loader2 size={13} className="spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="help-text">
              Created links appear here so you can copy or revoke them. Video is
              never included.
            </p>
          )}
        </section>
        <div className="sync-footer">
          <Check size={12} /> A sync conflict always keeps your local version.
        </div>
      </section>
    </div>
  );
}
