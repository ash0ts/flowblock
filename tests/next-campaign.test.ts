import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  BudgetStop,
  openBudgetLedger,
} from "../training/experiments/next/budget";
import {
  executeWaves,
  classifyTaskOutcome,
  gradeTask,
  prewarmTelemetry,
  isInfrastructureFailure,
  summarize,
  type Entry,
} from "../training/experiments/next/run";
import { createTasks } from "../training/experiments/next/fixtures";
import { compilePlan } from "../src/domain";
import type { PlanningResult } from "../src/server/planner";
import type { Task } from "../training/experiments/next/grade";
const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});
function ledgerPath() {
  const path = mkdtempSync(resolve(tmpdir(), "flowblock-budget-"));
  directories.push(path);
  return resolve(path, "ledger.json");
}

describe("campaign failure accounting", () => {
  it("completes the issued wave then leaves remaining tasks unattempted after two infrastructure failures", async () => {
    const tasks = [0, 1, 2, 3, 4, 5].map((id) => ({ id: String(id) }) as Task);
    const called: string[] = [];
    const result = await executeWaves(
      tasks,
      async (task) => {
        called.push(task.id);
        return { taskId: task.id, failed: true };
      },
      (entry) => entry.failed,
    );
    expect(called).toEqual(["0", "1"]);
    expect(result.results).toHaveLength(2);
    expect(result.unattempted.map((task) => task.id)).toEqual([
      "2",
      "3",
      "4",
      "5",
    ]);
  });
  it("waits for an already issued task when another task fails to persist", async () => {
    const tasks = [0, 1].map((id) => ({ id: String(id) }) as Task);
    let secondFinished = false;
    await expect(
      executeWaves(
        tasks,
        async (task) => {
          if (task.id === "0") throw new Error("persistence failed");
          await Promise.resolve();
          secondFinished = true;
          return true;
        },
        () => false,
      ),
    ).rejects.toThrow("persistence failed");
    expect(secondFinished).toBe(true);
  });
  it("uses requested and available denominators without treating unattempted tasks as actor failures", () => {
    const base: Entry = {
      taskId: "one",
      sceneGroup: "room",
      arm: "llama-base",
      attempted: true,
      available: false,
      status: "service-unavailable",
      termination: "provider-error",
      grade: null,
      latencyMs: 50,
      usage: null,
      usageComplete: false,
    };
    const entries: Entry[] = [
      base,
      { ...base, taskId: "two" },
      {
        ...base,
        taskId: "three",
        attempted: false,
        status: "unattempted",
        termination: "campaign-infrastructure-stop",
        latencyMs: null,
      },
    ];
    expect(summarize(entries)).toMatchObject({
      requested: 3,
      attempted: 2,
      available: 0,
      serviceUnavailable: 2,
      unattempted: 1,
      productiveAmongAvailable: null,
      productiveAmongRequested: 0,
    });
  });
});
describe("coordinator deadline accounting", () => {
  const base: Entry = {
    taskId: "one",
    sceneGroup: "room",
    arm: "gpt-oss",
    attempted: true,
    available: false,
    status: "operational-failure",
    termination: "deadline",
    grade: null,
    latencyMs: 30000,
    usage: null,
    usageComplete: false,
  };
  it("records an issued deadline as unavailable without calling it a provider outage", () => {
    const classification = classifyTaskOutcome({
      attempted: true,
      providerFailed: false,
      budgetStopped: false,
      coordinatorDeadline: true,
      termination: "fallback",
    });
    expect(classification).toEqual({
      available: false,
      status: "operational-failure",
      termination: "deadline",
    });
    expect(isInfrastructureFailure({ ...base, ...classification })).toBe(false);
    expect(summarize([{ ...base, ...classification }])).toMatchObject({
      requested: 1,
      attempted: 1,
      available: 0,
      operationalFailures: 1,
      serviceUnavailable: 0,
      productiveAmongRequested: 0,
      productiveAmongAvailable: null,
    });
  });
  it("keeps a deadline before any provider call unattempted and unscored", () => {
    expect(
      classifyTaskOutcome({
        attempted: false,
        providerFailed: false,
        budgetStopped: false,
        coordinatorDeadline: true,
        termination: "deadline",
      }),
    ).toEqual({
      available: false,
      status: "unattempted",
      termination: "coordinator-deadline-before-provider",
    });
  });
  it("keeps a transport failure distinct even when the coordinator later runs out of time", () => {
    const classification = classifyTaskOutcome({
      attempted: true,
      providerFailed: true,
      budgetStopped: false,
      coordinatorDeadline: true,
      termination: "deadline",
    });
    expect(classification).toEqual({
      available: false,
      status: "service-unavailable",
      termination: "provider-error",
    });
    expect(isInfrastructureFailure({ ...base, ...classification })).toBe(true);
  });
  it("does not stop later waves after coordinator deadlines", async () => {
    const tasks = [0, 1, 2, 3].map((id) => ({ id: String(id) }) as Task);
    const result = await executeWaves(
      tasks,
      async (task) => ({ ...base, taskId: task.id }),
      isInfrastructureFailure,
    );
    expect(result.results).toHaveLength(4);
    expect(result.unattempted).toEqual([]);
  });
});
describe("shared inference budget", () => {
  it("reserves before requests, retains unknown responses and records rate-based estimates separately", () => {
    const path = ledgerPath(),
      ledger = openBudgetLedger(path);
    try {
      const id = ledger.reserve("llama-base", "task", [
        { role: "user", content: "hello" },
      ]);
      const unknown = ledger.reserve("gpt-oss", "task2", [
        { role: "user", content: "hello" },
      ]);
      ledger.settle(id, { inputTokens: 10, outputTokens: 20 });
      const snapshot = ledger.snapshot();
      expect(snapshot.calls.find((call) => call.id === id)).toMatchObject({
        status: "estimated-charge",
        chargedNanodollars: 6600,
      });
      expect(snapshot.calls.find((call) => call.id === unknown)?.status).toBe(
        "reserved",
      );
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(snapshot);
      expect(() => openBudgetLedger(path)).toThrow();
    } finally {
      ledger.close();
    }
  });
  it("stops future calls when reported usage exceeds its reservation", () => {
    const ledger = openBudgetLedger(ledgerPath());
    try {
      const id = ledger.reserve("llama-sft", "task", [
        { role: "user", content: "hello" },
      ]);
      expect(() =>
        ledger.settle(id, { inputTokens: 10, outputTokens: 1601 }),
      ).toThrow(BudgetStop);
      expect(ledger.stopped).toBe(true);
      expect(() => ledger.reserve("llama-base", "other", [])).toThrow(
        BudgetStop,
      );
    } finally {
      ledger.close();
    }
  });
  it("rejects a reservation larger than the complete campaign cap", () => {
    const ledger = openBudgetLedger(ledgerPath());
    try {
      expect(() =>
        ledger.reserve("llama-base", "huge", [
          { role: "user", content: "x".repeat(100_000_000) },
        ]),
      ).toThrow(BudgetStop);
      expect(ledger.snapshot().calls).toEqual([]);
    } finally {
      ledger.close();
    }
  });
});

