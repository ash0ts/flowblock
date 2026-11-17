import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWithWatchdog } from "./watchdog";

export const watchdogProbeCases = {
  normal: 'process.stdout.write(JSON.stringify({ status: "ok" }) + "\\n");',
  hanging_request: `
    const http = require("node:http");
    const server = http.createServer(() => {});
    server.listen(0, "127.0.0.1", () => {
      const request = http.get("http://127.0.0.1:" + server.address().port);
      request.on("error", () => {});
      require("node:fs").writeSync(1, "local request started\\n");
    });
  `,
  blocked_event_loop: `
    process.on("SIGTERM", () => {});
    require("node:fs").writeSync(1, "event loop blocked\\n");
    while (true) {}
  `,
} as const;

export async function runWatchdogProbe(timeoutMs = 750) {
  const cases = [];
  for (const [name, source] of Object.entries(watchdogProbeCases)) {
    const result = await runWithWatchdog({
      command: process.execPath,
      args: ["-e", source],
      // Fault children need no provider credentials or inherited Node options.
      env: { NODE_ENV: "test" },
      timeoutMs,
      killGraceMs: 100,
      maxOutputBytes: 4096,
    });
    const expectedStatus = name === "normal" ? "completed" : "timed_out";
    const passed =
      result.status === expectedStatus &&
      result.processExitObserved &&
      (name !== "blocked_event_loop" || result.signal === "SIGKILL");
    cases.push({ name, expectedStatus, passed, result });
  }
  return {
    schemaVersion: 1,
    experiment: "local-external-process-watchdog-faults",
    createdAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    paidRequests: 0,
    externalRequests: 0,
    passed: cases.every((item) => item.passed),
    cases,
    limitations: [
      "The parent process timer remains independent of a blocked child event loop.",
      "Host suspension or parent event-loop starvation can delay timeout and escalation; these observations do not prove an absolute wall-clock bound.",
      "Process termination does not confirm remote request cancellation or response availability. Timed-out requests retain unknown response status.",
      "POSIX signals target the child process group. Windows signals target only the direct child.",
    ],
  };
}

async function main() {
  const output = process.argv[2];
  if (!output)
    throw new Error("Provide a new receipt path as the first argument");
  const receipt = await runWatchdogProbe();
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      ["watchdog.ts", "watchdog-probe.ts"].map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(new URL(name, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(
    output,
    JSON.stringify({ ...receipt, sourceHashes }, null, 2) + "\n",
    {
      flag: "wx",
    },
  );
  console.log(JSON.stringify({ output, passed: receipt.passed }));
  if (!receipt.passed) process.exitCode = 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
