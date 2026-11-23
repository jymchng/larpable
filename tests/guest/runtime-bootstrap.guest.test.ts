/**
 * The runtime bootstrap, against the real guest and a real persistent data disk.
 *
 * The unit suite proves the *decisions* (ordering, retry, cache reuse) against a fake
 * environment. This file proves the fact those decisions rest on: that the shim's
 * download really lands in `~/.local` on the disk, and that a second boot with the same
 * disk finds it and does not download again. Nothing here is simulated — if the guest
 * downloads twice, this test fails and says so.
 *
 * Skipped unless `LARPABLE_GUEST_TESTS=1`, because it needs Node >= 24 (JSPI), the
 * Debian image in `public/distros/`, and outbound network for the shim's one download
 * (~147 s on the machine that wrote the feasibility report). Run it with:
 *
 * ```sh
 * bun run fetch:distros   # once
 * bun run test:guest      # LARPABLE_GUEST_TESTS=1 under .tooling/node
 * ```
 *
 * The persistent disk is the same kind of disk the browser attaches: a `kwdata` image
 * created from the template the kernel carries, opened with `openDisk()`. `poweroff` in
 * `shutdown()` is what flushes it, so the second boot sees the first boot's writes.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { KernelLike } from "@/env/unkernel-kernel";
import { UnkernelEnvironment } from "@/env/unkernel-environment";
import { RuntimeBootstrap, type RuntimeSnapshot } from "@/runtime/bootstrap";

const enabled = process.env.LARPABLE_GUEST_TESTS === "1";

/** Only the fields the evidence file records, so a failure message is readable. */
function evidence(label: string, snapshot: RuntimeSnapshot) {
  return {
    label,
    state: snapshot.state,
    nodeVersion: snapshot.nodeVersion,
    npmVersion: snapshot.npmVersion,
    cache: snapshot.cache,
    cacheDir: snapshot.cacheDir,
    reused: snapshot.reused,
    downloaded: snapshot.downloaded,
    network: snapshot.network,
    durationMs: snapshot.durationMs,
    attempts: snapshot.attempts.map((attempt) => ({
      index: attempt.index,
      command: attempt.command,
      exitCode: attempt.exitCode,
      durationMs: attempt.durationMs,
      installed: attempt.installed,
    })),
    warnings: snapshot.warnings,
  };
}

describe.skipIf(!enabled)("RuntimeBootstrap against the real guest", () => {
  it(
    "warms node + npm once and reuses the install on the next boot",
    async () => {
      const unkernel = await import("unkernel/node");
      const distro = new URL("../../public/distros/debian.erofs", import.meta.url).pathname;
      // Not `os.tmpdir()`: this image is 4 GiB sparse and the guest writes real blocks
      // into it, so it belongs on the same disk as the checkout, not a small tmpfs.
      const scratch = new URL("../../.tmp", import.meta.url).pathname;
      await mkdir(scratch, { recursive: true });
      const dir = await mkdtemp(join(scratch, "runtime-bootstrap-"));
      const diskPath = join(dir, "kwdata.img");

      // The data disk the guest keeps its root overlay in. The template ships inside
      // the kernel wasm; `createImageFromKwsparse` lays it out as a disk on the host.
      const module = await WebAssembly.compile(
        await readFile(new URL("../../node_modules/unkernel/dist/unkernel.wasm", import.meta.url)),
      );
      const template = unkernel.bundledBoot(module).datadisk;
      expect(template, "the kernel carries a kwdata template").toBeTruthy();
      await unkernel.createImageFromKwsparse(diskPath, template as Uint8Array);

      type MountSource = NonNullable<Parameters<typeof unkernel.createKernel>[0]>["mounts"];

      /** One boot of the same image with the same data disk. */
      const boot = async (): Promise<UnkernelEnvironment> => {
        const fs = new unkernel.MemoryFs();
        const env = new UnkernelEnvironment({
          distro,
          network: "direct",
          workspaceFs: fs,
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
        await env.initialize();
        return env;
      };

      try {
        // --- Boot 1: cold. The shim downloads; the disk keeps the download. ---
        const firstEnv = await boot();
        let cold: RuntimeSnapshot;
        try {
          const runtime = new RuntimeBootstrap({
            environment: firstEnv,
            persistentDataDisk: true,
            warmupTimeoutMs: 600_000,
          });
          cold = await runtime.ensureReady();
        } finally {
          await firstEnv.shutdown();
        }

        expect(cold.state).toBe("ready");
        expect(cold.nodeVersion).toMatch(/^v\d+\.\d+\.\d+$/);
        expect(cold.npmVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(cold.cache).toBe("persisted");
        expect(cold.reused).toBe(false);
        expect(cold.downloaded).toBe(true);

        // --- Boot 2: same disk. The probe must find the install; nothing downloads. ---
        const secondEnv = await boot();
        let warm: RuntimeSnapshot;
        try {
          const runtime = new RuntimeBootstrap({
            environment: secondEnv,
            persistentDataDisk: true,
            warmupTimeoutMs: 600_000,
            cachedTimeoutMs: 120_000,
          });
          warm = await runtime.ensureReady();
        } finally {
          await secondEnv.shutdown();
        }

        expect(warm.state).toBe("ready");
        expect(warm.nodeVersion).toBe(cold.nodeVersion);
        expect(warm.npmVersion).toBe(cold.npmVersion);
        expect(warm.reused).toBe(true);
        expect(warm.downloaded).toBe(false);
        // The warm call is one exec, not one attempt plus a retry.
        expect(warm.attempts).toHaveLength(1);

        // Keep the measurement, not just the assertion: the report quotes these.
        await writeFile(
          new URL("../../docs/evidence/runtime-bootstrap-guest.json", import.meta.url),
          `${JSON.stringify(
            {
              measuredAt: new Date().toISOString(),
              distro,
              dataDisk: "kwdata template via createImageFromKwsparse",
              cold: evidence("first boot with an empty data disk", cold),
              warm: evidence("second boot with the same data disk", warm),
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    1_800_000,
  );
});
