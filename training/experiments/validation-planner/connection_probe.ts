import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  installExperimentTransport,
  transportSettings,
} from "../next/transport";
import { runWithWatchdog } from "./watchdog";

const version = "flowblock-unauthenticated-connection-probe-v1";
const modes = ["default", "extended", "extended", "default"] as const;
type Mode = (typeof modes)[number];

function checkedBase(raw: string) {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Probe requires a credential-free HTTPS API base.");
  return url.href.replace(/\/$/, "");
}
function errorChain(error: unknown): Array<Record<string, string | number>> {
  const seen = new Set<unknown>();
  const chain: Array<Record<string, string | number>> = [];
  let current = error;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    chain.length < 8
  ) {
    seen.add(current);
    const row: Record<string, string | number> = {};
    for (const key of ["name", "code", "errno", "syscall"] as const) {
      const value = (current as Record<string, unknown>)[key];
      if (typeof value === "string" || typeof value === "number")
        row[key] = value;
    }
    chain.push(row);
    current = "cause" in current ? current.cause : undefined;
  }
  return chain;
}
async function worker(mode: Mode, rawBase: string) {
  const base = checkedBase(rawBase);
  const transport =
    mode === "extended" ? installExperimentTransport(base) : undefined;
  const emit = (value: unknown) =>
    process.stdout.write(JSON.stringify(value) + "\n");
  emit({
    version,
    event: "worker-start",
    mode,
    authenticated: false,
    method: "GET",
    url: `${base}/models`,
    node: process.version,
  });
  try {
    for (let request = 0; request < 2; request++) {
      const started = performance.now(),
        wall = Date.now();
      emit({
        event: "request-start",
        request,
        startedAt: new Date(wall).toISOString(),
      });
      try {
        const response = await fetch(`${base}/models`, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
        });
        const body = await response.arrayBuffer();
        emit({
          event: "request-result",
          request,
          status: "http-response",
          httpStatus: response.status,
          monotonicElapsedMs: performance.now() - started,
          wallElapsedMs: Date.now() - wall,
          bytes: body.byteLength,
          connectionHeader: response.headers.get("connection"),
          connectionsOpened: transport?.connectionsOpened ?? null,
        });
      } catch (error) {
        emit({
          event: "request-result",
          request,
          status: "failed",
          errors: errorChain(error),
          monotonicElapsedMs: performance.now() - started,
          wallElapsedMs: Date.now() - wall,
          connectionsOpened: transport?.connectionsOpened ?? null,
        });
      }
    }
  } finally {
    await transport?.close();
  }
}
async function run(output: string, rawBase: string) {
  const base = checkedBase(rawBase),
    directory = resolve(output);
  await mkdir(directory, { recursive: false });
  const paths = [
    fileURLToPath(import.meta.url),
    resolve("training/experiments/next/transport.ts"),
    resolve("training/experiments/validation-planner/watchdog.ts"),
  ];
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  );
  await writeFile(
    resolve(directory, "protocol.json"),
    JSON.stringify(
      {
        version,
        base,
        modes,
        requestsPerProcess: 2,
        externalWatchdogMs: 65_000,
        fetchSignalTimeoutMs: 60_000,
        extendedSettings: transportSettings,
        sourceHashes,
        authorization:
          "Unauthenticated GET /models only. No inference POST, credentials, model selection, task evaluation or paid retries.",
        purpose:
          "Compare cold-process transport behavior and a second sequential request in that process. HTTP responses establish connectivity only, not model readiness.",
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
  const results = [];
  for (const [index, mode] of modes.entries()) {
    const receipt = await runWithWatchdog({
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        fileURLToPath(import.meta.url),
        "--worker",
        mode,
        base,
      ],
      cwd: process.cwd(),
      timeoutMs: 65_000,
      env: {
        PATH: process.env.PATH,
        LANG: process.env.LANG,
        TMPDIR: process.env.TMPDIR,
        NODE_ENV: process.env.NODE_ENV || "production",
      },
      maxOutputBytes: 64_000,
    });
    const events = receipt.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const result = { index, mode, receipt, events };
    await writeFile(
      resolve(directory, `${index}-${mode}.json`),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx" },
    );
    results.push(result);
    process.stdout.write(
      JSON.stringify({
        index,
        mode,
        processStatus: receipt.status,
        events: events.filter((event) => event.event === "request-result"),
      }) + "\n",
    );
  }
  await writeFile(
    resolve(directory, "summary.json"),
    JSON.stringify(
      {
        version,
        recordedAt: new Date().toISOString(),
        results,
        limitations: [
          "Four process trials are a connectivity diagnostic, not an estimate of service reliability.",
          "Unauthenticated GET /models may take a different handler path from authenticated inference POST.",
          "No paid requests were issued or retried; the frozen experiment and its outcomes were not modified.",
          "Host sleep or a blocked parent can delay the external watchdog.",
        ],
      },
      null,
      2,
    ) + "\n",
    { flag: "wx" },
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [first, second, third] = process.argv.slice(2);
  if (
    first === "--worker" &&
    (second === "default" || second === "extended") &&
    third
  )
    await worker(second, third);
  else if (first && second && !third) await run(first, second);
  else
    throw new Error(
      "Usage: connection_probe.ts NEW_OUTPUT_DIRECTORY HTTPS_API_BASE",
    );
}
