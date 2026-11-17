import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
vi.mock("@/auth", () => ({ auth: vi.fn() }));
import { auth } from "@/auth";
import { HttpError, jsonBody, owner, sameOrigin } from "../src/server/security";
import {
  byteRange,
  mediaResponse,
  objectSize,
  saveLocalUpload,
  signedUpload,
  validateMediaKey,
} from "../src/server/storage";
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "flowblock-api-storage-"));
  vi.stubEnv("FLOWBLOCK_LOCAL_MODE", "1");
  vi.stubEnv("FLOWBLOCK_STORAGE_DIR", directory);
  vi.stubEnv("S3_BUCKET", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});
const upload = (body: string) =>
  new Request("http://localhost:3037/api/upload", { method: "PUT", body });

describe("private media storage", () => {
  it("keeps local uploads on the browser origin when the server uses another loopback hostname", async () => {
    const takeId = "eeb002a6-e026-467c-98c3-f80ce11bcc38";
    const uploadUrl = await signedUpload(
      `owners/local-developer/takes/${takeId}/original`,
      "video/mp4",
      10,
      takeId,
    );
    for (const browserUrl of [
      "http://127.0.0.1:3051/review",
      "http://localhost:3037/review",
      "http://[::1]:3037/review",
    ]) {
      const resolved = new URL(uploadUrl, browserUrl);
      expect(resolved.origin).toBe(new URL(browserUrl).origin);
      expect(resolved.pathname).toBe(`/api/takes/${takeId}/upload`);
    }
  });
  it("retains an absolute signed S3 upload URL when a bucket is configured", async () => {
    vi.stubEnv("S3_BUCKET", "flowblock-test");
    vi.stubEnv("S3_ENDPOINT", "https://storage.example.test");
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "test-access-key");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "test-secret-key");
    vi.stubEnv("AWS_SESSION_TOKEN", "");
    vi.stubEnv("AWS_PROFILE", "");
    const uploadUrl = await signedUpload(
      "owners/test/takes/test-take/original",
      "video/mp4",
      10,
      "test-take",
    );
    const resolved = new URL(uploadUrl, "http://127.0.0.1:3051/review");
    expect(resolved.origin).toBe("https://flowblock-test.storage.example.test");
    expect(resolved.pathname).toBe("/owners/test/takes/test-take/original");
    expect(resolved.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(resolved.searchParams.get("X-Amz-Signature")).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });
  it("serves bounded, open-ended and suffix ranges without exposing other bytes", async () => {
    await writeFile(path.join(directory, "video"), "0123456789");
    for (const [range, expected, contentRange] of [
      ["bytes=2-4", "234", "bytes 2-4/10"],
      ["bytes=8-", "89", "bytes 8-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
    ]) {
      const response = await mediaResponse(
        "video",
        "video/mp4",
        new Request("http://localhost:3037/video", { headers: { range } }),
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe(contentRange);
      expect(await response.text()).toBe(expected);
    }
  });
  it("returns416 for unsatisfiable or multipart ranges and streams full content otherwise", async () => {
    await writeFile(path.join(directory, "video"), "0123456789");
    const response = await mediaResponse(
      "video",
      "video/mp4",
      new Request("http://localhost:3037/video", {
        headers: { range: "bytes=30-40" },
      }),
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
    expect(byteRange("bytes=0-2,5-6", 10)).toBe("invalid");
    expect(byteRange("bytes=-0", 10)).toBe("invalid");
    const full = await mediaResponse("video", "video/mp4");
    expect(full.headers.get("Content-Length")).toBe("10");
    expect(await full.text()).toBe("0123456789");
  });
  it("answers HEAD without sending media bytes", async () => {
    await writeFile(path.join(directory, "video"), "0123456789");
    const response = await mediaResponse(
      "video",
      "video/mp4",
      new Request("http://localhost:3037/video", { method: "HEAD" }),
    );
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(await response.text()).toBe("");
  });
  it("rejects traversal, URLs and symlink escapes", async () => {
    for (const key of [
      "../secret",
      "a/../secret",
      "https://example.org/video",
      "a//b",
      "/etc/passwd",
    ])
      expect(() => validateMediaKey(key)).toThrow();
    await symlink(tmpdir(), path.join(directory, "escape"));
    await expect(objectSize("escape/secret")).rejects.toThrow(
      "escapes private storage",
    );
  });
  it("removes incomplete uploads and rejected publication without creating an original", async () => {
    await expect(
      saveLocalUpload("original", upload("short"), 10, async (commit) =>
        commit(),
      ),
    ).rejects.toThrow("incomplete");
    await expect(
      saveLocalUpload("original", upload("0123456789"), 10, async () => {
        throw new HttpError(410, "deleted");
      }),
    ).rejects.toThrow("deleted");
    expect(await readdir(directory)).toEqual([]);
  });
  it("keeps an accepted upload unchanged when a concurrent attempt is rejected", async () => {
    await saveLocalUpload("original", upload("first"), 5, async (commit) =>
      commit(),
    );
    await expect(
      saveLocalUpload("original", upload("other"), 5, async () => {
        throw new HttpError(409, "completed");
      }),
    ).rejects.toThrow();
    expect(await readFile(path.join(directory, "original"), "utf8")).toBe(
      "first",
    );
    expect(await readdir(directory)).toEqual(["original"]);
  });
});

describe("request boundary", () => {
  it("blocks cross-site local reads and foreign-origin writes", () => {
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3037/api/projects", {
          headers: { "sec-fetch-site": "cross-site" },
        }),
      ),
    ).toThrow();
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3037/api/projects", {
          method: "POST",
          headers: { origin: "https://attacker.example" },
        }),
      ),
    ).toThrow();
  });
  it("requires the actual JSON media type", async () => {
    await expect(
      jsonBody(
        new Request("http://localhost:3037/api", {
          method: "POST",
          headers: { "content-type": "text/plain; application/json" },
          body: "{}",
        }),
      ),
    ).rejects.toThrow();
    expect(
      await jsonBody(
        new Request("http://localhost:3037/api", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: '{"ok":true}',
        }),
      ),
    ).toEqual({ ok: true });
  });
  it("hashes provider identity into a path-safe stable owner", async () => {
    vi.stubEnv("FLOWBLOCK_LOCAL_MODE", "0");
    vi.mocked(auth).mockResolvedValue({ user: { id: "google:123" } } as never);
    const id = await owner(
      new Request("https://flowblock.example/api/projects"),
    );
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(id).not.toContain("123");
  });
});
