/**
 * The preview, end to end in the real guest: a real HTTP server, real bytes, real headers.
 *
 * This is the acceptance test for goal 14's transport half. Everything else about the
 * preview is a decision tested against a table; this is the fact that the decisions apply
 * to a guest that is actually serving `dist/` on its own loopback, reached from the host
 * the only way the host can reach it — `kernel.fetch()` over a guest TCP connection.
 *
 * The build is a fixture written into `/workspace/dist` rather than a `vite build`, on
 * purpose: `build.guest.test.ts` already proves that the guest's own toolchain produces a
 * real `dist/` with hashed assets, and repeating a five-minute install here would only
 * make the same assertion more expensive. The fixture is shaped like Vite's output —
 * hashed asset names, a module script, a stylesheet, a source map, a nested page — because
 * those are the file kinds the preview has to get right.
 *
 * Skipped unless `LARPABLE_GUEST_TESTS=1`, like the other guest tests: it needs Node >= 24
 * (JSPI), the Debian image in `public/distros/`, and outbound network on the first run
 * because the guest's `node` is a first-use shim.
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { KernelLike } from "@/env/unkernel-kernel";
import { UnkernelEnvironment } from "@/env/unkernel-environment";
import {
  DEFAULT_PREVIEW_PORT,
  PREVIEW_SERVER_DIR,
  PREVIEW_SERVER_SCRIPT,
  startPreviewServer,
} from "@/preview/guest-server";
import {
  collectPreviewSnapshot,
  servePreviewRequest,
  snapshotBuild,
} from "@/preview/proxy";
import { PREVIEW_PREFIX } from "@/preview/routing";
import { kernelPreviewTransport } from "@/preview/transport";

const enabled = process.env.LARPABLE_GUEST_TESTS === "1";

/** A PNG header plus every byte value, so a text round trip cannot pass by accident. */
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 64 }, (_, i) => i)]);

const FIXTURE: Record<string, string | Uint8Array> = {
  "/workspace/dist/index.html":
    '<!doctype html><html><head><link rel="stylesheet" href="/assets/index-def67890.css"></head>' +
    '<body><div id="root"></div><script type="module" src="/assets/index-abc12345.js"></script></body></html>',
  "/workspace/dist/assets/index-abc12345.js": "export const answer = 42;\n//# sourceMappingURL=index-abc12345.js.map\n",
  "/workspace/dist/assets/index-abc12345.js.map": '{"version":3,"sources":["src/main.ts"]}',
  "/workspace/dist/assets/index-def67890.css": "body{margin:0;font-family:system-ui}",
  "/workspace/dist/docs/index.html": "<h1>docs</h1>",
  "/workspace/dist/logo.png": PNG,
};

