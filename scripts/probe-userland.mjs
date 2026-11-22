/**
 * Throwaway probe: what userland tools does the Alpine image actually have?
 *
 *   ./.tooling/node/bin/node scripts/probe-userland.mjs
 */

import { createKernel, directBackend } from "unkernel/node";

const image = new URL("../public/distros/alpine.erofs", import.meta.url).pathname;
const vm = await createKernel({ distro: image, net: directBackend(), memoryMiB: 1024 });

async function run(command) {
  const result = await vm.exec("/bin/sh", ["-lc", command]);
  console.log(`$ ${command}`);
  console.log(`${result.stdout}${result.stderr}[exit ${result.exitCode}]\n`);
}

await run("id; echo PATH=$PATH");
await run("command -v curl || echo NO-CURL");
await run("command -v wget || echo NO-WGET");
await run("command -v openssl || echo NO-OPENSSL");
await run("command -v tar gzip unzip git node npm apk || true");
await run("ls /usr/bin | tr '\\n' ' '; echo");
await run("ls /bin | tr '\\n' ' '; echo");
await run("ls /usr/lib/kw/bin 2>/dev/null | tr '\\n' ' '; echo");
await run("busybox --list | tr '\\n' ' '; echo");
await run("busybox wget --help 2>&1 | head -20");

vm.stop?.();
console.log("probe done");
process.exit(0);
