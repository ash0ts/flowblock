"use client";
import { useState } from "react";
import {
  Box as BoxIcon,
  Camera,
  ChevronDown,
  Plus,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useWorkspace } from "@/client/store";
import type { Box, PlanVersion } from "@/domain/contracts";
import { FramingPreview } from "./SceneCanvas";

export function NumberField({
  label,
  value,
  onChange,
  unit = "m",
  min = 0.01,
  max = 100,
  step = 0.05,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const invalid =
    editing &&
    draft !== "" &&
    (!Number.isFinite(Number(draft)) ||
      Number(draft) < min ||
      Number(draft) > max);
  return (
    <label className="field">
      <span>{label}</span>
      <div className="number-input">
        <input
          aria-label={label}
          aria-invalid={invalid || undefined}
          type="number"
          min={min}
          max={max}
          step={step}
          value={editing ? draft : Number(value.toFixed(3))}
          onFocus={() => {
            setDraft(String(Number(value.toFixed(3))));
            setEditing(true);
          }}
          onBlur={() => setEditing(false)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            const v = Number(e.target.value);
            if (
              e.target.value !== "" &&
              Number.isFinite(v) &&
              v >= min &&
              v <= max
            )
              onChange(v);
          }}
        />
        <span>{unit}</span>
      </div>
    </label>
  );
}

