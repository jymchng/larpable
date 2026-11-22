/**
 * unkernel feasibility probes — measured, not assumed.
 *
 * The product exists or falls over on five questions, so this script answers each
 * one by doing it inside a real guest:
 *
 *   a. can a kernel boot from the fetched distro image, and how fast?
 *   b. do shell commands run, and what does the guest actually report?
 *   c. does a host-mounted `MemoryFs` round-trip writes in both directions?
 *   d. is there a JavaScript runtime (Node), and does Bun's aarch64 musl binary run?
 *   e. does the guest reach the internet?
 *
 * `bun run feasibility` re-executes itself under `.tooling/node/bin/node` when the
 * host Node is too old, because unkernel's Node entry needs JSPI.
 *
 * Results are written to `docs/feasibility-report.md` by `scripts/lib/report.ts`.
 * A probe that fails is recorded as a failure with its output; nothing is upgraded
 * to "pass" by hand.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File } from "./lib/download.ts";
import { renderReport, type ProbeResult, type ReportMeta } from "./lib/report.ts";

const root = resolve(import.meta.dirname, "..");
const nodeBin = resolve(root, ".tooling/node/bin/node");
const distroPath = resolve(root, "public/distros/alpine.erofs");
const distroManifestPath = resolve(root, "public/distros/distros.json");
const reportPath = resolve(root, "docs/feasibility-report.md");
const memoryMiB = Number(process.env.LARPABLE_GUEST_MEMORY_MIB ?? 1024);

/**
 * The guest gets a real deadline: an install that hangs must fail the probe instead
 * of hanging the report.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms).unref?.(),
    ),
  ]);
}

function unkernelVersion(): string {
  const pkg = JSON.parse(
    readFileSync(resolve(root, "node_modules/unkernel/package.json"), "utf8"),
  ) as { version: string };
  return pkg.version;
}

function distroMeta(): { distroImage?: string; distroSha256?: string } {
  if (!existsSync(distroManifestPath)) return {};
  const manifest = JSON.parse(readFileSync(distroManifestPath, "utf8")) as {
    distros: Array<{ name: string; image: string; sha256: string }>;
  };
  const alpine = manifest.distros.find((entry) => entry.name === "alpine");
  return alpine ? { distroImage: alpine.image, distroSha256: alpine.sha256 } : {};
}

async function main(): Promise<void> {
  if (!existsSync(distroPath)) {
    throw new Error(
      "public/distros/alpine.erofs is missing. Run `bun run fetch:distros` first.",
    );
  }

  // Imported lazily so the re-exec check below can run under any Node/bun.
  const { createKernel, MemoryFs, directBackend } = await import("unkernel/node");

  const probes: ProbeResult[] = [];
  const started = Date.now();

  const mem = new MemoryFs();
  const bootStart = Date.now();

  let vm: Awaited<ReturnType<typeof createKernel>>;
  try {
    vm = await createKernel({
      distro: distroPath,
      net: directBackend(),
      mounts: { "/mnt/host": mem, "/workspace": { "hello.txt": "host wrote this" } },
      memoryMiB,
      onProgress: (progress: { stage: string }) => console.log(`[feasibility] boot ${progress.stage}`),
    });
  } catch (error) {
    probes.push({
      id: "boot",
      title: "Boot the kernel",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
    });
    await writeReport(probes, started, {});
    throw error;
  }

  const bootMs = Date.now() - bootStart;
  probes.push({
    id: "boot",
    title: "Boot the kernel",
    status: "pass",
    detail: `Alpine booted in ${bootMs} ms`,
    durationMs: bootMs,
  });

  let guestKernel: string | undefined;

  // b. shell
  {
    const start = Date.now();
    const uname = await withTimeout(vm.exec("uname", ["-a"]), 30_000, "uname");
    const osRelease = await withTimeout(vm.exec("cat", ["/etc/os-release"]), 30_000, "os-release");
    guestKernel = uname.stdout.trim();
    const ok = uname.exitCode === 0 && osRelease.exitCode === 0 && uname.stdout.includes("aarch64");
    probes.push({
      id: "shell",
      title: "Execute shell commands",
      status: ok ? "pass" : "fail",
      detail: ok
        ? `uname and /etc/os-release both succeeded (exit ${uname.exitCode}/${osRelease.exitCode})`
        : `uname exit ${uname.exitCode}, os-release exit ${osRelease.exitCode}`,
      durationMs: Date.now() - start,
      output: `${uname.stdout}${osRelease.stdout}`,
    });
  }

  // c. filesystem bridge, both directions
  {
    const start = Date.now();
    const hostToGuest = await vm.exec("cat", ["/workspace/hello.txt"]);
    mem.writeFile("/from-host.txt", "host -> guest");
    const hostWriteSeenByGuest = await vm.exec("cat", ["/mnt/host/from-host.txt"]);
    const guestWrite = await vm.exec("sh", ["-c", "echo 'guest -> host' > /mnt/host/from-guest.txt"]);
    const guestToHost = mem.readText("/from-guest.txt");

    const ok =
      hostToGuest.stdout === "host wrote this" &&
      hostWriteSeenByGuest.stdout === "host -> guest" &&
      guestWrite.exitCode === 0 &&
      guestToHost.trim() === "guest -> host";

    probes.push({
      id: "filesystem",
      title: "Host-mounted filesystem round-trip",
      status: ok ? "pass" : "fail",
      detail: ok
        ? "host -> guest and guest -> host both visible without a remount"
        : "at least one direction did not round-trip",
      durationMs: Date.now() - start,
      output: [
        `static mount  : ${JSON.stringify(hostToGuest.stdout)} (exit ${hostToGuest.exitCode})`,
        `host write    : ${JSON.stringify(hostWriteSeenByGuest.stdout)} (exit ${hostWriteSeenByGuest.exitCode})`,
        `guest write   : exit ${guestWrite.exitCode}`,
        `guest -> host : ${JSON.stringify(guestToHost)}`,
      ].join("\n"),
    });
  }

  // e. network
  {
    const start = Date.now();
    const net = await withTimeout(
      vm.exec("sh", ["-c", "wget -q -O /dev/null http://example.com/ && echo OK"]),
      60_000,
      "wget",
    );
    const ok = net.exitCode === 0 && net.stdout.includes("OK");
    probes.push({
      id: "network",
      title: "Guest outbound networking",
      status: ok ? "pass" : "fail",
      detail: ok ? "http://example.com reachable from the guest" : `wget exited ${net.exitCode}`,
      durationMs: Date.now() - start,
      output: `${net.stdout}${net.stderr}`,
    });
  }

  // d. Node runtime (the fallback the build pipeline depends on).
  //
  // The guest's `node` is a shim, `/usr/lib/kw/bin/node`: the first call downloads a
  // real Node build into `~/.local` and runs it. That first call is measurably
  // unreliable (it can exit 127 while its own bootstrap is still settling), so the
  // probe retries once and reports every attempt instead of flattening them into a
  // single verdict. `apk` is unusable as the guest's unprivileged user, so the shim's
  // own path is the only supported one and is measured as-is.
  {
    const start = Date.now();
    let status: ProbeResult["status"] = "fail";
    let detail = "node did not run";
    let output = "";
    const attempts = 2;

    for (let attempt = 1; attempt <= attempts && status === "fail"; attempt += 1) {
      try {
        const result = await withTimeout(
          vm.exec("sh", ["-c", "node --version && npm --version"]),
          300_000,
          `node (attempt ${attempt})`,
        );
        output += `--- attempt ${attempt}: node --version && npm --version (exit ${result.exitCode}) ---\n${result.stdout}${result.stderr}\n`;
        const lines = result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const version = lines.find((line) => /^v\d+\.\d+/.test(line));
        const npm = lines.find((line) => /^\d+\.\d+\.\d+/.test(line));
        status = result.exitCode === 0 && version ? "pass" : "fail";
        detail =
          status === "pass"
            ? `node ${version}, npm ${npm ?? "?"} (shim bootstrap, attempt ${attempt}, ${((Date.now() - start) / 1000).toFixed(1)} s)`
            : `node exited ${result.exitCode}`;
      } catch (error) {
        output += `--- attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}\n`;
        detail = "node probe timed out";
      }
    }
    probes.push({
      id: "node",
      title: "JavaScript runtime in the guest (Node)",
      status,
      detail,
      durationMs: Date.now() - start,
      output,
    });
  }

  // d. Bun: the preferred runtime, and the reason this report exists
  {
    const start = Date.now();
    const bunUrl =
      "https://github.com/oven-sh/bun/releases/download/bun-v1.4.5/bun-linux-aarch64-musl.zip";
    const script = [
      "set -e",
      `wget -q -O /tmp/bun.zip ${bunUrl}`,
      "unzip -o -q /tmp/bun.zip -d /tmp/bun",
      "chmod +x /tmp/bun/bun-linux-aarch64-musl/bun",
      "/tmp/bun/bun-linux-aarch64-musl/bun --version",
    ].join(" && ");

    const attempt = await withTimeout(vm.exec("sh", ["-c", script]), 300_000, "bun");
    let output = `${attempt.stdout}${attempt.stderr}`;
    let status: ProbeResult["status"] = attempt.exitCode === 0 ? "pass" : "fail";
    let detail =
      status === "pass"
        ? `bun ${attempt.stdout.trim()}`
        : `bun exited ${attempt.exitCode}`;

    if (status === "fail") {
      // A musl binary can fail on missing C++ runtime symbols; installing the
      // Alpine packages is the cheap, honest second attempt before concluding.
      const retry = await withTimeout(
        vm.exec("sh", [
          "-c",
          "apk add --no-cache libstdc++ gcompat 2>&1 | tail -4; /tmp/bun/bun-linux-aarch64-musl/bun --version",
        ]),
        300_000,
        "bun-retry",
      );
      output += `\n--- retry after apk add libstdc++ gcompat ---\n${retry.stdout}${retry.stderr}`;
      status = retry.exitCode === 0 ? "pass" : "fail";
      detail =
        status === "pass"
          ? `bun ${retry.stdout.trim()} (after installing libstdc++/gcompat)`
          : `bun cannot run in this guest (exit ${retry.exitCode}) — use the Node + Vite + esbuild fallback`;
    }

    probes.push({
      id: "bun",
      title: "Bun in the guest (aarch64 musl)",
      status,
      detail,
      durationMs: Date.now() - start,
      output,
    });
  }

  // Park the guest: `poweroff` shuts it down cleanly, `stop()` would not.
  await withTimeout(vm.exec("poweroff"), 30_000, "poweroff").catch(() => {});
  await withTimeout(vm.exited, 30_000, "exit").catch(() => {});

  await writeReport(probes, started, { guestKernel });

  const failed = probes.filter((probe) => probe.status === "fail");
  console.log(
    `[feasibility] ${probes.length - failed.length}/${probes.length} probes passed -> docs/feasibility-report.md`,
  );
  if (failed.length > 0) {
    console.log(`[feasibility] failed: ${failed.map((probe) => probe.id).join(", ")}`);
  }
}

async function writeReport(
  probes: ProbeResult[],
  started: number,
  extra: { guestKernel?: string },
): Promise<void> {
  const meta: ReportMeta = {
    generatedAt: new Date().toISOString(),
    unkernelVersion: unkernelVersion(),
    hostNode: `${process.version} (${process.execPath})`,
    hostPlatform: `${process.platform}/${process.arch}`,
    guestKernel: extra.guestKernel,
    guestMemoryMiB: memoryMiB,
    totalMs: Date.now() - started,
    ...distroMeta(),
  };

  mkdirSync(resolve(root, "docs"), { recursive: true });
  writeFileSync(reportPath, renderReport(meta, probes));
}

async function preflight(): Promise<void> {
  const major = Number(process.versions.node?.split(".")[0] ?? 0);

  if (major >= 24 && typeof (WebAssembly as { Suspending?: unknown }).Suspending === "function") {
    return;
  }

  if (!existsSync(nodeBin)) {
    throw new Error(
      `This host runs Node ${process.version} without JSPI. Run \`bun run fetch:node\` to install a Node >= 24 into .tooling/node, then retry.`,
    );
  }

  console.log(`[feasibility] re-executing under ${nodeBin}`);
  const child = spawnSync(nodeBin, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: process.env,
  });
  process.exit(child.status ?? 1);
}

await preflight();

// The distro hash is part of the report: a report that cannot say which image it
// measured is not evidence.
if (existsSync(distroPath)) {
  const manifest = JSON.parse(readFileSync(distroManifestPath, "utf8")) as {
    distros: Array<{ name: string; sha256: string }>;
  };
  const expected = manifest.distros.find((entry) => entry.name === "alpine")?.sha256;
  const actual = await sha256File(distroPath);
  if (expected && expected !== actual) {
    throw new Error(`alpine.erofs sha256 ${actual} does not match the manifest (${expected})`);
  }
}

await main().catch((error: unknown) => {
  console.error(`[feasibility] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
