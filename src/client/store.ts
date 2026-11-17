import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { z } from "zod";
import { validatedStorage } from "./storage";
import {
  SceneSchema,
  GearSchema,
  IntentSchema,
  RecipeIdSchema,
  PlanVersionSchema,
} from "@/domain/contracts";
import {
  defaultScene,
  defaultGear,
  defaultIntent,
  compilePlan,
} from "@/domain";
import type {
  Scene,
  Gear,
  Intent,
  PlanVersion,
  RecipeId,
} from "@/domain/contracts";

const restoredPlan = PlanVersionSchema.transform((plan, ctx) => {
  try {
    return compilePlan(
      plan.scene,
      plan.gear,
      plan.intent,
      plan.recipeId,
      plan.overrides,
    );
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "The saved plan could not be rebuilt.",
    });
    return z.NEVER;
  }
});
const persistedWorkspace = z
  .object({
    scene: SceneSchema,
    gear: GearSchema,
    intent: IntentSchema,
    prompt: z.string().max(4000),
    plans: z.array(restoredPlan).max(12),
    recipeId: RecipeIdSchema,
    history: z.array(PlanVersionSchema).max(20),
    source: z.string(),
    workflowId: z.uuid().nullable(),
    planningResult: z
      .object({ source: z.string(), message: z.string() })
      .nullable(),
    drafts: z.partialRecord(RecipeIdSchema, restoredPlan),
    draftSources: z.partialRecord(RecipeIdSchema, z.string()),
  })
  .partial();
const storage = validatedStorage(persistedWorkspace);

type Workspace = {
  scene: Scene;
  gear: Gear;
  intent: Intent;
  prompt: string;
  plans: PlanVersion[];
  recipeId: RecipeId;
  history: PlanVersion[];
  source: string;
  workflowId: string | null;
  hydrated: boolean;
  planningResult: { source: string; message: string } | null;
  drafts: Partial<Record<RecipeId, PlanVersion>>;
  draftSources: Partial<Record<RecipeId, string>>;
  updateScene: (scene: Scene) => void;
  updateGear: (gear: Gear) => void;
  updateIntent: (intent: Intent) => void;
  updateShot: (patch: { durationSeconds?: number; height?: number }) => void;
  setPrompt: (prompt: string) => void;
  selectRecipe: (recipeId: RecipeId) => void;
  setPlans: (
    plans: PlanVersion[],
    source: string,
    message?: string,
    workflowId?: string | null,
  ) => void;
  saveVersion: (plan: PlanVersion) => void;
  restore: (plan: PlanVersion, workflowId?: string | null) => void;
  reset: () => void;
  markHydrated: () => void;
};

function updatedDraft(s: Workspace, scene: Scene, gear: Gear, intent: Intent) {
  const nextIntent = { ...intent };
  const overrides = { ...s.drafts[s.recipeId]?.overrides };
  if (intent.framing !== s.intent.framing) {
    delete overrides.distance;
    delete nextIntent.framingTargets;
  }
  if (intent.motion !== s.intent.motion) {
    delete overrides.travel;
    delete overrides.orbitDegrees;
  }
  const plan = compilePlan(scene, gear, nextIntent, s.recipeId, overrides);
  return {
    scene,
    gear,
    intent: nextIntent,
    drafts: { ...s.drafts, [s.recipeId]: plan },
    draftSources: { ...s.draftSources, [s.recipeId]: "local" },
    source: "local",
    workflowId: plan.id === selectedPlan(s).id ? s.workflowId : null,
    planningResult: null,
  };
}