export function Inspector({
  plan,
  progress,
  selected,
  onSelect,
}: {
  plan: PlanVersion;
  progress: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const s = useWorkspace();
  const [panel, setPanel] = useState<"shot" | "scene">("shot");
  const { scene, gear, intent } = s;
  const box =
    selected === scene.subject.id
      ? scene.subject
      : scene.obstacles.find((item) => item.id === selected);
  const updateBox = (updated: Box) =>
    s.updateScene({
      ...scene,
      subject: updated.id === scene.subject.id ? updated : scene.subject,
      obstacles: scene.obstacles.map((item) =>
        item.id === updated.id ? updated : item,
      ),
    });
  const minX = Math.min(...scene.boundary.map((p) => p.x)),
    maxX = Math.max(...scene.boundary.map((p) => p.x));
  const minZ = Math.min(...scene.boundary.map((p) => p.z)),
    maxZ = Math.max(...scene.boundary.map((p) => p.z));
  const resizeRoom = (width: number, depth: number) => {
    const cx = (minX + maxX) / 2,
      cz = (minZ + maxZ) / 2;
    s.updateScene({
      ...scene,
      boundary: [
        { x: cx - width / 2, z: cz - depth / 2 },
        { x: cx + width / 2, z: cz - depth / 2 },
        { x: cx + width / 2, z: cz + depth / 2 },
        { x: cx - width / 2, z: cz + depth / 2 },
      ],
    });
  };
  const addObstacle = () => {
    const id = `obstacle-${Date.now()}`;
    s.updateScene({
      ...scene,
      obstacles: [
        ...scene.obstacles,
        {
          id,
          name: `Obstacle ${scene.obstacles.length + 1}`,
          center: { x: minX + 0.8, z: minZ + 0.8 },
          width: 0.6,
          depth: 0.6,
          height: 1,
          baseHeight: 0,
          yawDeg: 0,
        },
      ],
    });
    onSelect(id);
    setPanel("scene");
  };
  return (
    <aside className="inspector">
      <div className="inspector-tabs">
        <button
          className={panel === "shot" ? "active" : ""}
          onClick={() => setPanel("shot")}
        >
          <SlidersHorizontal size={14} /> Shot settings
        </button>
        <button
          className={panel === "scene" ? "active" : ""}
          onClick={() => setPanel("scene")}
        >
          <BoxIcon size={14} /> Your space
        </button>
      </div>
      <div className="inspector-scroll">
        {panel === "shot" && (
          <>
            <section className="inspector-section">
              <div className="section-heading">
                <h3>Camera & lens</h3>
                <Camera size={14} />
              </div>
              <label className="field">
                <span>Lens model</span>
                <select
                  value={gear.lens.kind}
                  onChange={(e) =>
                    s.updateGear({
                      ...gear,
                      lens:
                        e.target.value === "equivalent"
                          ? {
                              kind: "equivalent",
                              focalLengthMm: gear.lens.focalLengthMm,
                            }
                          : {
                              kind: "physical",
                              focalLengthMm: gear.lens.focalLengthMm,
                              sensorWidthMm: 36,
                              sensorHeightMm: 24,
                            },
                    })
                  }
                >
                  <option value="equivalent">35 mm equivalent</option>
                  <option value="physical">Physical sensor</option>
                </select>
              </label>
              <div className="field-grid">
                <NumberField
                  label="Focal length"
                  unit="mm"
                  value={gear.lens.focalLengthMm}
                  min={4}
                  max={600}
                  step={1}
                  onChange={(v) =>
                    s.updateGear({
                      ...gear,
                      lens: { ...gear.lens, focalLengthMm: v },
                    })
                  }
                />
                <NumberField
                  label="Camera height"
                  value={intent.cameraHeight}
                  min={0.1}
                  max={5}
                  step={0.05}
                  onChange={(v) =>
                    s.updateIntent({ ...intent, cameraHeight: v })
                  }
                />
              </div>
              {gear.lens.kind === "physical" && (
                <div className="field-grid">
                  <NumberField
                    label="Sensor width"
                    value={gear.lens.sensorWidthMm}
                    unit="mm"
                    min={2}
                    max={100}
                    onChange={(v) => {
                      if (gear.lens.kind === "physical")
                        s.updateGear({
                          ...gear,
                          lens: { ...gear.lens, sensorWidthMm: v },
                        });
                    }}
                  />
                  <NumberField
                    label="Sensor height"
                    value={gear.lens.sensorHeightMm}
                    unit="mm"
                    min={2}
                    max={100}
                    onChange={(v) => {
                      if (gear.lens.kind === "physical")
                        s.updateGear({
                          ...gear,
                          lens: { ...gear.lens, sensorHeightMm: v },
                        });
                    }}
                  />
                </div>
              )}
              <label className="field">
                <span>Frame</span>
                <div className="segmented">
                  {(["landscape", "portrait", "square"] as const).map((r) => (
                    <button
                      key={r}
                      className={gear.aspectRatio === r ? "selected" : ""}
                      onClick={() => s.updateGear({ ...gear, aspectRatio: r })}
                    >
                      {r === "landscape"
                        ? "16:9"
                        : r === "portrait"
                          ? "9:16"
                          : "1:1"}
                    </button>
                  ))}
                </div>
              </label>
              <label className="field">
                <span>Support</span>
                <select
                  value={gear.stabilizer}
                  onChange={(e) =>
                    s.updateGear({
                      ...gear,
                      stabilizer: e.target.value as typeof gear.stabilizer,
                    })
                  }
                >
                  {["gimbal", "handheld", "tripod", "slider"].map((v) => (
                    <option key={v} value={v}>
                      {v[0].toUpperCase() + v.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
              {gear.stabilizer === "gimbal" && (
                <label className="field">
                  <span>Gimbal mode</span>
                  <select
                    value={gear.gimbalMode}
                    onChange={(e) =>
                      s.updateGear({
                        ...gear,
                        gimbalMode: e.target.value as typeof gear.gimbalMode,
                      })
                    }
                  >
                    <option value="follow">Pan follow</option>
                    <option value="lock">Lock</option>
                    <option value="pov">POV</option>
                  </select>
                </label>
              )}
            </section>
            <section className="inspector-section">
              <div className="section-heading">
                <h3>The movement</h3>
                <span className="tiny-label">{plan.family}</span>
              </div>
              <div className="field-grid">
                <NumberField
                  label="Duration"
                  unit="sec"
                  value={intent.durationSeconds}
                  min={2}
                  max={60}
                  step={1}
                  onChange={(v) =>
                    s.updateIntent({ ...intent, durationSeconds: v })
                  }
                />
                <label className="field">
                  <span>Framing</span>
                  <select
                    value={intent.framing}
                    onChange={(e) =>
                      s.updateIntent({
                        ...intent,
                        framing: e.target.value as typeof intent.framing,
                      })
                    }
                  >
                    <option value="wide">Wide</option>
                    <option value="medium">Medium</option>
                    <option value="close">Close</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span>Energy</span>
                <div className="segmented">
                  {(["subtle", "balanced", "dynamic"] as const).map((m) => (
                    <button
                      key={m}
                      className={intent.motion === m ? "selected" : ""}
                      onClick={() => s.updateIntent({ ...intent, motion: m })}
                    >
                      {m[0].toUpperCase() + m.slice(1)}
                    </button>
                  ))}
                </div>
              </label>
            </section>
          </>
        )}
        {panel === "scene" && (
          <>
            <section className="inspector-section">
              <div className="section-heading">
                <h3>Room dimensions</h3>
                <span className="tiny-label">METERS</span>
              </div>
              <div className="field-grid">
                <NumberField
                  label="Room width"
                  value={maxX - minX}
                  min={1}
                  max={30}
                  onChange={(v) => resizeRoom(v, maxZ - minZ)}
                />
                <NumberField
                  label="Room depth"
                  value={maxZ - minZ}
                  min={1}
                  max={30}
                  onChange={(v) => resizeRoom(maxX - minX, v)}
                />
              </div>
              <p className="help-text">
                Measure the usable floor area. Include furniture and stands
                below.
              </p>
            </section>
            <section className="inspector-section">
              <div className="section-heading">
                <h3>Objects in your space</h3>
                <button
                  className="icon-button"
                  title="Add obstacle"
                  aria-label="Add obstacle"
                  onClick={addObstacle}
                >
                  <Plus size={16} />
                </button>
              </div>
              {[scene.subject, ...scene.obstacles].map((item) => (
                <button
                  key={item.id}
                  className={`object-row ${selected === item.id ? "selected" : ""}`}
                  onClick={() => onSelect(item.id)}
                >
                  <span
                    className={
                      item.id === scene.subject.id
                        ? "object-swatch product"
                        : "object-swatch"
                    }
                  />
                  <span>{item.name}</span>
                  <ChevronDown size={12} />
                </button>
              ))}
              <button className="text-button add-object" onClick={addObstacle}>
                <Plus size={13} /> Add obstacle
              </button>
            </section>
            {box && (
              <section className="inspector-section">
                <div className="section-heading">
                  <h3>
                    {box.id === scene.subject.id ? "Product" : "Obstacle"}{" "}
                    dimensions
                  </h3>
                  {box.id !== scene.subject.id && (
                    <button
                      className="icon-button danger"
                      aria-label={`Remove ${box.name}`}
                      onClick={() => {
                        s.updateScene({
                          ...scene,
                          obstacles: scene.obstacles.filter(
                            (b) => b.id !== box.id,
                          ),
                        });
                        onSelect(null);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                <label className="field">
                  <span>Name</span>
                  <input
                    value={box.name}
                    onChange={(e) =>
                      updateBox({
                        ...box,
                        name: e.target.value.slice(0, 100) || "Object",
                      })
                    }
                  />
                </label>
                <div className="field-grid">
                  <NumberField
                    label="Width"
                    value={box.width}
                    onChange={(v) => updateBox({ ...box, width: v })}
                  />
                  <NumberField
                    label="Depth"
                    value={box.depth}
                    onChange={(v) => updateBox({ ...box, depth: v })}
                  />
                  <NumberField
                    label="Height"
                    value={box.height}
                    max={20}
                    onChange={(v) => updateBox({ ...box, height: v })}
                  />
                  <NumberField
                    label="Base height"
                    value={box.baseHeight}
                    min={0}
                    max={20}
                    onChange={(v) => updateBox({ ...box, baseHeight: v })}
                  />
                  <NumberField
                    label="Position X"
                    value={box.center.x}
                    min={-100}
                    onChange={(v) =>
                      updateBox({ ...box, center: { ...box.center, x: v } })
                    }
                  />
                  <NumberField
                    label="Position Z"
                    value={box.center.z}
                    min={-100}
                    onChange={(v) =>
                      updateBox({ ...box, center: { ...box.center, z: v } })
                    }
                  />
                  <NumberField
                    label="Rotation"
                    value={box.yawDeg}
                    unit="deg"
                    min={-360}
                    max={360}
                    step={5}
                    onChange={(v) => updateBox({ ...box, yawDeg: v })}
                  />
                </div>
                <p className="help-text">
                  Select an object on the canvas. Arrow keys move it 5 cm; Shift
                  moves it 25 cm.
                </p>
              </section>
            )}
            <details className="inspector-section">
              <summary>Clearance assumptions</summary>
              <div className="field-grid">
                <NumberField
                  label="Operator radius"
                  value={gear.operatorRadius}
                  min={0}
                  max={1}
                  onChange={(v) => s.updateGear({ ...gear, operatorRadius: v })}
                />
                <NumberField
                  label="Camera radius"
                  value={gear.cameraRadius}
                  min={0}
                  max={1}
                  onChange={(v) => s.updateGear({ ...gear, cameraRadius: v })}
                />
                <NumberField
                  label="Operator offset"
                  value={gear.operatorOffset}
                  min={0}
                  max={2}
                  onChange={(v) => s.updateGear({ ...gear, operatorOffset: v })}
                />
                <NumberField
                  label="Margin"
                  value={gear.uncertaintyMargin}
                  min={0}
                  max={1}
                  onChange={(v) =>
                    s.updateGear({ ...gear, uncertaintyMargin: v })
                  }
                />
              </div>
            </details>
          </>
        )}
        <section className="inspector-section framing-section">
          <div className="section-heading">
            <h3>Through the lens</h3>
            <span className="tiny-label">ESTIMATE</span>
          </div>
          <FramingPreview plan={plan} progress={progress} />
          <p className="help-text">
            Geometric framing preview. Focus, lighting, crop, and lens
            distortion need a real rehearsal.
          </p>
        </section>
      </div>
    </aside>
  );
}
