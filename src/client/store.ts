import { create } from "zustand";
import {
  createJSONStorage,
  persist,
  type StateStorage,
} from "zustand/middleware";
import { get, set, del } from "idb-keyval";
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

const storage: StateStorage = {
  getItem: async (name) => {
    try {
      return (await get<string>(name)) ?? null;
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    try {
      await set(name, value);
    } catch {
      if (typeof window !== "undefined")
        window.dispatchEvent(new Event("flowblock-storage-error"));
    }
  },
  removeItem: async (name) => {
    try {
      await del(name);
    } catch {
      /* No stored item to remove. */
    }
  },
};

type Workspace = {
  scene: Scene;
  gear: Gear;
  intent: Intent;
  prompt: string;
  plans: PlanVersion[];
  recipeId: RecipeId;
  history: PlanVersion[];
  source: string;
  hydrated: boolean;
  planningResult: { source: string; message: string } | null;
  drafts: Partial<Record<RecipeId, PlanVersion>>;
  draftSources: Partial<Record<RecipeId, string>>;
  updateScene: (scene: Scene) => void;
  updateGear: (gear: Gear) => void;
  updateIntent: (intent: Intent) => void;
  setPrompt: (prompt: string) => void;
  selectRecipe: (recipeId: RecipeId) => void;
  setPlans: (plans: PlanVersion[], source: string, message?: string) => void;
  saveVersion: (plan: PlanVersion) => void;
  restore: (plan: PlanVersion) => void;
  reset: () => void;
  markHydrated: () => void;
};

function updatedDraft(s: Workspace, scene: Scene, gear: Gear, intent: Intent) {
  const plan = compilePlan(
    scene,
    gear,
    intent,
    s.recipeId,
    s.drafts[s.recipeId]?.overrides,
  );
  return {
    scene,
    gear,
    intent,
    drafts: { ...s.drafts, [s.recipeId]: plan },
    draftSources: { ...s.draftSources, [s.recipeId]: "local" },
    source: "local",
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
      setPrompt: (prompt) => setState({ prompt, planningResult: null }),
      selectRecipe: (recipeId) =>
        setState((s) => {
          const current = selectedPlan(s);
          const target =
            s.drafts[recipeId] ??
            s.plans.find((p) => p.recipeId === recipeId) ??
            compilePlan(s.scene, s.gear, s.intent, recipeId);
          return {
            recipeId,
            planningResult: null,
            scene: target.scene,
            gear: target.gear,
            intent: target.intent,
            source: s.draftSources[recipeId] ?? "local",
            drafts: { ...s.drafts, [s.recipeId]: current, [recipeId]: target },
          };
        }),
      setPlans: (plans, source, message) =>
        setState((s) => {
          const first = plans[0];
          return {
            plans,
            source,
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
      restore: (plan) =>
        setState((s) => ({
          scene: plan.scene,
          gear: plan.gear,
          intent: plan.intent,
          recipeId: plan.recipeId,
          drafts: { ...s.drafts, [plan.recipeId]: plan },
          draftSources: { ...s.draftSources, [plan.recipeId]: "saved" },
          source: "saved",
          planningResult: null,
        })),
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