describe("evidence-backed abstention", () => {
  const task = createTasks("development", 6, 321).find(
    (task) => task.briefSpec.requiresForegroundOcclusion,
  )!;
  const finish = {
    action: {
      action: "finish",
      candidateIds: [],
      explanation: "Occlusion is unsupported.",
    },
    observation: { accepted: [] },
    elapsedMs: 1,
  };
  const result = (events: PlanningResult["events"]): PlanningResult => ({
    plans: [],
    source: "forge",
    events,
    message: "",
    usage: { inputTokens: 0, outputTokens: 0 },
    inputHash: "test",
    plannerVersion: "test",
    latencyMs: 1,
  });
  it("does not credit an unchecked empty finish as supported abstention", () => {
    expect(gradeTask(task, result([finish]), "gpt-oss")).toMatchObject({
      emptyFinish: true,
      compileChecked: false,
      uncheckedEmpty: true,
      unsupportedAbstention: false,
    });
  });
  it("requires a returned validation observation rather than a raw compile request or tool error", () => {
    for (const observation of [
      {},
      { error: "tool_failure" },
      {
        candidateId: "fake",
        recipeId: "left-reveal",
        validation: { valid: false },
      },
    ])
      expect(
        gradeTask(
          task,
          result([
            {
              action: {
                action: "compile_candidate",
                recipeId: "left-reveal",
                overrides: {},
              },
              observation,
              elapsedMs: 0,
            },
            finish,
          ]),
          "gpt-oss",
        ).unsupportedAbstention,
      ).toBe(false);
  });
  it("credits an unsupported empty result only after an executed compile with complete validation", () => {
    const plan = compilePlan(
      task.input.scene,
      task.input.gear,
      task.input.intent,
      "left-reveal",
      { height: task.input.intent.cameraHeight },
    );
    const compile = {
      action: {
        action: "compile_candidate",
        recipeId: "left-reveal",
        overrides: { height: task.input.intent.cameraHeight },
      },
      observation: {
        candidateId: plan.id,
        recipeId: plan.recipeId,
        validation: plan.validation,
      },
      elapsedMs: 0,
    };
    expect(gradeTask(task, result([compile, finish]), "gpt-oss")).toMatchObject(
      {
        emptyFinish: true,
        compileChecked: true,
        uncheckedEmpty: false,
        unsupportedAbstention: true,
      },
    );
    expect(
      gradeTask(task, result([finish, compile]), "gpt-oss")
        .unsupportedAbstention,
    ).toBe(false);
  });
});

