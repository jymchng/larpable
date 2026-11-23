/**
 * Throwaway probe: can the Debian guest serve a directory over HTTP, and can the host
 * read it back through `vm.fetch`?
 *
 * The preview pipeline rests on two facts that must be measured, not assumed:
 *
 * 1. some static HTTP server exists in the image (python3? busybox? node?),
 * 2. `kernel.fetch("http://127.0.0.1:<port>/…")` returns a real `Response` with the
 *    bytes and headers of what that server answered.
 *
 *   ./.tooling/node/bin/node scripts/probe-guest-http.mjs
 */

import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";

import { MemoryFs, bundledBoot, createImageFromKwsparse, createKernel, directBackend, openDisk } from "unkernel/node";

const distro = new URL("../public/distros/debian.erofs", import.meta.url).pathname;
const scratch = new URL("../.tmp", import.meta.url).pathname;
await mkdir(scratch, { recursive: true });
const dir = await mkdtemp(join(scratch, "probe-http-"));
const diskPath = join(dir, "kwdata.img");

const module = await WebAssembly.compile(
  await readFile(new URL("../node_modules/unkernel/dist/unkernel.wasm", import.meta.url)),
);
const template = bundledBoot(module).datadisk;
await createImageFromKwsparse(diskPath, template);

const workspace = new MemoryFs({
  "index.html": "<!doctype html><title>hi</title><h1>hello</h1>",
  "assets/app.js": 'console.log("hi")',
  "notes.txt": "plain",
});

const vm = await createKernel({
  distro,
  mounts: { "/workspace": workspace },
  disks: [await openDisk(diskPath)],
  net: directBackend(),
  memoryMiB: 2048,
  onProgress: (p) => console.log(`[boot] ${p.stage}`),
});

async function run(command) {
  const result = await vm.exec("/bin/sh", ["-lc", command]);
  console.log(`$ ${command}\n${result.stdout}${result.stderr}[exit ${result.exitCode}]\n`);
  return result;
}

await run("id; echo PATH=$PATH");
await run("for c in python3 python busybox node npm npx php ruby; do printf '%s=%s ' \"$c\" \"$(command -v $c || echo none)\"; done; echo");
await run("python3 -V 2>&1; busybox 2>&1 | head -3");

// Start whichever server exists, in the background, and give it a moment.
const server = await vm.spawn("/bin/sh", ["-lc", "cd /workspace && python3 -m http.server 8123 --bind 127.0.0.1"], {
  cwd: "/workspace",
  pty: false,
});
const reader = (async () => {
  const decoder = new TextDecoder();
  for await (const chunk of server.stdout) process.stdout.write(`[server] ${decoder.decode(chunk)}`);
})();
await new Promise((resolve) => setTimeout(resolve, 4000));

for (const path of ["/index.html", "/assets/app.js", "/notes.txt", "/missing.html", "/deep/route"]) {
  try {
    const response = await vm.fetch(`http://127.0.0.1:8123${path}`);
    const body = await response.text();
    console.log(
      `[fetch] ${path} -> ${response.status} ${response.headers.get("content-type")} bytes=${body.length} body=${JSON.stringify(body.slice(0, 60))}`,
    );
  } catch (error) {
    console.log(`[fetch] ${path} -> threw ${error instanceof Error ? error.message : String(error)}`);
  }
}

server.kill("SIGKILL");
await reader.catch(() => undefined);
vm.stop?.({ code: 0, reason: "probe done" });
console.log("probe done");
process.exit(0);
