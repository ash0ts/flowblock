import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  compilePlan,
  defaultGear,
  defaultIntent,
  defaultScene,
} from "../src/domain";

const data = vi.hoisted(() => new Map<string, string>());
vi.mock("idb-keyval", () => ({
  get: async (key: string) => data.get(key),
  set: async (key: string, value: string) => {
    data.set(key, value);
  },
  del: async (key: string) => {
    data.delete(key);
  },
}));
import { selectedPlan, useWorkspace } from "../src/client/store";
import { useTakeHistory, type SavedAttempt } from "../src/client/takes";

const workflowId = "11111111-1111-4111-8111-111111111111";
const plan = compilePlan(defaultScene, defaultGear, defaultIntent, "hero-hold");
const second = compilePlan(
  defaultScene,
  defaultGear,
  defaultIntent,
  "quarter-orbit",
);
const workspaceKey = "flowblock-workspace-v1";
const takeKey = "flowblock-takes-v1";

beforeEach(() => {
  useWorkspace.setState(useWorkspace.getInitialState(), true);
  useTakeHistory.setState(useTakeHistory.getInitialState(), true);
  data.clear();
});

function generated() {
  useWorkspace
    .getState()
    .setPlans([plan, second], "forge", "A unit-test plan", workflowId);
}

function attempt(): SavedAttempt {
  return {
    id: "local-attempt",
    name: "unit-test.mp4",
    createdAt: "2026-10-30T00:00:00Z",
    plan,
    takeId: "22222222-2222-4222-8222-222222222222",
    workflowId,
    duration: 5,
    ratio: 16 / 9,
    uploadComplete: true,
    analysis: null,
    seed: null,
    corrections: [],
    expectedStart: 0,
    expectedEnd: 5,
    revised: false,
  };
}

describe("workflow identity in the saved editor", () => {
  it("rehydrates generated plans and their workflow while retaining methods", async () => {
    generated();
    const saved = data.get(workspaceKey)!;
    useWorkspace.setState(useWorkspace.getInitialState(), true);
    data.set(workspaceKey, saved);
    await useWorkspace.persist.rehydrate();
    expect(useWorkspace.getState().workflowId).toBe(workflowId);
    expect(selectedPlan(useWorkspace.getState()).id).toBe(plan.id);
    expect(typeof useWorkspace.getState().updateShot).toBe("function");
    useWorkspace.getState().selectRecipe(second.recipeId);
    expect(useWorkspace.getState().workflowId).toBe(workflowId);
    useWorkspace.getState().selectRecipe("gentle-push");
    expect(useWorkspace.getState().workflowId).toBeNull();
  });

  it.each(["scene", "gear", "intent", "shot", "brief"] as const)(
    "starts a separate workflow after a real %s edit",
    (field) => {
      generated();
      const s = useWorkspace.getState();
      if (field === "scene")
        s.updateScene({ ...s.scene, measurementUncertainty: 0.05 });
      if (field === "gear")
        s.updateGear({
          ...s.gear,
          lens: { kind: "equivalent", focalLengthMm: 35 },
        });
      if (field === "intent") s.updateIntent({ ...s.intent, framing: "wide" });
      if (field === "shot") s.updateShot({ durationSeconds: 12 });
      if (field === "brief") s.setPrompt("A different creator brief");
      expect(useWorkspace.getState().workflowId).toBeNull();
      expect(JSON.parse(data.get(workspaceKey)!).state.workflowId).toBeNull();
    },
  );

  it("keeps a workflow for unchanged inputs and explicitly accepted revisions only", () => {
    generated();
    let s = useWorkspace.getState();
    s.updateScene(structuredClone(s.scene));
    s = useWorkspace.getState();
    s.updateGear(structuredClone(s.gear));
    s = useWorkspace.getState();
    s.updateIntent(structuredClone(s.intent));
    s = useWorkspace.getState();
    s.updateShot({
      durationSeconds: plan.durationSeconds,
      height: plan.cameraHeight,
    });
    s.setPrompt(s.prompt);
    expect(useWorkspace.getState().workflowId).toBe(workflowId);
    const revised = compilePlan(
      plan.scene,
      plan.gear,
      plan.intent,
      plan.recipeId,
      { distance: 2.5 },
    );
    useWorkspace.getState().restore(revised, workflowId);
    expect(useWorkspace.getState().workflowId).toBe(workflowId);
    useWorkspace.getState().restore(plan);
    expect(useWorkspace.getState().workflowId).toBeNull();
    generated();
    useWorkspace.getState().setPlans([plan], "local");
    expect(useWorkspace.getState().workflowId).toBeNull();
    generated();
    useWorkspace.getState().reset();
    expect(useWorkspace.getState().workflowId).toBeNull();
  });

  it("does not attribute an existing draft to a later request with no selected plan", () => {
    generated();
    useWorkspace
      .getState()
      .setPlans(
        [],
        "forge",
        "No checked move fits",
        "33333333-3333-4333-8333-333333333333",
      );
    expect(selectedPlan(useWorkspace.getState()).id).toBe(plan.id);
    expect(useWorkspace.getState().workflowId).toBeNull();
  });

  it("does not carry a saved take's workflow onto an unrelated generated recipe", () => {
    generated();
    const savedTakeWorkflow = "33333333-3333-4333-8333-333333333333";
    const accepted = compilePlan(
      plan.scene,
      plan.gear,
      plan.intent,
      plan.recipeId,
      { distance: 2.5 },
    );
    useWorkspace.getState().restore(accepted, savedTakeWorkflow);
    expect(useWorkspace.getState().workflowId).toBe(savedTakeWorkflow);
    expect(selectedPlan(useWorkspace.getState()).id).toBe(accepted.id);
    useWorkspace.getState().selectRecipe(second.recipeId);
    expect(selectedPlan(useWorkspace.getState()).id).toBe(second.id);
    expect(useWorkspace.getState().workflowId).toBeNull();
  });

  it("opens older saved plans without inventing a workflow", async () => {
    data.set(
      workspaceKey,
      JSON.stringify({
        version: 0,
        state: { plans: [plan], recipeId: plan.recipeId },
      }),
    );
    await useWorkspace.persist.rehydrate();
    expect(selectedPlan(useWorkspace.getState()).id).toBe(plan.id);
    expect(useWorkspace.getState().workflowId).toBeNull();
  });
});

describe("workflow identity in saved takes", () => {
  it("keeps the analyzed attempt attached to its workflow across reloads", async () => {
    useTakeHistory.getState().save(attempt());
    const saved = data.get(takeKey)!;
    useTakeHistory.setState(useTakeHistory.getInitialState(), true);
    data.set(takeKey, saved);
    await useTakeHistory.persist.rehydrate();
    expect(useTakeHistory.getState().attempts[0]).toEqual(attempt());
  });

  it("preserves legacy takes with an explicitly absent workflow", async () => {
    const legacy = { ...attempt() } as Partial<SavedAttempt>;
    delete legacy.workflowId;
    data.set(
      takeKey,
      JSON.stringify({ version: 0, state: { attempts: [legacy] } }),
    );
    await useTakeHistory.persist.rehydrate();
    expect(useTakeHistory.getState().attempts[0]).toEqual({
      ...legacy,
      workflowId: null,
    });
  });

  it("rejects malformed persisted workflow IDs instead of using them for another upload", async () => {
    data.set(
      takeKey,
      JSON.stringify({
        version: 0,
        state: { attempts: [{ ...attempt(), workflowId: "not-a-workflow" }] },
      }),
    );
    await useTakeHistory.persist.rehydrate();
    expect(useTakeHistory.getState().attempts).toEqual([]);
  });
});
