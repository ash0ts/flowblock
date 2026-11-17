import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import {
  chat,
  type ChatResult,
  type PlannerMessage,
} from "../../../src/server/planner";
import { runResearchPlanner } from "../next/planner";
import { openBudgetLedger, BudgetStop } from "../next/budget";
import { gradeTask } from "../next/run";
import type { Task } from "../next/grade";
import { independentlyCheckPlan } from "./fixtures";

const [configPath] = process.argv.slice(2);
const config = JSON.parse(readFileSync(configPath, "utf8")) as {
  task: Task;
  model: string;
  arm: "llama-base" | "llama-sft";
  output: string;
  ledger: string;
  initialNanodollars: number;
};
const ledger = openBudgetLedger(config.ledger);
const total = () =>
  ledger
    .snapshot()
    .calls.reduce(
      (n, c) => n + (c.chargedNanodollars ?? c.reservedNanodollars),
      0,
    );
const calls: {
  status: string;
  reservationId?: string;
  usage?: ChatResult["usage"];
}[] = [];
mkdirSync(resolve(config.output, "calls"), { recursive: true });
const write = (name: string, data: unknown) =>
  writeFileSync(
    resolve(config.output, name),
    JSON.stringify(data, null, 2) + "\n",
    { flag: "wx" },
  );
const delay = monitorEventLoopDelay({ resolution: 20 });
delay.enable();
const started = performance.now();
let budgetStopped = false;
const recordedChat = async (
  messages: PlannerMessage[],
  model: string,
  signal: AbortSignal,
): Promise<ChatResult> => {
  const allowance =
    Buffer.byteLength(JSON.stringify(messages), "utf8") +
    1024 +
    messages.length * 128;
  if (
    total() - config.initialNanodollars + (allowance + 1600) * 220 >
    2_000_000_000
  ) {
    budgetStopped = true;
    throw new BudgetStop(
      "The new experiment's $2 inference allocation is exhausted.",
    );
  }
  let reservationId: string;
  try {
    reservationId = ledger.reserve(config.arm, config.task.id, messages);
  } catch (error) {
    if (error instanceof BudgetStop) budgetStopped = true;
    throw error;
  }
  const index = calls.length;
  const call: (typeof calls)[number] = {
    status: "outcome-unknown",
    reservationId,
  };
  calls.push(call);
  write(`calls/${index}-request.json`, {
    model,
    messages,
    reservationId,
    startedAt: new Date().toISOString(),
  });
  const t = performance.now();
  try {
    const response = await chat(messages, model, signal);
    write(`calls/${index}-response.json`, {
      response,
      elapsedMs: performance.now() - t,
    });
    ledger.settle(reservationId, response.usage);
    call.status = "completed";
    call.usage = response.usage;
    return response;
  } catch (error) {
    if (error instanceof BudgetStop) budgetStopped = true;
    write(`calls/${index}-error.json`, {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : "Unknown error",
      elapsedMs: performance.now() - t,
      outcome: "unknown",
      retried: false,
    });
    throw error;
  }
};
try {
  const result = await runResearchPlanner(config.task.input, {
    model: config.model,
    deadlineMs: 30_000,
    chat: recordedChat,
    trace: false,
  });
  const infrastructure = ["deadline", "provider-error", "tool-error"].includes(
    result.termination,
  );
  const available = calls.length > 0 && !infrastructure && !budgetStopped;
  const grade = available ? gradeTask(config.task, result, config.arm) : null;
  write("result.json", {
    taskId: config.task.id,
    arm: config.arm,
    available,
    attempted: calls.length > 0,
    budgetStopped,
    result,
    grade,
    independentChecks: result.plans.map((plan) =>
      independentlyCheckPlan(config.task, plan),
    ),
    calls,
    monotonicElapsedMs: performance.now() - started,
    eventLoopDelayMaxMs: delay.max / 1e6,
    tracing:
      "disabled equally in both arms; exact actions and requests recorded locally",
  });
} finally {
  delay.disable();
  ledger.close();
}
process.exit(0);
