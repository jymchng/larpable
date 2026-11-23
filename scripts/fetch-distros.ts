/**
 * Fetch the Linux userland images that unkernel's kernel boots.
 *
 * The kernel ships inside the `unkernel` npm package; the distribution image does
 * not. It is downloaded from the GitHub release **of the installed unkernel
 * version** and verified against that release's `distros.json` (size + SHA-256), so
 * a kernel and a userland can never be mismatched.
 *
 *   bun run fetch:distros              # debian, the image the app boots
 *   LARPABLE_DISTROS=alpine bun run fetch:distros   # any other image the release ships
 *
 * Images land in `public/distros/`, which is git-ignored: they are build inputs,
 * not source. Serving them from the app's own origin is what keeps them working
 * under `Cross-Origin-Embedder-Policy: require-corp`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_DISTRO_NAME } from "../src/env/distro.ts";
import { downloadFile, fetchJson, formatBytes } from "./lib/download.ts";

interface DistroEntry {
  name: string;
  file: string;
  size: number;
  sha256: string;
  image: string;
}

interface DistroManifest {
  abi: number;
  base: string;
  distros: DistroEntry[];
}

const root = resolve(import.meta.dirname, "..");
const outDir = resolve(root, "public/distros");

function log(message: string): void {
  console.log(`[fetch:distros] ${message}`);
}

function installedUnkernel(): string {
  const path = resolve(root, "node_modules/unkernel/package.json");
  const pkg = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as { version: string };
  return pkg.version;
}

async function main(): Promise<void> {
  const version = installedUnkernel();
  const tag = `v${version}`;
  const base = `https://github.com/pithings/unkernel/releases/download/${tag}`;
  // The default must be the image the app boots (`DEFAULT_DISTRO_NAME`), because this
  // script also writes the manifest the app reads: fetching anything else leaves a
  // manifest with no entry for the image in `DEFAULT_DISTRO_URL`, and `prebuild` on a
  // deploy would then ship a site that offers to boot a file it does not have.
  const wanted = (process.env.LARPABLE_DISTROS ?? DEFAULT_DISTRO_NAME)
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  log(`unkernel ${version} -> ${base}`);

  const manifest = await fetchJson<DistroManifest>(`${base}/distros.json`);
  const selected = manifest.distros.filter((entry) => wanted.includes(entry.name));

  const missing = wanted.filter((name) => !selected.some((entry) => entry.name === name));
  if (missing.length > 0) {
    throw new Error(
      `the ${tag} release has no image for: ${missing.join(", ")} (available: ${manifest.distros
        .map((entry) => entry.name)
        .join(", ")})`,
    );
  }

  mkdirSync(outDir, { recursive: true });

  const served: DistroManifest = { abi: manifest.abi, base: manifest.base, distros: [] };

  for (const entry of selected) {
    const result = await downloadFile({
      url: `${base}/${entry.file}`,
      destination: resolve(outDir, entry.file),
      expectedSize: entry.size,
      expectedSha256: entry.sha256,
      log,
    });
    log(
      `${entry.name.padEnd(7)} ${entry.image} ${formatBytes(result.bytes)} sha256 verified`,
    );
    served.distros.push(entry);
  }

  // The app reads this file with HEAD probes, so it must list exactly what is on
  // disk — never an image that was filtered out or failed to download.
  writeFileSync(resolve(outDir, "distros.json"), `${JSON.stringify(served, null, 2)}\n`);
  log(`manifest public/distros/distros.json (${served.distros.length} image(s))`);
}

await main().catch((error: unknown) => {
  console.error(`[fetch:distros] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
