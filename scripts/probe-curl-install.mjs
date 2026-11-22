/**
 * Throwaway probe: can a real static curl be installed into the guest and actually use
 * the network? Host sockets (directBackend), so this proves the binary, not the Wisp.
 *
 *   ./.tooling/node/bin/node scripts/probe-curl-install.mjs
 */

import { readFile } from "node:fs/promises";

import { MemoryFs, createKernel, directBackend } from "unkernel/node";

const image = new URL("../public/distros/alpine.erofs", import.meta.url).pathname;
const binary = await readFile(new URL("../.tmp/curl/curl", import.meta.url));

const fs = new MemoryFs();
fs.writeFile("/.larpable/bin/curl", new Uint8Array(binary));
console.log("staged bytes in /workspace/.larpable/bin/curl:", binary.byteLength);

const vm = await createKernel({
  distro: image,
  net: directBackend(),
  memoryMiB: 1024,
  mounts: { "/workspace": fs },
});

async function run(command) {
  const result = await vm.exec("/bin/sh", ["-lc", command]);
  console.log(`$ ${command}\n${result.stdout}${result.stderr}[exit ${result.exitCode}]\n`);
  return result;
}

await run("id -u; echo $PATH");
await run("curl --version 2>&1 | head -3");
await run("ls -l /workspace/.larpable/bin/curl");
await run("mkdir -p ~/.local/bin && cp /workspace/.larpable/bin/curl ~/.local/bin/curl && chmod 755 ~/.local/bin/curl && ls -l ~/.local/bin/curl");
await run("command -v curl; curl --version | head -2");
await run("curl -sS -o /dev/null -w 'http=%{http_code}\\n' http://example.com/ 2>&1");
await run("curl -sS -o /dev/null -w 'https=%{http_code}\\n' https://example.com/ 2>&1");
await run("curl -sS https://example.com/ 2>&1 | head -c 120");

vm.stop?.();
console.log("probe done");
process.exit(0);
