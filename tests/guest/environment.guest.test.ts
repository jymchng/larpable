/**
 * The adapter, against the real kernel.
 *
 * The unit suite proves the logic with a fake kernel; this file proves the wiring —
 * that `UnkernelEnvironment`'s mounts, `spawn` on pipes, exit codes and `poweroff` all
 * match the actual unkernel SDK. It is skipped unless `LARPABLE_GUEST_TESTS=1`,
 * because it needs:
 *
 * - Node >= 24 (JSPI) — hence `bun run test:guest`, which runs vitest under
 *   `.tooling/node/bin/node`,
 * - the Debian image in `public/distros/` (`bun run fetch:distros`).
 *
 * It uses `directBackend()` from `unkernel/node`: the browser has no direct backend
 * (Wisp only), but on Node it is the simplest way to boot a guest for a test.
 */

import { describe, expect, it } from "vitest";

import type { KernelLike } from "@/env/unkernel-kernel";
import { UnkernelEnvironment } from "@/env/unkernel-environment";

const enabled = process.env.LARPABLE_GUEST_TESTS === "1";

describe.skipIf(!enabled)("UnkernelEnvironment against the real guest", () => {
  it(
    "boots, runs shell commands, round-trips files, reports exit codes and shuts down",
    async () => {
      const { createKernel, directBackend, MemoryFs } = await import("unkernel/node");
      type MountSource = NonNullable<Parameters<typeof createKernel>[0]>["mounts"];
      const image = new URL("../../public/distros/debian.erofs", import.meta.url).pathname;
      const fs = new MemoryFs();

      const env = new UnkernelEnvironment({
        distro: image,
        network: "direct",
        workspaceFs: fs,
        memoryMiB: 1024,
        commandTimeoutMs: 120_000,
        // Boot with the adapter's own workspace file system mounted, so everything the
        // adapter reads and writes is the same tree Linux sees over 9p.
        kernelFactory: async (request) =>
          (await createKernel({
            distro: request.distro,
            net: directBackend(),
            // The adapter mounts its own MemoryFs; hand that exact instance to the
            // kernel so host and guest see one tree.
            mounts: { "/workspace": request.mounts["/workspace"] } as MountSource,
            memoryMiB: request.memoryMiB,
          })) as unknown as KernelLike,
      });

      const stages: string[] = [];
      await env.initialize({ onStage: (stage) => stages.push(stage) });

      expect(env.status()).toBe("ready");
      expect(stages).toEqual(["boot", "filesystem", "shell", "runtime"]);

      const uname = await env.execute("uname -a");
      expect(uname.exitCode).toBe(0);
      expect(uname.stdout).toContain("aarch64");

      await env.writeFile("package.json", '{"name":"guest-probe"}');
      const cat = await env.execute("cat /workspace/package.json");
      expect(cat.stdout.trim()).toBe('{"name":"guest-probe"}');

      const listing = await env.listFiles("/workspace");
      expect(listing.map((entry) => entry.name)).toContain("package.json");

      const failed = await env.execute("sh -c 'exit 3'");
      expect(failed.exitCode).toBe(3);

      const streamed: string[] = [];
      await env.execute("printf 'streamed-ok'", {
        onOutput: (chunk) => streamed.push(chunk.text),
      });
      expect(streamed.join("")).toContain("streamed-ok");

      await env.shutdown();
      expect(env.status()).toBe("stopped");
    },
    300_000,
  );
});
