import { describe, expect, it } from "vitest";
import { runWithWatchdog } from "../training/experiments/validation-planner/watchdog";
import { watchdogProbeCases } from "../training/experiments/validation-planner/watchdog-probe";

const child = (source: string, overrides: Record<string, number> = {}) =>
  runWithWatchdog({
    command: process.execPath,
    args: ["-e", source],
    env: { NODE_ENV: "test" },
    timeoutMs: 500,
    killGraceMs: 75,
    ...overrides,
  });

describe("research process watchdog", () => {
  it("captures normal completion without claiming to inspect the provider response", async () => {
    const result = await child(watchdogProbeCases.normal);
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.processExitObserved).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ status: "ok" });
    expect(result.responseStatus).toBe("uninspected");
    expect(result.signals).toEqual([]);
    expect(result.monotonicElapsedMs).toBeGreaterThan(0);
    expect(result.wallElapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("ends a hanging local HTTP request with unknown response status", async () => {
    const result = await child(watchdogProbeCases.hanging_request);
    expect(result.stdout).toContain("local request started");
    expect(result.status).toBe("timed_out");
    expect(result.processExitObserved).toBe(true);
    expect(result.signals[0]).toMatchObject({ signal: "SIGTERM", sent: true });
    expect(result.responseStatus).toBe("unknown");
    expect(result.remoteCancellation).toBe("not_attempted");
    expect(result.monotonicElapsedMs).toBeGreaterThanOrEqual(490);
    expect(result.monotonicElapsedMs).toBeLessThan(5_000);
  });

  it("escalates when the child event loop cannot handle SIGTERM", async () => {
    const result = await child(watchdogProbeCases.blocked_event_loop);
    expect(result.stdout).toContain("event loop blocked");
    expect(result.status).toBe("timed_out");
    expect(result.signal).toBe("SIGKILL");
    expect(result.processExitObserved).toBe(true);
    expect(result.signals.map(({ signal }) => signal)).toEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(result.monotonicElapsedMs).toBeGreaterThanOrEqual(565);
    expect(result.monotonicElapsedMs).toBeLessThan(5_000);
  });

  it("labels a nonzero child exit as failed", async () => {
    const result = await child(
      'process.stderr.write("failure"); process.exitCode = 7;',
    );
    expect(result.status).toBe("failed");
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toBe("failure");
  });

  it("bounds the combined retained stdout and stderr while draining both", async () => {
    const result = await child(
      'process.stdout.write("x".repeat(100000)); process.stderr.write("y".repeat(100000));',
      { maxOutputBytes: 1024 },
    );
    expect(result.status).toBe("completed");
    expect(result.stdoutBytes).toBe(100_000);
    expect(result.stderrBytes).toBe(100_000);
    expect(result.stdoutCapturedBytes + result.stderrCapturedBytes).toBe(1024);
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBe(1024);
    expect(result.outputTruncated).toBe(true);
  });

  it("reports missing commands without retaining environment or arguments", async () => {
    const result = await runWithWatchdog({
      command: "/flowblock/nonexistent-watchdog-test-command",
      args: ["private-argument"],
      env: { NODE_ENV: "test", TEST_PRIVATE: "private-value" },
      timeoutMs: 500,
    });
    expect(result.status).toBe("spawn_failed");
    expect(result.errorCode).toBe("ENOENT");
    expect(result.responseStatus).toBe("unknown");
    expect(JSON.stringify(result)).not.toContain("private-argument");
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("rejects invalid budgets before launching a process", () => {
    for (const timeoutMs of [0, -1, NaN, Infinity, 0.5])
      expect(() =>
        runWithWatchdog({ command: process.execPath, timeoutMs }),
      ).toThrow(RangeError);
  });
});
