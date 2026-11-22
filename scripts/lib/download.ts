/**
 * Download helpers shared by the two fetch scripts.
 *
 * No third-party dependencies: Node's built-in `fetch`, `crypto` and `tar` are
 * enough, and a supply-chain-free downloader is the point of pinning a kernel.
 */

import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadOptions {
  url: string;
  destination: string;
  /** Expected byte length, when the source publishes one. */
  expectedSize?: number;
  /** Expected SHA-256 (hex), when the source publishes one. */
  expectedSha256?: string;
  log?: (message: string) => void;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  downloaded: boolean;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Download `url` to `destination`, atomically (a `.part` file is renamed into
 * place), verifying size and hash when the source publishes them. An existing,
 * verified file is reused, so re-running a script is free.
 */
export async function downloadFile({
  url,
  destination,
  expectedSize,
  expectedSha256,
  log = () => {},
}: DownloadOptions): Promise<DownloadResult> {
  mkdirSync(dirname(destination), { recursive: true });

  if (existsSync(destination)) {
    const bytes = statSync(destination).size;
    const sizeMatches = expectedSize === undefined || bytes === expectedSize;
    const sha = await sha256File(destination);
    const hashMatches = expectedSha256 === undefined || sha === expectedSha256;
    if (sizeMatches && hashMatches) {
      log(`cached   ${destination} (${bytes} bytes, sha256 verified)`);
      return { path: destination, bytes, sha256: sha, downloaded: false };
    }
    log(`stale    ${destination} (${bytes} bytes) — downloading again`);
    rmSync(destination, { force: true });
  }

  log(`download ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }

  const part = `${destination}.part`;
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(part));

  const bytes = statSync(part).size;
  if (expectedSize !== undefined && bytes !== expectedSize) {
    rmSync(part, { force: true });
    throw new Error(`${url}: expected ${expectedSize} bytes, received ${bytes}`);
  }

  const sha256 = await sha256File(part);
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
    rmSync(part, { force: true });
    throw new Error(`${url}: sha256 mismatch (expected ${expectedSha256}, got ${sha256})`);
  }

  renameSync(part, destination);
  log(`saved    ${destination} (${bytes} bytes)`);
  return { path: destination, bytes, sha256, downloaded: true };
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { redirect: "follow", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  return (await response.json()) as T;
}

export function makeExecutable(path: string): void {
  chmodSync(path, 0o755);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
