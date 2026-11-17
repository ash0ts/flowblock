import { createHash } from "node:crypto";
import {
  defaultGear,
  defaultIntent,
  defaultScene,
  type Family,
} from "../../../src/domain";
import { PlanningInputSchema } from "../../../src/server/planner";
import type { Task } from "./grade";

export const datasetVersion = "flowblock-scenes-v2";
export const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const families: Family[] = [
  "hold",
  "push-in",
  "pull-out",
  "lateral",
  "orbit",
  "reveal",
];
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function createTasks(
  split: Task["split"],
  groups: number,
  seed: number,
): Task[] {
  const r = random(seed),
    tasks: Task[] = [];
  const uniform = (a: number, b: number) =>
    Math.round((a + (b - a) * r()) * 1000) / 1000;
  for (let group = 0; group < groups; group++) {
    const id = `${split}-${String(group).padStart(3, "0")}`;
    const scene = structuredClone(defaultScene),
      gear = structuredClone(defaultGear);
    scene.id = id;
    scene.name = `Authored ${split} room ${group}`;
    const topology = ["rectangle", "concave", "narrow"][group % 3];
    const halfWidth =
        topology === "narrow" ? uniform(1.2, 2) : uniform(2.2, 4.6),
      back = uniform(1.6, 3.4),
      front = uniform(2.2, 4.8);
    scene.boundary =
      topology === "concave"
        ? [
            { x: -halfWidth, z: -back },
            { x: halfWidth, z: -back },
            { x: halfWidth, z: front * 0.35 },
            { x: halfWidth * 0.5, z: front * 0.35 },
            { x: halfWidth * 0.5, z: front },
            { x: -halfWidth, z: front },
          ]
        : [
            { x: -halfWidth, z: -back },
            { x: halfWidth, z: -back },
            { x: halfWidth, z: front },
            { x: -halfWidth, z: front },
          ];
    scene.subject.width = uniform(0.12, 0.45);
    scene.subject.depth = uniform(0.1, 0.35);
    scene.subject.height = uniform(0.2, 0.55);
    scene.subject.baseHeight = uniform(0.65, 1);
    scene.subject.yawDeg = uniform(-60, 60);
    scene.subject.name = "Synthetic dimensioned product";
    scene.measurementUncertainty = uniform(0.01, 0.055);
    scene.obstacles = [
      {
        ...scene.obstacles[0],
        width: Math.max(scene.subject.width + 0.15, uniform(0.5, 0.9)),
        depth: Math.max(scene.subject.depth + 0.12, uniform(0.4, 0.65)),
        height: scene.subject.baseHeight,
        yawDeg: uniform(-20, 20),
      },
    ];
    for (let obstacle = 0; obstacle < group % 4; obstacle++)
      scene.obstacles.push({
        id: `stand-${obstacle}`,
        name: `Fixed stand ${obstacle}`,
        center: {
          x: uniform(-halfWidth + 0.4, halfWidth - 0.4),
          z: uniform(0.75, front - 0.3),
        },
        width: uniform(0.15, 0.45),
        depth: uniform(0.15, 0.45),
        height: 2,
        baseHeight: 0,
        yawDeg: uniform(-90, 90),
      });
    scene.lights = [];
    gear.lens = {
      kind: "equivalent",
      focalLengthMm: [28, 35, 50, 65, 85][Math.floor(r() * 5)],
    };
    gear.aspectRatio = (["landscape", "portrait", "square"] as const)[
      Math.floor(r() * 3)
    ];
    gear.stabilizer = group % 8 === 7 ? "tripod" : "gimbal";
    gear.operatorRadius = uniform(0.22, 0.34);
    gear.operatorOffset = uniform(0.25, 0.55);
    gear.uncertaintyMargin = uniform(0.015, 0.05);
    const geometryHash = sha256(JSON.stringify({ ...scene, id: "", name: "" }));
    for (const family of families) {
      const direction = (
        ["lateral", "orbit", "reveal"].includes(family)
          ? group % 2 === 0
            ? "left"
            : "right"
          : "either"
      ) as Task["briefSpec"]["direction"];
      const minTravel = family === "hold" ? 0 : 0.1;
      const requiresForegroundOcclusion =
        family === "reveal" && group % 6 === 5;
      const desc =
        family === "hold"
          ? "Keep the camera stationary for a product hero shot."
          : family === "push-in"
            ? "Push toward the product, increasing its apparent size."
            : family === "pull-out"
              ? "Pull away from the product, decreasing its apparent size."
              : family === "orbit"
                ? `Orbit ${direction} around the product by at least 20 degrees.`
                : family === "lateral"
                  ? `Move ${direction} as you face the product in a straight lateral slide.`
                  : requiresForegroundOcclusion
                    ? `Reveal the product from behind an actual foreground occluder, moving ${direction}; a plain visible slide does not satisfy this brief.`
                    : `Make an angled ${direction} slide into the hero view. No foreground hiding is requested.`;
      const intent = {
        ...defaultIntent,
        durationSeconds: [6, 8, 10][Math.floor(r() * 3)],
        cameraHeight:
          Math.round(
            (scene.subject.baseHeight +
              scene.subject.height / 2 +
              uniform(0.08, 0.35)) *
              1000,
          ) / 1000,
        motion: (["subtle", "balanced", "dynamic"] as const)[
          Math.floor(r() * 3)
        ],
        framingTargets: {
          start: [0.2, 0.6] as [number, number],
          end: [0.2, 0.6] as [number, number],
        },
        brief: `${desc} ${family !== "hold" ? "Travel at least 0.10 m. " : ""}Preserve the declared camera height, duration, gear, room and framing bands. Keep the full product in frame. If the setup cannot perform the move, explain the constraint without substituting another move.`,
      };
      const input = PlanningInputSchema.parse({
        scene,
        gear,
        intent,
        prompt: intent.brief,
      });
      tasks.push({
        id: `${id}-${family}`,
        sceneGroup: id,
        split,
        topology,
        geometryHash,
        input,
        briefSpec: {
          family,
          direction,
          minimumTravel: minTravel,
          minimumOrbitDegrees: family === "orbit" ? 20 : 0,
          requiresForegroundOcclusion,
        },
        provenance: { kind: "authored-synthetic", seed },
      });
    }
  }
  return tasks;
}
