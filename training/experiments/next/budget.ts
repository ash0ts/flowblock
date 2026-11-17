import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { PlannerMessage } from "../../../src/server/planner";

const cap = 20_000_000_000;
export class BudgetStop extends Error {}
type Call = {
  id: string;
  arm: string;
  taskId: string;
  reservedNanodollars: number;
  chargedNanodollars?: number;
  status: "reserved" | "estimated-charge" | "usage-discrepancy";
  inputAllowance: number;
  maxOutputTokens: number;
  reportedInputTokens?: number;
  reportedOutputTokens?: number;
};
type Ledger = {
  schemaVersion: 1;
  authorizedTotalDollars: 200;
  inferenceCapDollars: 20;
  maxCalls: 10000;
  costDisclosure: string;
  calls: Call[];
  stopped: boolean;
};

/** One campaign owns the lock. Calls mutate synchronously before awaiting I/O. */
export function openBudgetLedger(rawPath: string) {
  const path = resolve(rawPath);
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = openSync(lockPath, "wx");
  writeFileSync(
    lock,
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
  );
  let ledger: Ledger;
  const save = () => {
    const temp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temp, "wx");
    try {
      writeFileSync(fd, `${JSON.stringify(ledger, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  };
  try {
    ledger = existsSync(path)
      ? (JSON.parse(readFileSync(path, "utf8")) as Ledger)
      : {
          schemaVersion: 1,
          authorizedTotalDollars: 200,
          inferenceCapDollars: 20,
          maxCalls: 10000,
          costDisclosure:
            "Conservative rate-based inference reservations and estimates; not invoice-derived billed cost. Unknown responses keep their full reservation. Training is budgeted separately within the user's $200 total.",
          calls: [],
          stopped: false,
        };
    if (
      ledger.schemaVersion !== 1 ||
      ledger.authorizedTotalDollars !== 200 ||
      ledger.inferenceCapDollars !== 20 ||
      ledger.maxCalls !== 10000 ||
      !Array.isArray(ledger.calls)
    )
      throw new Error("Unexpected budget ledger contract.");
    save();
  } catch (error) {
    closeSync(lock);
    unlinkSync(lockPath);
    throw error;
  }
  const total = () =>
    ledger.calls.reduce(
      (sum, call) =>
        sum + (call.chargedNanodollars ?? call.reservedNanodollars),
      0,
    );
  return {
    reserve(arm: string, taskId: string, messages: PlannerMessage[]) {
      if (ledger.stopped)
        throw new BudgetStop(
          "The inference ledger is stopped after a usage discrepancy.",
        );
      const inputAllowance =
        Buffer.byteLength(JSON.stringify(messages), "utf8") +
        1024 +
        messages.length * 128;
      const [inputRate, outputRate] =
        arm === "gpt-oss" ? [30, 130] : [220, 220];
      const reservedNanodollars =
        inputAllowance * inputRate + 1600 * outputRate;
      if (
        ledger.calls.length >= ledger.maxCalls ||
        total() + reservedNanodollars > cap
      )
        throw new BudgetStop(
          "The inference reserve or request cap has been reached.",
        );
      const call: Call = {
        id: randomUUID(),
        arm,
        taskId,
        reservedNanodollars,
        status: "reserved",
        inputAllowance,
        maxOutputTokens: 1600,
      };
      ledger.calls.push(call);
      save();
      return call.id;
    },
    settle(id: string, usage: { inputTokens: number; outputTokens: number }) {
      const call = ledger.calls.find((item) => item.id === id);
      if (!call || call.status !== "reserved")
        throw new Error("Unknown or already settled inference reservation.");
      if (
        ![usage.inputTokens, usage.outputTokens].every(
          (value) => Number.isInteger(value) && value >= 0,
        )
      )
        throw new Error("Invalid reported usage.");
      if (usage.inputTokens === 0 && usage.outputTokens === 0) return;
      const [inputRate, outputRate] =
        call.arm === "gpt-oss" ? [30, 130] : [220, 220];
      const chargedNanodollars =
        usage.inputTokens * inputRate + usage.outputTokens * outputRate;
      Object.assign(call, {
        reportedInputTokens: usage.inputTokens,
        reportedOutputTokens: usage.outputTokens,
      });
      if (
        usage.inputTokens > call.inputAllowance ||
        usage.outputTokens > call.maxOutputTokens ||
        chargedNanodollars > call.reservedNanodollars
      ) {
        call.status = "usage-discrepancy";
        call.chargedNanodollars = Math.max(
          chargedNanodollars,
          call.reservedNanodollars,
        );
        ledger.stopped = true;
        save();
        throw new BudgetStop(
          "Provider usage exceeded the reserved allowance; the ledger is stopped.",
        );
      }
      call.status = "estimated-charge";
      call.chargedNanodollars = chargedNanodollars;
      save();
    },
    snapshot: () => structuredClone(ledger),
    get stopped() {
      return ledger.stopped;
    },
    close() {
      closeSync(lock);
      unlinkSync(lockPath);
    },
  };
}
