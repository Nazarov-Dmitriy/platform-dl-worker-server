import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
const DEFAULT_BACKOFF = [0, 5_000, 15_000, 45_000];
export type Link = {
  path: string;
  objectName: string;
  url: string;
  expiresAt: string;
  method: "GET" | "PUT";
  headers: Record<string, string>;
};
export class TransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly refresh = false,
    readonly permanent = false,
  ) {
    super(message);
  }
}
export async function downloadLink(
  link: Link,
  dest: string,
  expectedBytes?: number,
  expectedSha?: string,
  backoff = DEFAULT_BACKOFF,
  now = () => Date.now(),
  signal?: AbortSignal,
  onProgress?: (bytes: number) => void,
) {
  if (link.method !== "GET")
    throw new TransferError("INVALID_GRANT", "GET required", false, true);
  await withRetries(
    link,
    "GET",
    backoff,
    now,
    async (current) => {
      const res = await fetch(current.url, {
        method: "GET",
        headers: safeHeaders(current.headers),
        redirect: "error",
        signal,
      });
      if (res.status === 401 || res.status === 403)
        throw new TransferError(
          "SOURCE_URL_EXPIRED",
          "Grant URL was rejected",
          true,
        );
      if (!res.ok || !res.body)
        throw new TransferError(
          "SOURCE_DOWNLOAD_FAILED",
          "Source download failed: " + res.status,
        );
      const out = createWriteStream(dest);
      let received = 0;
      const limit = new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (expectedBytes !== undefined && received > expectedBytes)
            return callback(
              new TransferError(
                "SOURCE_SIZE_MISMATCH",
                "Source exceeds declared size",
                false,
                true,
              ),
            );
          onProgress?.(received);
          callback(null, chunk);
        },
      });
      await pipeline(res.body as any, limit, out, { signal });
    },
    signal,
  );
  const file = await stat(dest);
  if (expectedBytes != null && file.size !== expectedBytes)
    throw new TransferError(
      "SOURCE_SIZE_MISMATCH",
      "Downloaded size does not match",
      false,
      true,
    );
  if (expectedSha && (await sha256File(dest)) !== expectedSha)
    throw new TransferError(
      "SOURCE_HASH_MISMATCH",
      "Downloaded hash does not match",
      false,
      true,
    );
}
export async function uploadLink(
  link: Link,
  file: string,
  backoff = DEFAULT_BACKOFF,
  now = () => Date.now(),
  signal?: AbortSignal,
) {
  if (link.method !== "PUT")
    throw new TransferError("INVALID_GRANT", "PUT required", false, true);
  const size = (await stat(file)).size;
  await withRetries(
    link,
    "PUT",
    backoff,
    now,
    async (current) => {
      const stream = createReadStream(file);
      try {
        const res = await fetch(current.url, {
          method: "PUT",
          headers: {
            ...safeHeaders(current.headers),
            "Content-Length": String(size),
          },
          body: stream,
          duplex: "half",
          redirect: "error",
          signal,
        } as any);
        await res.body?.cancel();
        if (res.status === 401 || res.status === 403)
          throw new TransferError(
            "UPLOAD_URL_EXPIRED",
            "Grant URL was rejected",
            true,
          );
        if (!res.ok)
          throw new TransferError(
            "UPLOAD_FAILED",
            "Upload failed: " + res.status,
          );
      } finally {
        stream.destroy();
      }
    },
    signal,
  );
}
async function withRetries(
  link: Link,
  _method: string,
  backoff: number[],
  now: () => number,
  run: (link: Link) => Promise<void>,
  signal?: AbortSignal,
) {
  let last: unknown;
  for (let i = 0; i < backoff.length; i++) {
    signal?.throwIfAborted();
    if (backoff[i]) await delay(backoff[i], undefined, { signal });
    if (Date.parse(link.expiresAt) <= now())
      throw new TransferError("SOURCE_URL_EXPIRED", "Grant URL expired", true);
    try {
      await run(link);
      return;
    } catch (e) {
      signal?.throwIfAborted();
      last = e;
      if (e instanceof TransferError && (e.refresh || e.permanent)) throw e;
    }
  }
  throw last instanceof TransferError
    ? last
    : new TransferError("TRANSFER_FAILED", String(last));
}
function safeHeaders(headers: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const n = k.toLowerCase();
    if (
      ["authorization", "cookie", "set-cookie", "proxy-authorization"].includes(
        n,
      )
    )
      continue;
    out[k] = v;
  }
  return out;
}
export async function sha256File(path: string) {
  const hash = createHash("sha256");
  const file = await open(path, "r");
  try {
    const stream = file.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}
