/**
 * TEMPORARY diagnostic (deleted after use): why is `packageManagerVersion` not a string
 * in the guest? The candidate cause is the 20 s default probe budget in `detectRuntime`,
 * which would leave `version: null` — and vitest reports `typeof null` as "got object".
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { KernelLike } from "@/env/unkernel-kernel";
import { UnkernelEnvironment } from "@/env/unkernel-environment";
import { RuntimeBootstrap } from "@/runtime/bootstrap";
import { detectRuntime } from "@/runtime/detect";

const enabled = process.env.LARPABLE_GUEST_TESTS === "1";

describe.skipIf(!enabled)("diagnose detectRuntime in the guest", () => {
  it(
    "prints the timing and the type of every field",
    async () => {
      const unkernel = await import("unkernel/node");
      const distro = new URL("../../public/distros/alpine.erofs", import.meta.url).pathname;
      const scratch = new URL("../../.tmp", import.meta.url).pathname;
      await mkdir(scratch, { recursive: true });
      const dir = await mkdtemp(join(scratch, "diagnose-"));
      const diskPath = join(dir, "kwdata.img");
      const module = await WebAssembly.compile(
        await readFile(new URL("../../node_modules/unkernel/dist/unkernel.wasm", import.meta.url)),
      );
      await unkernel.createImageFromKwsparse(diskPath, unkernel.bundledBoot(module).datadisk as Uint8Array);

      type MountSource = NonNullable<Parameters<typeof unkernel.createKernel>[0]>["mounts"];
      const env = new UnkernelEnvironment({
        distro,
        network: "direct",
        workspaceFs: new unkernel.MemoryFs(),
        memoryMiB: 1024,
        commandTimeoutMs: 600_000,
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
        const booted = Date.now();
        await env.initialize();
        console.log(`boot: ${Date.now() - booted} ms`);

        const runtime = new RuntimeBootstrap({ environment: env, persistentDataDisk: true, warmupTimeoutMs: 600_000 });
        const warm = await runtime.ensureReady();
        console.log(`warm-up: node=${warm.nodeVersion} npm=${warm.npmVersion} reused=${String(warm.reused)}`);

        for (const command of ["node --version", "npm --version", "npm --version"]) {
          const t0 = Date.now();
          try {
            const result = await env.execute(command, { timeoutMs: 120_000 });
            console.log(
              `${command}: ${Date.now() - t0} ms exit=${String(result.exitCode)} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr.slice(0, 160))}`,
            );
          } catch (error) {
            console.log(`${command}: ${Date.now() - t0} ms THREW ${(error as Error).name}: ${(error as Error).message}`);
          }
        }

        for (const timeoutMs of [20_000, 120_000]) {
          const info = await detectRuntime(env, { timeoutMs });
          console.log(
            `detectRuntime(${timeoutMs} ms) => ${JSON.stringify(
              {
                version: info.version,
                versionType: typeof info.version,
                packageManagerVersion: info.packageManagerVersion,
                packageManagerVersionType: typeof info.packageManagerVersion,
                probes: info.probes.map((probe) => ({
                  command: probe.command,
                  ok: probe.ok,
                  exitCode: probe.exitCode,
                  version: probe.version,
                  versionType: typeof probe.version,
                  detail: probe.detail.slice(0, 160),
                })),
              },
              null,
              2,
            )}`,
          );
        }

        expect(true).toBe(true);
      } finally {
        await env.shutdown();
        await rm(dir, { recursive: true, force: true });
      }
    },
    1_800_000,
  );
});
