import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { getGlobalDispatcher } from "undici";
import { installExperimentTransport } from "../training/experiments/next/transport";
const servers: Server[] = [];
let transport: ReturnType<typeof installExperimentTransport> | undefined;
afterEach(async () => {
  await transport?.close();
  transport = undefined;
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
async function server(handler: RequestListener) {
  const instance = createServer(handler);
  servers.push(instance);
  await new Promise<void>((resolve) =>
    instance.listen(0, "127.0.0.1", resolve),
  );
  return {
    instance,
    origin: `http://127.0.0.1:${(instance.address() as AddressInfo).port}`,
  };
}

describe("experiment-only connection warmup", () => {
  it("warms one unauthenticated connection and reuses it for the same inference path", async () => {
    const requests: {
      method: string;
      auth: string | undefined;
      port: number | undefined;
      path: string;
    }[] = [];
    const { origin } = await server((request, response) => {
      requests.push({
        method: request.method!,
        auth: request.headers.authorization,
        port: request.socket.remotePort,
        path: request.url!,
      });
      setTimeout(() => {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end('{"error":"unauthorized"}');
      }, 10);
    });
    const previous = getGlobalDispatcher();
    transport = installExperimentTransport(`${origin}/v1`);
    const warmed = await transport.warmup();
    expect(warmed.ready).toBe(true);
    expect(warmed.attempts.map((attempt) => attempt.httpStatus)).toEqual([401]);
    expect(warmed.connectionsOpened).toBe(1);
    const response = await fetch(`${origin}/v1/models`);
    await response.arrayBuffer();
    expect(transport.connectionsOpened).toBe(1);
    expect(new Set(requests.map((request) => request.port)).size).toBe(1);
    expect(
      requests.every(
        (request) =>
          request.method === "GET" &&
          !request.auth &&
          request.path === "/v1/models",
      ),
    ).toBe(true);
    await transport.close();
    expect(getGlobalDispatcher()).toBe(previous);
  });
  it("does not route other paths on the same host into the inference pool", async () => {
    const { origin } = await server((_request, response) => response.end("ok"));
    transport = installExperimentTransport(`${origin}/api/training/v1`);
    const unrelated = await fetch(`${origin}/api/trace/health`);
    await unrelated.arrayBuffer();
    expect(transport.connectionsOpened).toBe(0);
    await transport.warmup();
    expect(transport.connectionsOpened).toBeGreaterThan(0);
  });
  it("bounds stalled read-only requests and restores the prior dispatcher", async () => {
    const { origin } = await server(() => {});
    transport = installExperimentTransport(`${origin}/v1`, {
      warmupTimeoutMs: 30,
    });
    const warmed = await transport.warmup();
    expect(warmed.ready).toBe(false);
    expect(
      warmed.attempts.every((attempt) => attempt.status === "failed"),
    ).toBe(true);
    expect(warmed.elapsedMs).toBeLessThan(1000);
  });
  it("does not call a connection closed by the server reusable", async () => {
    const { origin } = await server((_request, response) => {
      response.writeHead(401, { Connection: "close" });
      response.end("closed");
    });
    transport = installExperimentTransport(`${origin}/v1`);
    expect((await transport.warmup()).ready).toBe(false);
  });
});
