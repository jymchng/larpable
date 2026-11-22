/**
 * Throwaway probe: does `curl` in the guest actually work, and why not if it does not?
 *
 *   ./.tooling/node/bin/node scripts/probe-curl.mjs
 */

import { createKernel, directBackend } from "unkernel/node";

const image = new URL("../public/distros/alpine.erofs", import.meta.url).pathname;
const vm = await createKernel({ distro: image, net: directBackend(), memoryMiB: 1024 });

async function run(command) {
  const result = await vm.exec("/bin/sh", ["-lc", command]);
  console.log(`$ ${command}`);
  console.log(`${result.stdout}${result.stderr}[exit ${result.exitCode}]\n`);
}


await run("ls -l /usr/local/bin/curl; head -c 300 /usr/local/bin/curl | cat -v");
await run("curl --version 2>&1 | head -5");
await run("curl -sS -o /dev/null -w '%{http_code}\\n' http://example.com/ 2>&1");
await run("curl -sS -o /dev/null -w '%{http_code}\\n' https://example.com/ 2>&1");
await run("curl -sSI https://example.com/ 2>&1 | head -5");
await run("ls /etc/ssl/certs 2>/dev/null | head -5; ls -l /etc/ssl/cert.pem /etc/ssl/certs/ca-certificates.crt 2>&1");
await run("wget -q -O /dev/null https://example.com/ && echo WGET-HTTPS-OK || echo WGET-HTTPS-FAIL");
await run("ldd /usr/local/bin/curl 2>&1 | head -20");

vm.stop?.();
console.log("probe done");
process.exit(0);
