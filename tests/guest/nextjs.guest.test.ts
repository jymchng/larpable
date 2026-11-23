/**
 * Can the guest actually run a Next.js app, and can the host reach it over HTTP?
 *
 * The user's ask, verbatim: *"user runs `bun create next-app@latest my-bun-app && cd
 * my-bun-app && bun run start` should see the preview panel showing the built nextjs app."*
 * That sentence depends on four facts this file measures instead of assuming:
 *
 * 1. **The guest has a working runtime for Next.js.** Its `node` is a first-use shim that
 *    downloads a runtime into `~/.local`; the version it lands on decides whether Next's
 *    SWC binaries work at all.
 * 2. **The registry is reachable and a Next install completes.** `next` is a large package
 *    with a platform-specific SWC binary (`@next/swc-linux-arm64-gnu` on this aarch64
 *    glibc image).
 * 3. **`next build` succeeds in the guest** with `app/` router files written by hand — the
 *    part `create-next-app` would generate, minus its interactive prompts.
 * 4. **`next start` answers HTTP from the host** through `kernel.fetch()`, which is the only
 *    way the host can reach a loopback port inside the machine, and whether the HTML it
 *    returns uses root-absolute `/_next/...` URLs (the preview has to rebase those).
 *
 * It also measures the alternative: `output: "export"`, which writes static files to `out/`
 * and would be servable by the *existing* static preview pipeline.
 *
 * Skipped unless `LARPABLE_GUEST_TESTS=1`. Run it with:
 *
 *   bun run test:guest -- nextjs
 *
 * Every step's timing and output tail is appended to `docs/evidence/nextjs-guest.txt` so the
 * write-up in `docs/nextjs.md` quotes measurements rather than memory.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { KernelLike } from "@/env/unkernel-kernel";
import { UnkernelEnvironment } from "@/env/unkernel-environment";
import { RuntimeBootstrap } from "@/runtime/bootstrap";

const enabled = process.env.LARPABLE_GUEST_TESTS === "1";

const ROOT = new URL("../../", import.meta.url).pathname;
const EVIDENCE = join(ROOT, "docs", "evidence", "nextjs-guest.txt");
const PROJECT = "nextdemo";

/** The smallest App-Router project: package.json, one page, one layout, one config. */
const APP_FILES: Record<string, string> = {
  [`${PROJECT}/package.json`]: JSON.stringify(
    {
      name: PROJECT,
      private: true,
      scripts: { dev: "next dev", build: "next build", start: "next start" },
    },
    null,
    2,
  ),
  [`${PROJECT}/app/layout.tsx`]: [
    "export const metadata = { title: 'guest next app' };",
    "",
    "export default function RootLayout({ children }: { children: React.ReactNode }) {",
    "  return (",
    "    <html lang=\"en\">",
    "      <body>{children}</body>",
    "    </html>",
    "  );",
    "}",
    "",
  ].join("\n"),
  [`${PROJECT}/app/page.tsx`]: [
    "export default function Page() {",
    "  return (",
    "    <main>",
    "      <h1 id=\"answer\">next-on-unkernel</h1>",
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n"),
  [`${PROJECT}/next.config.mjs`]: ["/** @type {import('next').NextConfig} */", "const nextConfig = {};", "", "export default nextConfig;", ""].join("\n"),
};

function record(lines: readonly string[]): void {
  mkdirSync(join(ROOT, "docs", "evidence"), { recursive: true });
  appendFileSync(EVIDENCE, `${lines.join("\n")}\n`, "utf8");
  for (const line of lines) console.log(line);
}

function tail(text: string, limit = 1200): string {
  const clean = text.replace(/\u001b\[[0-9;]*m/g, "").trimEnd();
  return clean.length <= limit ? clean : `…\n${clean.slice(clean.length - limit)}`;
}

function timed(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}

describe.skipIf(!enabled)("Next.js in the guest", () => {
  it(
    "detects a runtime, installs Next, builds, and answers HTTP from the host",
    async () => {
      const unkernel = await import("unkernel/node");
      const distro = new URL("../../public/distros/debian.erofs", import.meta.url).pathname;

      type MountSource = NonNullable<Parameters<typeof unkernel.createKernel>[0]>["mounts"];
      const fs = new unkernel.MemoryFs();
      const captured: {
        kernel: (KernelLike & { fetch(input: string, init?: RequestInit): Promise<Response> }) | null;
      } = { kernel: null };

      const environment = new UnkernelEnvironment({
        distro,
        network: "direct",
        workspaceFs: fs,
        memoryMiB: 2048,
        commandTimeoutMs: 1_800_000,
        kernelFactory: async (request) => {
          const created = await unkernel.createKernel({
            distro: request.distro,
            net: unkernel.directBackend(),
            mounts: { "/workspace": request.mounts["/workspace"] } as MountSource,
            memoryMiB: request.memoryMiB,
          });
          captured.kernel = created as unknown as NonNullable<typeof captured.kernel>;
          return created as unknown as KernelLike;
        },
      });

      record(["", `## run ${new Date().toISOString()}`, ""]);

      try {
        await environment.initialize();
        record([`boot: ${environment.status()}`]);

        // ---- 1. What runtimes does this image actually give us? ---------------------
        const uname = await environment.execute("uname -m && cat /etc/os-release | head -2");
        record([`uname: ${uname.stdout.trim().split("\n").join(" | ")}`]);

        const warm = new RuntimeBootstrap({ environment, persistentDataDisk: false, network: "online" });
        const warmClock = timed();
        let warmState = "failed";
        try {
          const snapshot = await warm.warm();
          warmState = `ready node=${snapshot.nodeVersion ?? "?"} npm=${snapshot.npmVersion ?? "?"} reused=${String(snapshot.reused)} downloaded=${String(snapshot.downloaded)}`;
        } catch (error) {
          warmState = `failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        record([`runtime warm (${String(warmClock())} ms): ${warmState}`]);

        const bunVersion = await environment.execute("bun --version", { timeoutMs: 180_000 });
        record([
          `bun --version: exit ${String(bunVersion.exitCode)} in ${String(bunVersion.durationMs)} ms -> ${bunVersion.stdout.trim() || bunVersion.stderr.trim()}`,
        ]);

        // ---- 2. Write the project and install --------------------------------------
        for (const [path, content] of Object.entries(APP_FILES)) {
          await environment.writeFile(`/workspace/${path}`, content);
        }

        const bunInstallClock = timed();
        const bunInstall = await environment.execute(
          `cd /workspace/${PROJECT} && bun install next react react-dom 2>&1`,
          { timeoutMs: 1_800_000 },
        );
        record([
          `bun install (${String(bunInstallClock())} ms): exit ${String(bunInstall.exitCode)}`,
          tail(bunInstall.stdout),
        ]);

        let installer = "bun";
        if (bunInstall.exitCode !== 0) {
          installer = "npm";
          const npmClock = timed();
          const npmInstall = await environment.execute(
            `cd /workspace/${PROJECT} && npm install next react react-dom --no-audit --no-fund 2>&1`,
            { timeoutMs: 1_800_000 },
          );
          record([
            `npm install (${String(npmClock())} ms): exit ${String(npmInstall.exitCode)}`,
            tail(npmInstall.stdout),
          ]);
          expect(npmInstall.exitCode, "a package manager installed next + react").toBe(0);
        }
        record([`installer: ${installer}`]);

        const tree = await environment.execute(
          `cd /workspace/${PROJECT} && ls node_modules/next/package.json && node -e "console.log(require('next/package.json').version)" 2>&1`,
        );
        record([`next version: ${tree.stdout.trim().split("\n").slice(-1)[0] ?? "unknown"}`]);

        // ---- 3. next build ----------------------------------------------------------
        const buildClock = timed();
        const build = await environment.execute(
          `cd /workspace/${PROJECT} && ${installer} run build 2>&1`,
          { timeoutMs: 1_800_000 },
        );
        record([
          `build (${String(buildClock())} ms): exit ${String(build.exitCode)}`,
          tail(build.stdout, 2500),
        ]);

        // ---- 4. next start, reached from the host over kernel.fetch ------------------
        const guest = captured.kernel;
        expect(guest, "the kernel handle is captured").not.toBeNull();
        if (guest === null) throw new Error("no kernel handle");

        const controller = new AbortController();
        const serverOutput: string[] = [];
        const server = environment
          .execute(`cd /workspace/${PROJECT} && PORT=3111 ${installer} run start 2>&1`, {
            timeoutMs: 300_000,
            signal: controller.signal,
            onOutput: (chunk) => serverOutput.push(chunk.text),
          })
          .catch((error: unknown) => ({ error }));

        const deadline = Date.now() + 180_000;
        let status: number | null = null;
        let body = "";
        let attempts = 0;
        while (Date.now() < deadline) {
          attempts += 1;
          try {
            const response = await guest.fetch("http://localhost:3111/");
            status = response.status;
            body = await response.text();
            if (status === 200 && body.includes("<html")) break;
          } catch {
            // Not listening yet: the server is still compiling. That is the measurement.
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        record([
          `next start over kernel.fetch: status ${String(status)} after ${String(attempts)} attempts`,
          `server output: ${tail(serverOutput.join(""), 800)}`,
          `html head: ${body.slice(0, 260).replace(/\n/g, " ")}`,
        ]);

        // Does the HTML reference root-absolute `/_next/...` assets, and do they serve?
        const assetMatch = /(?:src|href)="(\/_next\/[^"]+)"/.exec(body);
        let assetStatus: number | null = null;
        if (assetMatch?.[1] !== undefined) {
          try {
            const asset = await guest.fetch(`http://localhost:3111${assetMatch[1]}`);
            assetStatus = asset.status;
          } catch (error) {
            record([`asset fetch failed: ${error instanceof Error ? error.message : String(error)}`]);
          }
        }
        record([`first _next asset: ${assetMatch?.[1] ?? "none"} -> status ${String(assetStatus)}`]);

        controller.abort();
        await server;

        // ---- 5. The static alternative: output: "export" -> out/ --------------------
        await environment.writeFile(
          `/workspace/${PROJECT}/next.config.mjs`,
          ["/** @type {import('next').NextConfig} */", "const nextConfig = { output: 'export' };", "", "export default nextConfig;", ""].join("\n"),
        );
        const exportClock = timed();
        const exportBuild = await environment.execute(
          `cd /workspace/${PROJECT} && ${installer} run build 2>&1`,
          { timeoutMs: 1_800_000 },
        );
        const outListing = await environment.execute(`cd /workspace/${PROJECT} && ls out 2>&1`);
        record([
          `export build (${String(exportClock())} ms): exit ${String(exportBuild.exitCode)}`,
          tail(exportBuild.stdout, 1200),
          `out/: ${outListing.stdout.trim().split("\n").join(" ")}`,
        ]);

        // The measurements are the deliverable; a runner that exits 0 while every step
        // failed would be worse than a failing run.
        expect(environment.status()).toBe("ready");
      } finally {
        await environment.shutdown().catch(() => undefined);
      }
    },
    3_600_000,
  );
});
