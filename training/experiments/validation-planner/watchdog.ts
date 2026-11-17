import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

export interface WatchdogOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  killGraceMs?: number;
  /** Combined retained stdout and stderr bytes. Excess output is drained. */
  maxOutputBytes?: number;
}

export interface WatchdogSignal {
  signal: "SIGTERM" | "SIGKILL";
  monotonicElapsedMs: number;
  target: "process_group" | "process";
  sent: boolean;
  errorCode?: string;
}

export interface WatchdogReceipt {
  version: "flowblock-experiment-watchdog-v1";
  status: "completed" | "failed" | "timed_out" | "spawn_failed";
  startedAt: string;
  endedAt: string;
  monotonicElapsedMs: number;
  wallElapsedMs: number;
  timeoutMs: number;
  killGraceMs: number;
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  processExitObserved: boolean;
  signals: WatchdogSignal[];
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutCapturedBytes: number;
  stderrCapturedBytes: number;
  outputLimitBytes: number;
  outputTruncated: boolean;
  errorCode?: string;
  responseStatus: "uninspected" | "unknown";
  remoteCancellation: "not_attempted";
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647)
    throw new RangeError(`${name} must be a positive 32-bit integer`);
  return value;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error)
    return String(error.code);
  return "UNKNOWN";
}

/**
 * Experiment-only process isolation. A child event-loop stall cannot suppress
 * this parent's timer. Host suspension or a stalled parent can still delay it.
 * Terminating a client is not evidence that a remote request was cancelled.
 */
export function runWithWatchdog(
  options: WatchdogOptions,
): Promise<WatchdogReceipt> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? 35_000, "timeoutMs");
  const killGraceMs = positiveInteger(
    options.killGraceMs ?? 250,
    "killGraceMs",
  );
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? 1_048_576,
    "maxOutputBytes",
  );
  const startedWall = Date.now();
  const startedMonotonic = performance.now();
  const elapsed = () => performance.now() - startedMonotonic;
  const useProcessGroup = process.platform !== "win32";

  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let timedOut = false;
    let settled = false;
    let processExitObserved = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnError: string | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const signals: WatchdogSignal[] = [];
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapturedBytes = 0;
    let stderrCapturedBytes = 0;
    let remainingBytes = maxOutputBytes;

    const capture = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const retained = Math.min(chunk.length, remainingBytes);
      if (stream === "stdout") stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (retained === 0) return;
      // Copy so a small retained prefix cannot keep a larger chunk alive.
      const copy = Buffer.from(chunk.subarray(0, retained));
      if (stream === "stdout") {
        stdout.push(copy);
        stdoutCapturedBytes += retained;
      } else {
        stderr.push(copy);
        stderrCapturedBytes += retained;
      }
      remainingBytes -= retained;
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (!processExitObserved) child?.unref();
      const endedWall = Date.now();
      resolve({
        version: "flowblock-experiment-watchdog-v1",
        status: timedOut
          ? "timed_out"
          : spawnError
            ? "spawn_failed"
            : exitCode === 0 && exitSignal === null
              ? "completed"
              : "failed",
        startedAt: new Date(startedWall).toISOString(),
        endedAt: new Date(endedWall).toISOString(),
        monotonicElapsedMs: elapsed(),
        wallElapsedMs: endedWall - startedWall,
        timeoutMs,
        killGraceMs,
        pid: child?.pid ?? null,
        exitCode,
        signal: exitSignal,
        processExitObserved,
        signals,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutBytes,
        stderrBytes,
        stdoutCapturedBytes,
        stderrCapturedBytes,
        outputLimitBytes: maxOutputBytes,
        outputTruncated: stdoutBytes + stderrBytes > maxOutputBytes,
        ...(spawnError ? { errorCode: spawnError } : {}),
        responseStatus: timedOut || spawnError ? "unknown" : "uninspected",
        remoteCancellation: "not_attempted",
      });
    };

    const terminate = (signal: WatchdogSignal["signal"]) => {
      const attempt: WatchdogSignal = {
        signal,
        monotonicElapsedMs: elapsed(),
        target: useProcessGroup ? "process_group" : "process",
        sent: false,
      };
      try {
        if (useProcessGroup && child?.pid) {
          process.kill(-child.pid, signal);
          attempt.sent = true;
        } else if (child) {
          attempt.sent = child.kill(signal);
        }
      } catch (error) {
        attempt.errorCode = errorCode(error);
      }
      signals.push(attempt);
    };

    try {
      child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env: options.env,
        detached: useProcessGroup,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = errorCode(error);
      finish();
      return;
    }
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, "stderr"));
    child.once("error", (error) => {
      spawnError = errorCode(error);
      finish();
    });
    child.once("exit", (code, signal) => {
      processExitObserved = true;
      exitCode = code;
      exitSignal = signal;
    });
    child.once("close", finish);

    timers.add(
      setTimeout(
        () => {
          timedOut = true;
          terminate("SIGTERM");
          timers.add(
            setTimeout(() => {
              terminate("SIGKILL");
              // A failed OS signal must not leave this promise waiting forever.
              // processExitObserved stays false until an exit event is received.
              timers.add(setTimeout(finish, 1_000));
            }, killGraceMs),
          );
        },
        Math.max(1, timeoutMs - elapsed()),
      ),
    );
  });
}