describe("telemetry initialization before task timing", () => {
  it("waits for actual initialization beyond the one-second in-task tracing limit", async () => {
    vi.useFakeTimers();
    let settled = false;
    const pending = prewarmTelemetry(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 2500)),
    ).then((receipt) => {
      settled = true;
      return receipt;
    });
    await vi.advanceTimersByTimeAsync(1001);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1499);
    expect(await pending).toMatchObject({
      initialized: true,
      status: "initialized",
      latencyMs: 2500,
      timeoutMs: 60000,
    });
  });
  it("continues after its own timeout without claiming tracing initialized", async () => {
    vi.useFakeTimers();
    const pending = prewarmTelemetry(() => new Promise(() => {}), 60000);
    await vi.advanceTimersByTimeAsync(60000);
    expect(await pending).toMatchObject({
      initialized: false,
      status: "deadline",
      latencyMs: 60000,
    });
  });
  it("records unavailable or failed initialization and rejects an unbounded timeout", async () => {
    expect(await prewarmTelemetry(async () => false)).toMatchObject({
      initialized: false,
      status: "unavailable",
    });
    expect(
      await prewarmTelemetry(async () => {
        throw new Error("SDK unavailable");
      }),
    ).toMatchObject({ initialized: false, status: "failed" });
    await expect(prewarmTelemetry(async () => true, 60001)).rejects.toThrow(
      "at most 60 seconds",
    );
  });
});

describe("serial campaign transport amendment", () => {
  it("never overlaps tasks when campaign concurrency is one", async () => {
    let active = 0,
      peak = 0;
    const tasks = [0, 1, 2, 3].map((id) => ({ id: String(id) }) as Task);
    const result = await executeWaves(
      tasks,
      async () => {
        active++;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active--;
        return false;
      },
      () => false,
      () => false,
      1,
    );
    expect(peak).toBe(1);
    expect(result.results).toHaveLength(4);
  });
});