export const useWorkspace = create<Workspace>()(
  persist(
    (setState) => ({
      scene: defaultScene,
      gear: defaultGear,
      intent: defaultIntent,
      prompt: "A considered, slow reveal. Let the product feel sculptural.",
      plans: [],
      recipeId: "quarter-orbit",
      history: [],
      source: "local",
      workflowId: null,
      hydrated: false,
      drafts: {},
      draftSources: {},
      planningResult: null,
      updateScene: (scene) =>
        setState((s) => updatedDraft(s, scene, s.gear, s.intent)),
      updateGear: (gear) =>
        setState((s) => updatedDraft(s, s.scene, gear, s.intent)),
      updateIntent: (intent) =>
        setState((s) => updatedDraft(s, s.scene, s.gear, intent)),
      updateShot: (patch) =>
        setState((s) => {
          const current = selectedPlan(s);
          if (
            (patch.durationSeconds === undefined ||
              patch.durationSeconds === current.durationSeconds) &&
            (patch.height === undefined ||
              patch.height === current.cameraHeight)
          )
            return s;
          const intent = {
            ...s.intent,
            ...(patch.durationSeconds === undefined
              ? {}
              : { durationSeconds: patch.durationSeconds }),
            ...(patch.height === undefined
              ? {}
              : { cameraHeight: patch.height }),
          };
          const plan = compilePlan(s.scene, s.gear, intent, s.recipeId, {
            ...selectedPlan(s).overrides,
            ...patch,
          });
          return {
            intent,
            drafts: { ...s.drafts, [s.recipeId]: plan },
            draftSources: { ...s.draftSources, [s.recipeId]: "local" },
            source: "local",
            workflowId: plan.id === selectedPlan(s).id ? s.workflowId : null,
            planningResult: null,
          };
        }),
      setPrompt: (prompt) =>
        setState((s) => ({
          prompt,
          workflowId: prompt === s.prompt ? s.workflowId : null,
          planningResult: null,
        })),
      selectRecipe: (recipeId) =>
        setState((s) => {
          const current = selectedPlan(s);
          const target =
            s.drafts[recipeId] ??
            s.plans.find((p) => p.recipeId === recipeId) ??
            compilePlan(s.scene, s.gear, s.intent, recipeId);
          return {
            recipeId,
            workflowId:
              target.id === current.id ||
              s.plans.some((p) => p.id === target.id)
                ? s.workflowId
                : null,
            planningResult: null,
            scene: target.scene,
            gear: target.gear,
            intent: target.intent,
            source: s.draftSources[recipeId] ?? "local",
            drafts: { ...s.drafts, [s.recipeId]: current, [recipeId]: target },
          };
        }),
      setPlans: (plans, source, message, workflowId) =>
        setState((s) => {
          const first = plans[0];
          return {
            plans,
            source,
            workflowId: first ? workflowIdFrom(workflowId) : null,
            planningResult: {
              source,
              message:
                message ??
                (plans.length
                  ? `${plans.length} moves compiled and checked against your space.`
                  : "No camera move fits the current space and gear. Adjust the scene and try again."),
            },
            recipeId: first?.recipeId ?? s.recipeId,
            scene: first?.scene ?? s.scene,
            gear: first?.gear ?? s.gear,
            intent: first?.intent ?? s.intent,
            drafts: {
              ...s.drafts,
              ...Object.fromEntries(plans.map((p) => [p.recipeId, p])),
            },
            draftSources: {
              ...s.draftSources,
              ...Object.fromEntries(plans.map((p) => [p.recipeId, source])),
            },
          };
        }),
      saveVersion: (plan) =>
        setState((s) => ({
          history: [
            structuredClone(plan),
            ...s.history.filter((p) => p.id !== plan.id),
          ].slice(0, 20),
        })),
      restore: (snapshot, workflowId) =>
        setState((s) => {
          const plan = compilePlan(
            snapshot.scene,
            snapshot.gear,
            snapshot.intent,
            snapshot.recipeId,
            snapshot.overrides,
          );
          return {
            plans: [plan],
            scene: plan.scene,
            gear: plan.gear,
            intent: plan.intent,
            recipeId: plan.recipeId,
            drafts: { ...s.drafts, [plan.recipeId]: plan },
            draftSources: { ...s.draftSources, [plan.recipeId]: "saved" },
            source: "saved",
            workflowId: workflowIdFrom(workflowId),
            planningResult: null,
          };
        }),
      reset: () =>
        setState({
          scene: structuredClone(defaultScene),
          gear: structuredClone(defaultGear),
          intent: structuredClone(defaultIntent),
          plans: [],
          recipeId: "quarter-orbit",
          drafts: {},
          draftSources: {},
          source: "local",
          workflowId: null,
          planningResult: null,
        }),
      markHydrated: () => setState({ hydrated: true }),
    }),
    {
      name: "flowblock-workspace-v1",
      storage: createJSONStorage(() => storage),
      skipHydration: true,
      partialize: ({
        scene,
        gear,
        intent,
        prompt,
        recipeId,
        history,
        drafts,
        draftSources,
        plans,
        source,
        planningResult,
        workflowId,
      }) => ({
        scene,
        gear,
        intent,
        prompt,
        recipeId,
        history,
        drafts,
        draftSources,
        plans,
        source,
        planningResult,
        workflowId,
      }),
    },
  ),
);

export function selectedPlan(
  s: Pick<
    Workspace,
    "plans" | "recipeId" | "scene" | "gear" | "intent" | "drafts"
  >,
): PlanVersion {
  return (
    s.drafts[s.recipeId] ??
    s.plans.find((p) => p.recipeId === s.recipeId) ??
    compilePlan(s.scene, s.gear, s.intent, s.recipeId)
  );
}

export function workflowIdFrom(value: unknown): string | null {
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}
