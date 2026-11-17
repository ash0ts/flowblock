import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";
import { mkdir, open, stat, rename, rm, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";
import { HttpError } from "./security";

export const localStorage = () =>
  process.env.FLOWBLOCK_LOCAL_MODE === "1" && !process.env.S3_BUCKET;
// Runtime private media must never become part of Next's deployment file trace.
export const storageRoot = () =>
  path.resolve(
    /*turbopackIgnore: true*/ process.env.FLOWBLOCK_STORAGE_DIR ||
      ".data/media",
  );
export function validateMediaKey(key: string): string {
  const clean = key.endsWith("/") ? key.slice(0, -1) : key;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,1023}$/.test(clean) ||
    clean.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new HttpError(400, "Invalid media key.");
  return clean;
}
async function localPath(key: string) {
  const clean = validateMediaKey(key);
  await mkdir(storageRoot(), { recursive: true });
  const root = await realpath(/*turbopackIgnore: true*/ storageRoot()),
    target = path.resolve(root, clean);
  if (!target.startsWith(root + path.sep))
    throw new HttpError(400, "Invalid media key.");
  let ancestor = target;
  while (ancestor !== root) {
    try {
      const resolved = await realpath(ancestor);
      if (!resolved.startsWith(root + path.sep))
        throw new HttpError(400, "Media path escapes private storage.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return target;
}
function s3() {
  return new S3Client({
    region: process.env.AWS_REGION || "US",
    endpoint: process.env.S3_ENDPOINT || "https://cwobject.com",
    forcePathStyle: false,
  });
}
function bucket() {
  if (!process.env.S3_BUCKET)
    throw new HttpError(503, "Object storage is not configured.");
  return process.env.S3_BUCKET;
}
export async function signedUpload(
  key: string,
  type: string,
  size: number,
  takeId: string,
) {
  validateMediaKey(key);
  if (localStorage()) return `/api/takes/${takeId}/upload`;
  return getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      ContentType: type,
      ContentLength: size,
      IfNoneMatch: "*",
    }),
    { expiresIn: 900 },
  );
}
export async function saveLocalUpload(
  key: string,
  request: Request,
  expectedSize: number,
  publish: (commit: () => Promise<void>) => Promise<void>,
) {
  const target = await localPath(key);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.partial`;
  const file = await open(temporary, "wx", 0o600),
    reader = request.body?.getReader();
  let size = 0;
  try {
    if (!reader) throw new HttpError(400, "Missing video body.");
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > expectedSize || size > 104857600)
        throw new HttpError(413, "Upload exceeds the declared size.");
      await file.writeFile(item.value);
    }
    if (size !== expectedSize)
      throw new HttpError(400, "Upload is incomplete.");
    await file.close();
    // Caller holds the take row lock while checking deletion/status and publishing.
    await publish(async () => {
      await rename(temporary, target);
    });
  } catch (error) {
    await reader?.cancel().catch(() => {});
    await file.close().catch(() => {});
    throw error;
  } finally {
    reader?.releaseLock();
    await rm(temporary, { force: true });
  }
}
export async function objectSize(key: string) {
  validateMediaKey(key);
  if (localStorage()) return (await stat(await localPath(key))).size;
  return (
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }))
  ).ContentLength;
}
export function byteRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2]) || size <= 0) return "invalid";
  const first = match[1] ? Number(match[1]) : undefined,
    last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return "invalid";
  if (first === undefined) {
    if (!last || last <= 0) return "invalid";
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && last < first)) return "invalid";
  return { start: first, end: Math.min(last ?? size - 1, size - 1) };
}
export async function mediaResponse(
  key: string,
  type: string,
  request?: Request,
) {
  validateMediaKey(key);
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (!localStorage()) {
    const command =
      request?.method === "HEAD"
        ? new HeadObjectCommand({ Bucket: bucket(), Key: key })
        : new GetObjectCommand({ Bucket: bucket(), Key: key });
    headers.set(
      "Location",
      await getSignedUrl(s3(), command, { expiresIn: 300 }),
    );
    return new Response(null, { status: 307, headers });
  }
  let file;
  try {
    file = await open(
      await localPath(key),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new HttpError(404, "Media is no longer available.");
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new HttpError(404, "Media is unavailable.");
    const range = byteRange(
      request?.method === "HEAD"
        ? null
        : (request?.headers.get("range") ?? null),
      metadata.size,
    );
    if (range === "invalid") {
      await file.close();
      headers.set("Content-Range", `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    const start = range?.start ?? 0,
      end = range?.end ?? metadata.size - 1;
    headers.set("Content-Length", String(Math.max(0, end - start + 1)));
    if (range)
      headers.set("Content-Range", `bytes ${start}-${end}/${metadata.size}`);
    if (request?.method === "HEAD" || metadata.size === 0) {
      await file.close();
      return new Response(null, { headers });
    }
    return new Response(
      Readable.toWeb(
        file.createReadStream({ start, end, autoClose: true }),
      ) as ReadableStream<Uint8Array>,
      { status: range ? 206 : 200, headers },
    );
  } catch (error) {
    await file.close().catch(() => {});
    throw error;
  }
}
export async function deletePrefix(prefix: string) {
  const clean = validateMediaKey(prefix);
  if (localStorage()) {
    await rm(await localPath(clean), { recursive: true, force: true });
    return;
  }
  const client = s3();
  let token: string | undefined;
  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket(),
        Prefix: clean + "/",
        ContinuationToken: token,
      }),
    );
    if (list.Contents?.length) {
      const deleted = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket(),
          Delete: { Objects: list.Contents.map((x) => ({ Key: x.Key! })) },
        }),
      );
      if (deleted.Errors?.length)
        throw new HttpError(
          503,
          "Some media could not be deleted. Cleanup will retry.",
        );
    }
    token = list.NextContinuationToken;
  } while (token);
}
