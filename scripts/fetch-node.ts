/**
 * Provision a Node >= 24 binary into `.tooling/node`.
 *
 * unkernel's Node entry requires Node 24: it uses WebAssembly JSPI, which V8 only
 * exposes by default from that release on. The host may have an older Node (this
 * repository was scaffolded on 21), so the version the probes need is downloaded
 * and pinned here instead of assumed.
 *
 *   bun run fetch:node
 *   LARPABLE_NODE_VERSION=v24.22.3 bun run fetch:node
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { downloadFile, fetchJson, formatBytes } from "./lib/download.ts";

interface NodeRelease {
  version: string;
  lts: string | false;
  files: string[];
}

const root = resolve(import.meta.dirname, "..");
const tooling = resolve(root, ".tooling");
const nodeDir = resolve(tooling, "node");
const downloads = resolve(tooling, "downloads");
const nodeBin = resolve(nodeDir, "bin/node");

function log(message: string): void {
  console.log(`[fetch:node] ${message}`);
}

async function resolveVersion(): Promise<string> {
  const pinned = process.env.LARPABLE_NODE_VERSION?.trim();
  if (pinned) return pinned;

  const releases = await fetchJson<NodeRelease[]>("https://nodejs.org/dist/index.json");
  const latest = releases.find((release) => release.version.startsWith("v24."));
  if (!latest) throw new Error("nodejs.org/dist/index.json has no v24 release");
  return latest.version;
}

async function expectedSha256(version: string, file: string): Promise<string | undefined> {
  // The official checksum file is the source of truth; without it the download is
  // not verified and the script says so rather than pretending.
  const response = await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`);
  if (!response.ok) return undefined;
  const line = (await response.text())
    .split("\n")
    .map((entry) => entry.trim().split(/\s+/))
    .find(([, name]) => name === file);
  return line?.[0];
}

async function main(): Promise<void> {
  const version = await resolveVersion();
  const arch = process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  const file = `node-${version}-${arch}.tar.xz`;
  const url = `https://nodejs.org/dist/${version}/${file}`;

  log(`target node ${version} (${arch})`);
  const sha = await expectedSha256(version, file);

  const archive = await downloadFile({
    url,
    destination: resolve(downloads, file),
    expectedSha256: sha,
    log,
  });
  log(`archive ${formatBytes(archive.bytes)}${sha ? " (sha256 verified)" : " (no checksum published)"}`);

  mkdirSync(nodeDir, { recursive: true });
  if (!existsSync(nodeBin)) {
    log(`extract  ${file} -> .tooling/node`);
    const tar = spawnSync("tar", ["-xJf", archive.path, "-C", nodeDir, "--strip-components=1"], {
      stdio: "inherit",
    });
    if (tar.status !== 0) throw new Error(`tar failed with status ${tar.status}`);
  } else {
    log("extract  already extracted");
  }

  const probe = spawnSync(
    nodeBin,
    ["-e", "console.log(process.version, typeof WebAssembly.Suspending)"],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) throw new Error(`downloaded node failed to run: ${probe.stderr}`);

  const [reported, jspi] = probe.stdout.trim().split(" ");
  writeFileSync(resolve(nodeDir, "VERSION"), `${version}\n`);

  log(`verified ${reported}, WebAssembly.Suspending: ${jspi}`);
  if (jspi !== "function") throw new Error("downloaded Node has no JSPI; unkernel cannot boot under it");
  log("ready    bun run feasibility");
}

await main().catch((error: unknown) => {
  console.error(`[fetch:node] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
