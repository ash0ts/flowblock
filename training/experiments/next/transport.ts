import {
  Agent,
  Dispatcher,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

export const transportVersion = "flowblock-experiment-transport-v2";
export const transportSettings = {
  undiciVersion: "7.28.0",
  connectTimeoutMs: 55_000,
  warmupTimeoutMs: 60_000,
  connections: 1,
  keepAliveTimeoutMs: 60_000,
  keepAliveMaxTimeoutMs: 120_000,
  warmupMethod: "GET",
  authenticatedWarmup: false,
} as const;
let installed = false;

class ScopedDispatcher extends Dispatcher {
  constructor(
    readonly base: URL,
    readonly inference: Agent,
    readonly previous: Dispatcher,
  ) {
    super();
  }
  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const request = new URL(options.path, String(options.origin));
    const prefix = this.base.pathname.replace(/\/$/, "");
    const matches =
      request.origin === this.base.origin &&
      (request.pathname === prefix ||
        request.pathname.startsWith(`${prefix}/`));
    return (matches ? this.inference : this.previous).dispatch(
      options,
      handler,
    );
  }
}
export type WarmupAttempt = {
  index: number;
  status: "http-response" | "failed";
  httpStatus: number | null;
  elapsedMs: number;
  reusableHint: boolean;
  bodyBytes?: number;
  errorName?: string;
  errorCode?: string;
};
export type WarmupReceipt = {
  transportVersion: typeof transportVersion;
  startedAt: string;
  elapsedMs: number;
  ready: boolean;
  method: "GET";
  authenticated: false;
  catalogUrl: string;
  settings: typeof transportSettings;
  attempts: WarmupAttempt[];
  connectionsOpened: number;
  disclosure: string;
};

/** Installs only in this research process; unrelated Forge/Weave paths keep their prior dispatcher. */
export function installExperimentTransport(
  baseUrl: string,
  testOptions: { connectTimeoutMs?: number; warmupTimeoutMs?: number } = {},
) {
  if (installed)
    throw new Error(
      "An experiment transport is already installed in this process.",
    );
  const base = new URL(baseUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
      ))
  )
    throw new Error(
      "Transport requires a credential-free HTTPS API base, or loopback HTTP for tests.",
    );
  const connectTimeout =
    testOptions.connectTimeoutMs ?? transportSettings.connectTimeoutMs;
  const warmupTimeout =
    testOptions.warmupTimeoutMs ?? transportSettings.warmupTimeoutMs;
  if (
    !Number.isInteger(connectTimeout) ||
    connectTimeout < 1 ||
    connectTimeout > 55_000 ||
    !Number.isInteger(warmupTimeout) ||
    warmupTimeout < 1 ||
    warmupTimeout > 60_000
  )
    throw new Error("Experiment transport timeouts exceed their fixed limits.");
  const previous = getGlobalDispatcher();
  const agent = new Agent({
    connections: 1,
    pipelining: 1,
    connect: { timeout: connectTimeout },
    keepAliveTimeout: transportSettings.keepAliveTimeoutMs,
    keepAliveMaxTimeout: transportSettings.keepAliveMaxTimeoutMs,
  });
  let connectionsOpened = 0;
  agent.on("connect", () => {
    connectionsOpened++;
  });
  const scoped = new ScopedDispatcher(base, agent, previous);
  setGlobalDispatcher(scoped);
  installed = true;
  const catalogUrl = `${baseUrl.replace(/\/$/, "")}/models`;
  let closed = false;
  return {
    get connectionsOpened() {
      return connectionsOpened;
    },
    async warmup(): Promise<WarmupReceipt> {
      if (closed) throw new Error("The experiment transport is closed.");
      const started = Date.now(),
        startedAt = new Date().toISOString();
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Transport warmup deadline reached")),
        warmupTimeout,
      );
      const attempts = await Promise.all(
        [0].map(async (index): Promise<WarmupAttempt> => {
          const requestStarted = Date.now();
          try {
            const response = await fetch(catalogUrl, {
              method: "GET",
              redirect: "manual",
              signal: controller.signal,
            });
            const bodyBytes = (await response.arrayBuffer()).byteLength;
            return {
              index,
              status: "http-response",
              httpStatus: response.status,
              elapsedMs: Date.now() - requestStarted,
              reusableHint: !response.headers
                .get("connection")
                ?.toLowerCase()
                .includes("close"),
              bodyBytes,
            };
          } catch (error) {
            const cause =
              error instanceof Error
                ? (error as Error & { cause?: { code?: string } }).cause
                : undefined;
            return {
              index,
              status: "failed",
              httpStatus: null,
              elapsedMs: Date.now() - requestStarted,
              reusableHint: false,
              errorName: error instanceof Error ? error.name : "Error",
              ...(typeof cause?.code === "string"
                ? { errorCode: cause.code }
                : {}),
            };
          }
        }),
      );
      clearTimeout(timer);
      return {
        transportVersion,
        startedAt,
        elapsedMs: Date.now() - started,
        ready: attempts.every(
          (attempt) =>
            attempt.status === "http-response" && attempt.reusableHint,
        ),
        method: "GET",
        authenticated: false,
        catalogUrl,
        settings: transportSettings,
        attempts,
        connectionsOpened,
        disclosure:
          "Read-only unauthenticated catalog requests warm the same inference path dispatcher before task timing. Any HTTP status establishes a response, not authentication or model availability. Keep-alive hints do not guarantee future socket reuse. No inference POST is issued or retried by warmup.",
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      if (getGlobalDispatcher() === scoped) setGlobalDispatcher(previous);
      installed = false;
      await agent.destroy();
    },
  };
}
