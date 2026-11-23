/**
 * Scaffold → install → build, in the real guest, with the real npm.
 *
 * This is the acceptance test for goal 8, and the only one that can prove the claim the
 * rest of the product rests on: that a project Larpable scaffolds in memory is a project
 * the guest's own toolchain can install and build. Everything else in this goal is a
 * decision tested against a fake; this is the fact.
 *
 * What it deliberately does not simulate:
 *
 * - the runtime (the guest's `node` shim really downloads Node into `~/.local`),
 * - the install (real `npm install` against the registry, over `direct` networking),
 * - the build (real `vite build`, real esbuild binary, real Rollup graph),
 * - the output check (the `dist/index.html` is read back out of the mounted workspace
 *   and must contain the hashed asset tag Vite emits, not just any HTML).
 *
 * Skipped unless `LARPABLE_GUEST_TESTS=1`: it needs Node >= 24 (JSPI), the Debian image
 * in `public/distros/`, and outbound network. Run it with:
 *
 * ```sh
 * bun run fetch:distros   # once
 * bun run test:guest      # LARPABLE_GUEST_TESTS=1 under .tooling/node
 * ```
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BuildManager } from "@/build/manager";
import type { KernelLike } from "@/env/unkernel-kernel";
import { UnkernelEnvironment } from "@/env/unkernel-environment";
import { RuntimeBootstrap } from "@/runtime/bootstrap";
import { detectRuntime, describeRuntime } from "@/runtime/detect";
import { scaffoldProject, writeScaffold } from "@/runtime/scaffold";

const enabled = process.env.LARPABLE_GUEST_TESTS === "1";

describe.skipIf(!enabled)("scaffold → install → build in the real guest", () => {
  it(
    "produces dist/index.html and a successful build id",
    async () => {
      const unkernel = await import("unkernel/node");
      const distro = new URL("../../public/distros/debian.erofs", import.meta.url).pathname;
      // A 4 GiB sparse disk with real blocks written into it belongs on the checkout's
      // disk, not in a small tmpfs (a full tmpfs here once killed a guest run).
      const scratch = new URL("../../.tmp", import.meta.url).pathname;
      await mkdir(scratch, { recursive: true });
      const dir = await mkdtemp(join(scratch, "build-guest-"));
      const diskPath = join(dir, "kwdata.img");

      const module = await WebAssembly.compile(
        await readFile(new URL("../../node_modules/unkernel/dist/unkernel.wasm", import.meta.url)),
      );
      const template = unkernel.bundledBoot(module).datadisk;
      expect(template, "the kernel carries a kwdata template").toBeTruthy();
      await unkernel.createImageFromKwsparse(diskPath, template as Uint8Array);

      type MountSource = NonNullable<Parameters<typeof unkernel.createKernel>[0]>["mounts"];

      const fs = new unkernel.MemoryFs();
      const environment = new UnkernelEnvironment({
        distro,
        network: "direct",
        workspaceFs: fs,
        memoryMiB: 2048,
        commandTimeoutMs: 900_000,
        kernelFactory: async (request) =>
          (await unkernel.createKernel({
            distro: request.distro,
            net: unkernel.directBackend(),
            disks: [await unkernel.openDisk(diskPath)],
            mounts: { "/workspace": request.mounts["/workspace"] } as MountSource,
            memoryMiB: request.memoryMiB,
          })) as unknown as KernelLike,
      });

      try {
        await environment.initialize();

        // --- The runtime, measured first: nothing runs until node answers. ---
        const runtime = new RuntimeBootstrap({
          environment,
          persistentDataDisk: true,
          warmupTimeoutMs: 900_000,
        });
        const warm = await runtime.ensureReady();
        expect(warm.state).toBe("ready");

        const detected = await detectRuntime(environment);
        // Which runtime wins is measured, not asserted. Goals #2-#7 recorded Bun as
        // unusable on Alpine (`libstdc++.so.6`, exit 127); a later run of this same
        // guest answered `1.4.5` once the probe budget was raised, so on Debian the
        // honest assertion is *consistency*: either Bun was chosen with no fallback
        // reason, or Node was chosen with a reason that quotes what Bun did. Goal #26
        // settles which of those is true.
        expect(["node", "bun"]).toContain(detected.runtime);
        expect(detected.packageManager).toBe(detected.runtime === "bun" ? "bun" : "npm");
        expect(detected.version).toMatch(/^v?\d+\.\d+\.\d+$/);
        expect(detected.packageManagerVersion).toMatch(/^\d+\.\d+\.\d+$/);
        if (detected.runtime === "bun") {
          expect(detected.fallbackReason).toBeNull();
        } else {
          expect(detected.fallbackReason).toMatch(/exited|could not run|did not answer/);
        }

        // --- Scaffold: the React + TS + Vite template, written into /workspace. ---
        const project = scaffoldProject({ framework: "react-ts", name: "guest-build" });
        const written = await writeScaffold(environment, project);
        expect(written).toContain("/workspace/src/App.tsx");
        expect(written).toContain("/workspace/package.json");

        const manager = new BuildManager({
          environment,
          runtime,
          framework: "react-ts",
          // The package manager detection picked, not a hard-coded npm: on a guest where
          // Bun answers, the install and build must go through Bun for this to mean
          // anything.
          packageManager: detected.packageManager,
          installTimeoutMs: 900_000,
          buildTimeoutMs: 600_000,
        });

        // --- Install: real registry, real output streamed into the log. ---
        const install = await manager.install();
        expect(
          install.ok,
          `${install.command} failed: ${install.failure?.summary ?? ""}\n${install.log.stderr.slice(-2_000)}`,
        ).toBe(true);
        expect(install.log.stdout.length).toBeGreaterThan(0);
        expect(install.log.exitCode).toBe(0);

        // --- Build: real vite. ---
        const build = await manager.build();
        expect(
          build.ok,
          `build failed: ${build.failure?.summary ?? ""}\n${(build.log?.stderr ?? "").slice(-2_000)}`,
        ).toBe(true);

        // The id is what the preview and the UI name, so it has to exist and be stable.
        expect(build.id).toMatch(/^build-/);
        expect(build.command).toBe(
          detected.packageManager === "bun" ? "bun run build" : "npm run build",
        );
        expect(build.commandSource).toBe("scripts.build");
        expect(build.outputDir).toBe("dist");
        expect(build.entryPoint).toBe("/workspace/dist/index.html");
        expect(build.entryBytes).toBeGreaterThan(0);
        expect(manager.lastSuccessfulBuild()?.id).toBe(build.id);

        // --- The output, read out of the guest's own workspace. ---
        const html = new TextDecoder().decode(await environment.readFile("/workspace/dist/index.html"));
        expect(html).toContain('<div id="app">');
        // Vite fingerprints its bundle: the tag proves a real build ran, not a copied file.
        expect(html).toMatch(/<script[^>]+src="\/assets\/index-[A-Za-z0-9_-]+\.js"/);

        const dist = (await environment.listFiles("/workspace/dist")).map((entry) => entry.name);
        expect(dist).toContain("index.html");
        expect(dist).toContain("assets");

        const assets = (await environment.listFiles("/workspace/dist/assets")).map((e) => e.name);
        expect(assets.some((name) => name.endsWith(".js"))).toBe(true);
        expect(assets.some((name) => name.endsWith(".css"))).toBe(true);

        // --- Keep the measurement: the report quotes these numbers, not estimates. ---
        await writeFile(
          new URL("../../docs/evidence/build-guest.json", import.meta.url),
          `${JSON.stringify(
            {
              measuredAt: new Date().toISOString(),
              distro,
              runtime: {
                summary: describeRuntime(detected),
                nodeVersion: detected.version,
                npmVersion: detected.packageManagerVersion,
                reused: warm.reused,
                downloaded: warm.downloaded,
                warmupDurationMs: warm.durationMs,
                probes: detected.probes.map((probe) => ({
                  command: probe.command,
                  ok: probe.ok,
                  exitCode: probe.exitCode,
                  version: probe.version,
                })),
              },
              project: {
                framework: project.framework,
                name: project.name,
                files: written,
                buildCommand: project.buildCommand,
                installCommand: project.installCommand,
              },
              install: {
                command: install.command,
                ok: install.ok,
                exitCode: install.log.exitCode,
                durationMs: install.log.durationMs,
                lockfile: install.lockfile,
                tail: install.log.stdout.trim().split("\n").slice(-6),
              },
              build: {
                id: build.id,
                ok: build.ok,
                command: build.command,
                commandSource: build.commandSource,
                reason: build.reason,
                exitCode: build.log?.exitCode ?? null,
                durationMs: build.durationMs,
                outputDir: build.outputDir,
                outputSource: build.outputSource,
                entryPoint: build.entryPoint,
                entryBytes: build.entryBytes,
                tail: (build.log?.stdout ?? "").trim().split("\n").slice(-8),
              },
              outputFiles: { dist, assets },
              htmlHead: html.slice(0, 400),
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } finally {
        await environment.shutdown();
        await rm(dir, { recursive: true, force: true });
      }
    },
    2_400_000,
  );
});
