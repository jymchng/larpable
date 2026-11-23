/**
 * The Netlify configuration step, run against the real guest and a real build.
 *
 * Goal 9's acceptance has two halves: unit tests for the framework/manager matrix, and the
 * claim that the generated file is written into the *guest* project root by the flow the
 * agent will call. Only a real guest can support the second half, and only a real build can
 * make the publish check mean anything: `publish` is compared against the directory vite
 * actually wrote, not against the string the generator itself chose.
 *
 * The file is then read back out of the mounted workspace with a plain `cat`-equivalent
 * `readFile`, so a write that never reached the disk would fail here rather than pass.
 *
 * Skipped unless `LARPABLE_GUEST_TESTS=1`, like the other guest tests.
 */

import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BuildManager } from "@/build/manager";
import type { KernelLike } from "@/env/unkernel-kernel";
import { UnkernelEnvironment } from "@/env/unkernel-environment";
import { ensureNetlifyConfig } from "@/netlify/flow";
import { RuntimeBootstrap } from "@/runtime/bootstrap";
import { detectRuntime } from "@/runtime/detect";
import { scaffoldProject, writeScaffold } from "@/runtime/scaffold";

const enabled = process.env.LARPABLE_GUEST_TESTS === "1";

describe.skipIf(!enabled)("netlify.toml in the real guest", () => {
  it(
    "generates, writes and validates a configuration from a real build",
    async () => {
      const unkernel = await import("unkernel/node");
      const distro = new URL("../../public/distros/debian.erofs", import.meta.url).pathname;
      const scratch = new URL("../../.tmp", import.meta.url).pathname;
      await mkdir(scratch, { recursive: true });
      const dir = await mkdtemp(join(scratch, "netlify-guest-"));
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

        const runtime = new RuntimeBootstrap({
          environment,
          persistentDataDisk: true,
          warmupTimeoutMs: 900_000,
        });
        const warm = await runtime.ensureReady();
        expect(warm.state).toBe("ready");

        const detected = await detectRuntime(environment);

        // --- A real project, installed and built in the guest. ---
        const project = scaffoldProject({ framework: "react-ts", name: "netlify-guest" });
        await writeScaffold(environment, project);

        const manager = new BuildManager({
          environment,
          runtime,
          framework: "react-ts",
          packageManager: detected.packageManager,
          installTimeoutMs: 900_000,
          buildTimeoutMs: 600_000,
        });

        const install = await manager.install();
        expect(install.ok, `${install.command} failed: ${install.log.stderr.slice(-2_000)}`).toBe(true);

        const build = await manager.build();
        expect(build.ok, `build failed: ${build.failure?.summary ?? ""}\n${(build.log?.stderr ?? "").slice(-2_000)}`).toBe(true);
        expect(build.entryPoint).toBe(`/workspace/${build.outputDir}/index.html`);

        const distEntries = (await environment.listFiles(`/workspace/${build.outputDir}`)).map((entry) => entry.name);

        // --- The agent flow's deployment step, with the real build as evidence. ---
        const first = await ensureNetlifyConfig(environment, {
          hints: {
            packageManager: detected.packageManager,
            packageManagerVersion: detected.version,
          },
          build: { dir: build.outputDir, entryExists: build.entryPoint !== null, entries: distEntries },
        });

        expect(first.path).toBe("/workspace/netlify.toml");
        expect(first.sync.action).toBe("written");
        expect(first.validation.ok, first.validation.summary).toBe(true);
        expect(first.validation.issues).toEqual([]);

        // Read the file back out of the mounted workspace: the write has to be on disk.
        const toml = new TextDecoder().decode(await environment.readFile("/workspace/netlify.toml"));
        expect(toml).toContain(`publish = "${build.outputDir}"`);
        expect(toml).toContain(
          detected.packageManager === "bun" ? 'command = "bun run build"' : 'command = "npm run build"',
        );
        expect(toml).toContain('from = "/*"');
        expect(toml).toContain('to = "/index.html"');

        // --- Second run: the file is already right, so nothing is rewritten. ---
        const second = await ensureNetlifyConfig(environment, {
          hints: {
            packageManager: detected.packageManager,
            packageManagerVersion: detected.version,
          },
          build: { dir: build.outputDir, entryExists: build.entryPoint !== null, entries: distEntries },
        });
        expect(second.sync.action).toBe("unchanged");
        expect(second.validation.ok).toBe(true);
        const tomlAfter = new TextDecoder().decode(await environment.readFile("/workspace/netlify.toml"));
        expect(tomlAfter).toBe(toml);

        await mkdir(new URL("../../docs/evidence", import.meta.url), { recursive: true });
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
          new URL("../../docs/evidence/netlify-guest.json", import.meta.url),
          `${JSON.stringify(
            {
              measuredAt: new Date().toISOString(),
              distro,
              runtime: { version: detected.version, packageManager: detected.packageManager },
              build: { id: build.id, outputDir: build.outputDir, entryPoint: build.entryPoint, durationMs: build.durationMs },
              facts: {
                framework: first.facts.framework,
                frameworkReason: first.facts.frameworkReason,
                packageManager: first.facts.packageManager,
                packageManagerReason: first.facts.packageManagerReason,
                buildCommand: first.facts.buildCommand,
                publishDir: first.facts.publishDir,
                publishReason: first.facts.publishReason,
                spa: first.facts.spa,
                spaReason: first.facts.spaReason,
                functionsDir: first.facts.functionsDir,
                lockfile: first.facts.lockfile,
                problems: first.facts.problems,
              },
              sync: { action: first.sync.action, path: first.sync.path, reason: first.sync.reason },
              validation: { ok: first.validation.ok, summary: first.validation.summary, issues: first.validation.issues },
              secondSync: { action: second.sync.action, reason: second.sync.reason },
              decisions: first.decisions,
              toml,
            },
            null,
            2,
          )}\n`,
        );
      } finally {
        await environment.shutdown();
      }
    },
    1_200_000,
  );
});