describe.skipIf(!enabled)("the preview against the real guest", () => {
  it(
    "serves a build over HTTP through the kernel, with the headers the preview decided",
    async () => {
      const unkernel = await import("unkernel/node");
      const distro = new URL("../../public/distros/debian.erofs", import.meta.url).pathname;
      const scratch = new URL("../../.tmp", import.meta.url).pathname;
      await mkdir(scratch, { recursive: true });
      await mkdtemp(join(scratch, "preview-guest-")).then(async (dir) => {
        const diskPath = join(dir, "kwdata.img");

        const module = await WebAssembly.compile(
          await readFile(new URL("../../node_modules/unkernel/dist/unkernel.wasm", import.meta.url)),
        );
        const template = unkernel.bundledBoot(module).datadisk;
        await unkernel.createImageFromKwsparse(diskPath, template as Uint8Array);

        type MountSource = NonNullable<Parameters<typeof unkernel.createKernel>[0]>["mounts"];

        const fs = new unkernel.MemoryFs();
        // The kernel handle is captured here because it is the host's only way into the
        // guest: `kernel.fetch()` speaks HTTP/1.1 over a guest TCP connection.
        // A holder, not a `let`: the assignment happens inside the factory, which the
        // compiler cannot see, so a direct `kernel !== null` would narrow to `never`.
        const captured: {
          kernel: (KernelLike & { fetch(input: string, init?: RequestInit): Promise<Response> }) | null;
        } = { kernel: null };

        const environment = new UnkernelEnvironment({
          distro,
          network: "direct",
          workspaceFs: fs,
          memoryMiB: 2048,
          commandTimeoutMs: 900_000,
          kernelFactory: async (request) => {
            const created = await unkernel.createKernel({
              distro: request.distro,
              net: unkernel.directBackend(),
              disks: [await unkernel.openDisk(diskPath)],
              mounts: { "/workspace": request.mounts["/workspace"] } as MountSource,
              memoryMiB: request.memoryMiB,
            });
            captured.kernel = created as unknown as NonNullable<typeof captured.kernel>;
            return created as unknown as KernelLike;
          },
        });

        let server: Awaited<ReturnType<typeof startPreviewServer>> | null = null;
        try {
          await environment.initialize();
          for (const [path, content] of Object.entries(FIXTURE)) {
            await environment.writeFile(path, content);
          }

          const guest = captured.kernel;
          expect(guest, "the kernel handle is captured for the transport").not.toBeNull();
          if (guest === null) throw new Error("no kernel handle");

          // The server's own reads go through the guest too, not the host.
          server = await startPreviewServer(environment, {
            timeoutMs: 900_000,
            fetch: (url, init) => guest.fetch(url, init),
          });
          expect(server.port).toBe(DEFAULT_PREVIEW_PORT);
          expect(server.root).toBe("/workspace/dist");

          // What the guest says it is serving, over HTTP.
          const listed = await server.listFiles();
          expect(listed.map((file) => file.path).sort()).toEqual([
            "/assets/index-abc12345.js",
            "/assets/index-abc12345.js.map",
            "/assets/index-def67890.css",
            "/docs/index.html",
            "/index.html",
            "/logo.png",
          ]);

          const transport = kernelPreviewTransport(guest, { port: server.port });
          const served = await transport.fetch("/index.html");
          expect(served.status).toBe(200);
          expect(new TextDecoder().decode(served.body)).toContain("id=\"root\"");

          // Publish the build the way the app does, then answer requests from the snapshot.
          const snapshot = await collectPreviewSnapshot({
            buildId: "b-guest-1",
            fallbackPath: "/index.html",
            transport,
          });
          const build = snapshotBuild(snapshot);
          expect(build.files.size).toBe(6);

          const home = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-1/` },
            { build, transport },
          );
          expect(home?.status).toBe(200);
          expect(home?.headers["content-type"]).toBe("text/html; charset=utf-8");
          expect(home?.headers["cache-control"]).toBe("no-store");

          // An SPA deep link resolves to the entry point, as Netlify's redirect would.
          const deepLink = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-1/app/editor/settings` },
            { build, transport },
          );
          expect(deepLink?.status).toBe(200);
          expect(new TextDecoder().decode(deepLink?.body)).toContain("id=\"root\"");

          // A module and a source map get the types the browser's loader and devtools need.
          const script = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-1/assets/index-abc12345.js` },
            { build, transport },
          );
          expect(script?.headers["content-type"]).toBe("text/javascript; charset=utf-8");
          expect(script?.headers["cache-control"]).toMatch(/immutable/);
          expect(new TextDecoder().decode(script?.body)).toContain("answer = 42");

          const map = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-1/assets/index-abc12345.js.map` },
            { build, transport },
          );
          expect(map?.headers["content-type"]).toBe("application/json; charset=utf-8");
          expect(map?.headers["cache-control"]).toBe("no-store");

          const css = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-1/assets/index-def67890.css` },
            { build, transport },
          );
          expect(css?.headers["content-type"]).toBe("text/css; charset=utf-8");

          // A binary asset survives the guest's HTTP and the host's proxy byte for byte.
          const png = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-1/logo.png` },
            { build, transport },
          );
          expect(png?.status).toBe(200);
          expect(png?.body).toEqual(PNG);
          expect(png?.headers["content-type"]).toBe("image/png");
          expect(png?.headers["content-length"]).toBe(String(PNG.byteLength));

          // A nested directory is answered by its index file, not by the SPA fallback.
          const docs = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-1/docs` },
            { build, transport },
          );
          expect(new TextDecoder().decode(docs?.body)).toContain("<h1>docs</h1>");

          // A stale build id is refused before the guest is asked for anything.
          const stale = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-0/index.html` },
            { build, transport },
          );
          expect(stale?.status).toBe(409);

          // And a file that is not in the build is a 404, not the home page.
          const missing = await servePreviewRequest(
            { url: `${PREVIEW_PREFIX}/b-guest-1/nope.js` },
            { build: { ...build, fallbackPath: null }, transport },
          );
          expect(missing?.status).toBe(404);
        } finally {
          await server?.stop();
          await environment.shutdown();
          // The server script lives in the workspace; the disk directory is scratch.
          await environment
            .removeFile(`/workspace/${PREVIEW_SERVER_DIR}/${PREVIEW_SERVER_SCRIPT}`)
            .catch(() => undefined);
          await rm(dir, { recursive: true, force: true });
        }
      });
    },
    900_000,
  );
});
