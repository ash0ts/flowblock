"use client";
import { useMemo, useRef, type KeyboardEvent } from "react";
import { samplePlan, deriveFov } from "@/domain";
import type { PlanVersion, Box } from "@/domain/contracts";
import { useWorkspace } from "@/client/store";

export function SceneCanvas({
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
  const ref = useRef<SVGSVGElement>(null);
  const { scene, updateScene } = useWorkspace();
  const xs = scene.boundary.map((p) => p.x),
    zs = scene.boundary.map((p) => p.z);
  const minX = Math.min(...xs),
    minZ = Math.min(...zs),
    width = Math.max(...xs) - minX,
    depth = Math.max(...zs) - minZ;
  const padding = Math.max(width, depth) * 0.11,
    u = Math.max(width, depth) / 390;
  const sample = samplePlan(plan, progress);
  const points = useMemo(
    () => Array.from({ length: 80 }, (_, i) => samplePlan(plan, i / 79)),
    [plan],
  );
  const path = points
    .map(
      (p, i) =>
        `${i ? "L" : "M"} ${p.position.x.toFixed(4)} ${p.position.z.toFixed(4)}`,
    )
    .join(" ");
  const fov = deriveFov(plan.gear).horizontalRad;
  const angle = Math.atan2(
    scene.subject.center.z - sample.position.z,
    scene.subject.center.x - sample.position.x,
  );
  const reach = Math.min(sample.distance * 1.18, 4);
  const end1 = {
    x: sample.position.x + Math.cos(angle - fov / 2) * reach,
    z: sample.position.z + Math.sin(angle - fov / 2) * reach,
  };
  const end2 = {
    x: sample.position.x + Math.cos(angle + fov / 2) * reach,
    z: sample.position.z + Math.sin(angle + fov / 2) * reach,
  };
  const move = (id: string, dx: number, dz: number) => {
    const edit = (box: Box): Box => ({
      ...box,
      center: {
        x: Math.max(
          minX + box.width / 2,
          Math.min(minX + width - box.width / 2, box.center.x + dx),
        ),
        z: Math.max(
          minZ + box.depth / 2,
          Math.min(minZ + depth - box.depth / 2, box.center.z + dz),
        ),
      },
    });
    updateScene({
      ...scene,
      subject: id === scene.subject.id ? edit(scene.subject) : scene.subject,
      obstacles: scene.obstacles.map((box) =>
        box.id === id ? edit(box) : box,
      ),
    });
  };
  const onKey = (e: KeyboardEvent<SVGGElement>, id: string) => {
    const amount = e.shiftKey ? 0.25 : 0.05;
    const direction: Record<string, [number, number]> = {
      ArrowLeft: [-amount, 0],
      ArrowRight: [amount, 0],
      ArrowUp: [0, -amount],
      ArrowDown: [0, amount],
    };
    if (direction[e.key]) {
      e.preventDefault();
      move(id, ...direction[e.key]);
    }
  };
  function renderBox(box: Box, subject = false) {
    return (
      <g
        key={box.id}
        role="button"
        tabIndex={0}
        aria-label={`${box.name}. Use arrow keys to move, shift for larger steps.`}
        onKeyDown={(e) => onKey(e, box.id)}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(box.id);
        }}
        className="scene-object"
        transform={`translate(${box.center.x} ${box.center.z}) rotate(${box.yawDeg})`}
      >
        <rect
          x={-box.width / 2}
          y={-box.depth / 2}
          width={box.width}
          height={box.depth}
          rx={subject ? 0.035 : 0.06}
          fill={subject ? "#c88760" : "#e6e2d8"}
          stroke={
            selected === box.id ? "#2c7160" : subject ? "#9e603f" : "#bbb9ad"
          }
          strokeWidth={selected === box.id ? 3 * u : 1.2 * u}
        />
        {!subject && (
          <rect
            x={-box.width / 2 + 0.045}
            y={-box.depth / 2 + 0.045}
            width={Math.max(0.01, box.width - 0.09)}
            height={Math.max(0.01, box.depth - 0.09)}
            rx={0.03}
            fill="none"
            stroke="#d3cfc3"
            strokeWidth={u}
          />
        )}
        {subject && (
          <>
            <line
              x1={-box.width * 0.3}
              y1={-box.depth * 0.28}
              x2={box.width * 0.3}
              y2={-box.depth * 0.28}
              stroke="#edc8a8"
              strokeWidth={2 * u}
            />
            <circle r={Math.min(box.width, box.depth) * 0.21} fill="#e8b993" />
          </>
        )}
        <text
          y={box.depth / 2 + 18 * u}
          textAnchor="middle"
          fill="#6b7169"
          fontSize={10 * u}
          fontFamily="Arial, sans-serif"
        >
          {box.name}
        </text>
      </g>
    );
  }
  return (
    <svg
      ref={ref}
      id="shot-canvas"
      className="room-svg"
      viewBox={`${minX - padding} ${minZ - padding} ${width + padding * 2} ${depth + padding * 2}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Top-down camera path and measured room"
      onClick={() => onSelect(null)}
    >
      <defs>
        <pattern
          id="room-grid"
          width="0.25"
          height="0.25"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="0.008" cy="0.008" r={u * 0.8} fill="#c5cec2" />
        </pattern>
        <marker
          id="path-arrow"
          markerWidth="7"
          markerHeight="7"
          refX="4"
          refY="3.5"
          orient="auto"
        >
          <path
            d="M1 1 L5 3.5 L1 6"
            fill="none"
            stroke="#276852"
            strokeWidth="1.3"
          />
        </marker>
        <linearGradient id="frustum-fill">
          <stop stopColor="#6da081" stopOpacity=".21" />
          <stop offset="1" stopColor="#6da081" stopOpacity=".025" />
        </linearGradient>
      </defs>
      <polygon
        points={scene.boundary.map((p) => `${p.x},${p.z}`).join(" ")}
        fill="#f5f5ef"
        stroke="#a7b0a3"
        strokeWidth={2 * u}
      />
      <polygon
        points={scene.boundary.map((p) => `${p.x},${p.z}`).join(" ")}
        fill="url(#room-grid)"
      />
      <line
        x1={minX}
        y1={minZ - padding * 0.45}
        x2={minX + width}
        y2={minZ - padding * 0.45}
        stroke="#c0c4ba"
        strokeWidth={u}
      />
      {[minX, minX + width].map((x) => (
        <line
          key={x}
          x1={x}
          y1={minZ - padding * 0.35}
          x2={x}
          y2={minZ - padding * 0.55}
          stroke="#adb3a7"
          strokeWidth={u}
        />
      ))}
      <rect
        x={minX + width / 2 - 0.32}
        y={minZ - padding * 0.45 - 9 * u}
        width=".64"
        height={18 * u}
        fill="#eeefe7"
      />
      <text
        x={minX + width / 2}
        y={minZ - padding * 0.45 + 4 * u}
        textAnchor="middle"
        fontSize={11 * u}
        fontFamily="Arial, sans-serif"
        fill="#7b8275"
      >
        {width.toFixed(1)} m
      </text>
      <text
        x={minX - padding * 0.48}
        y={minZ + depth / 2}
        transform={`rotate(-90 ${minX - padding * 0.48} ${minZ + depth / 2})`}
        textAnchor="middle"
        fontSize={11 * u}
        fontFamily="Arial, sans-serif"
        fill="#7b8275"
      >
        {depth.toFixed(1)} m
      </text>
      <path
        d={`M ${sample.position.x} ${sample.position.z} L ${end1.x} ${end1.z} L ${end2.x} ${end2.z} Z`}
        fill="url(#frustum-fill)"
        stroke="#87a793"
        strokeWidth={u}
        strokeDasharray={`${4 * u} ${5 * u}`}
      />
      {scene.obstacles.map((box) => renderBox(box))}
      {renderBox(scene.subject, true)}
      <path
        d={path}
        fill="none"
        stroke={plan.validation.valid ? "#2d7158" : "#b67a3b"}
        strokeWidth={3 * u}
        strokeDasharray={`${7 * u} ${5 * u}`}
      />
      <circle
        cx={points[0].position.x}
        cy={points[0].position.z}
        r={7 * u}
        fill="#f7f8f0"
        stroke="#2d7158"
        strokeWidth={2.5 * u}
      />
      <rect
        x={points[79].position.x - 6 * u}
        y={points[79].position.z - 6 * u}
        width={12 * u}
        height={12 * u}
        rx={1.5 * u}
        fill="#e9edcf"
        stroke="#2d7158"
        strokeWidth={2 * u}
      />
      <text
        x={points[0].position.x}
        y={points[0].position.z + 24 * u}
        textAnchor="middle"
        fontSize={10 * u}
        fontFamily="Arial, sans-serif"
        fill="#536a58"
      >
        START
      </text>
      <text
        x={points[79].position.x}
        y={points[79].position.z - 17 * u}
        textAnchor="middle"
        fontSize={10 * u}
        fontFamily="Arial, sans-serif"
        fill="#536a58"
      >
        END
      </text>
      <circle
        cx={sample.operator.x}
        cy={sample.operator.z}
        r={plan.gear.operatorRadius}
        fill="#839785"
        fillOpacity=".08"
        stroke="#829781"
        strokeWidth={u}
        strokeDasharray={`${3 * u} ${4 * u}`}
      />
      <g
        transform={`translate(${sample.position.x} ${sample.position.z}) rotate(${(angle * 180) / Math.PI})`}
      >
        <circle r={15 * u} fill="#164d3e" />
        <path
          d={`M ${-6 * u} ${-6 * u} h ${9 * u} v ${12 * u} h ${-9 * u} Z M ${3 * u} ${-3 * u} l ${5 * u} ${-3 * u} v ${12 * u} l ${-5 * u} ${-3 * u} Z`}
          fill="#f4f7e5"
        />
      </g>
    </svg>
  );
}

export function FramingPreview({
  plan,
  progress,
}: {
  plan: PlanVersion;
  progress: number;
}) {
  const sample = samplePlan(plan, progress);
  const subject = plan.scene.subject;
  const height = Math.max(8, Math.min(125, sample.coverage * 100));
  const width = Math.max(
    12,
    Math.min(
      75,
      ((height * subject.width) / subject.height) *
        (plan.gear.aspectRatio === "portrait" ? 1.77 : 0.56),
    ),
  );
  return (
    <div
      className={`framing-preview ${plan.gear.aspectRatio}`}
      aria-label={`Approximate framing at ${(progress * plan.durationSeconds).toFixed(1)} seconds`}
    >
      <div className="preview-horizon" />
      <div className="preview-platform" />
      <div
        className="preview-subject"
        style={{
          height: `${height.toFixed(3)}%`,
          width: `${width.toFixed(3)}%`,
        }}
      >
        <div className="preview-cap" />
        <span>{subject.name}</span>
        <i />
      </div>
      <div className="thirds thirds-x" />
      <div className="thirds thirds-y" />
      <span className="viewfinder-corner tl" />
      <span className="viewfinder-corner tr" />
      <span className="viewfinder-corner bl" />
      <span className="viewfinder-corner br" />
      <span className="frame-tag">
        {plan.gear.lens.focalLengthMm} MM
        {plan.gear.lens.kind === "equivalent" ? " EQ" : ""}
      </span>
      <span className="frame-time">{sample.timeSeconds.toFixed(1)}s</span>
    </div>
  );
}
