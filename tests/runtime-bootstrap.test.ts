import { describe, expect, it } from "vitest";

import { FakeEnvironment, type FakeCommandHandler } from "@/env/fake-environment";
import {
  APK_RESTRICTION,
  BUN_EXCLUSION,
  DEFAULT_NETWORK_PROBE,
  OFFLINE_MESSAGE,
  RuntimeBootstrap,
  RuntimeBootstrapError,
  SUPPORTED_RUNTIME,
  describeRuntimeSupport,
  parseRuntimeVersions,
} from "@/runtime/bootstrap";

const PROBE = 'ls -1 "/home/user/.local/share/node" 2>/dev/null | head -3';
const WARMUP = "node --version && npm --version";
const NETWORK = "wget -q -O /dev/null http://example.com/ && echo ONLINE || echo OFFLINE";

interface Harness {
  environment: FakeEnvironment;
  runtime: RuntimeBootstrap;
  /** Commands in the order the guest saw them. */
  commands(): string[];
}

async function harness(
  options: {
    /** The shim already installed Node on this home directory. */
    cached?: boolean;
    /** Answers for the warm-up, in order; the last one repeats. */
    warmups?: Array<{ exitCode?: number; stdout?: string; stderr?: string }>;
    network?: "online" | "offline";
    persistentDataDisk?: boolean;
    /** Known up front instead of probed. */
    knownNetwork?: "online" | "offline" | "unknown";
    /** Answer of the real default probe, when the harness is told to use it. */
    defaultProbeAnswer?: { exitCode?: number; stdout?: string; stderr?: string };
    /** Use the shipped probe instead of the simple test one. */
    realProbe?: boolean;
    warmupError?: Error;
  } = {},
): Promise<Harness> {
  const warmups = options.warmups ?? [{ stdout: "v26.13.1\n11.20.0\n" }];
  let warmupIndex = 0;

  const handlers: Record<string, FakeCommandHandler> = {
    [PROBE]: () =>
      options.cached
        ? { stdout: "v26.13.1\n" }
        : { stdout: "", stderr: "ls: not found\n", exitCode: 1 },
    [NETWORK]: () =>
      options.network === "offline"
        ? { stdout: "OFFLINE\n", exitCode: 1 }
        : { stdout: "ONLINE\n" },
    [DEFAULT_NETWORK_PROBE]: () => options.defaultProbeAnswer ?? { stdout: "ONLINE\n" },
    [WARMUP]: () => {
      if (options.warmupError) throw options.warmupError;
      const answer = warmups[Math.min(warmupIndex, warmups.length - 1)] as {
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      warmupIndex += 1;
      return answer;
    },
  };

  const environment = new FakeEnvironment({ handlers });
  await environment.initialize();

  const runtime = new RuntimeBootstrap({
    environment,
    persistentDataDisk: options.persistentDataDisk ?? true,
    retryDelayMs: 0,
    sleep: async () => undefined,
    now: () => 1_000,
    ...(options.realProbe ? {} : { networkCommand: NETWORK }),
    ...(options.knownNetwork ? { network: options.knownNetwork } : {}),
  });

  return {
    environment,
    runtime,
    commands: () =>
      environment.calls.filter((call) => call.method === "execute").map((call) => call.command),
  };
}

describe("warm-up ordering", () => {
  it("warms the runtime before an install or a build ever runs", async () => {
    const { runtime, commands } = await harness();

    await runtime.exec("npm install", { cwd: "/workspace" });
    await runtime.exec("npm run build");

    expect(commands()).toEqual([PROBE, NETWORK, WARMUP, "npm install", "npm run build"]);
    expect(runtime.snapshot()).toMatchObject({
      state: "ready",
      nodeVersion: "v26.13.1",
      npmVersion: "11.20.0",
    });
  });

  it("pays for the warm-up once, however many callers ask", async () => {
    const { runtime, commands } = await harness();

    await Promise.all([runtime.ensureReady(), runtime.ensureReady(), runtime.exec("npm ci")]);

    expect(commands().filter((command) => command === WARMUP)).toHaveLength(1);
  });
});

describe("the shim's exit 127", () => {
  it("retries once and succeeds, recording both attempts", async () => {
    const { runtime } = await harness({
      warmups: [
        {
          exitCode: 127,
          stderr: "node: needs libgcc_s.so.1, and installing it failed (apk add libgcc)\n",
        },
        { stdout: "v26.13.1\n11.20.0\n", stderr: "node: installing node 26.13.1\n" },
      ],
    });

    const snapshot = await runtime.ensureReady();

    expect(snapshot.state).toBe("ready");
    expect(snapshot.attempts.map((attempt) => attempt.exitCode)).toEqual([127, 0]);
    expect(snapshot.downloaded).toBe(true);
    expect(snapshot.reused).toBe(false);
  });

  it("gives up after the second failure, keeping the guest's own words", async () => {
    const { runtime, commands } = await harness({
      warmups: [{ exitCode: 127, stderr: "node: sudo apk add libgcc\n" }],
    });

    await expect(runtime.exec("npm install")).rejects.toThrow(/did not come up after 2 attempt/);
    expect(commands()).not.toContain("npm install");

    const snapshot = runtime.snapshot();
    expect(snapshot.state).toBe("failed");
    expect(snapshot.error).toContain("apk add libgcc");
    expect(snapshot.attempts).toHaveLength(2);
  });

  it("does not retry a hang, because a hang is not the shim's exit 127", async () => {
    const { ExecutionTimeoutError } = await import("@/env/environment-errors");
    const timeout = new ExecutionTimeoutError(300_000, {
      command: WARMUP,
      argv: ["/bin/sh", "-lc", WARMUP],
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: 9,
      durationMs: 300_000,
      truncated: false,
    });
    const { runtime } = await harness({ warmupError: timeout });

    await expect(runtime.ensureReady()).rejects.toBeInstanceOf(RuntimeBootstrapError);
    expect(runtime.snapshot().attempts).toHaveLength(1);
    expect(runtime.snapshot().error).toMatch(/Nothing was retried/);
  });
});

describe("the cache on the persistent data disk", () => {
  it("reuses a warm install instead of downloading again", async () => {
    const { runtime, commands } = await harness({ cached: true });

    const snapshot = await runtime.ensureReady();

    expect(commands()).toEqual([PROBE, WARMUP]);
    expect(commands()).not.toContain(NETWORK);
    expect(snapshot).toMatchObject({ state: "ready", reused: true, downloaded: false, cache: "persisted" });
  });

  it("says out loud when the install will be lost with the page", async () => {
    const { runtime } = await harness({ persistentDataDisk: false });

    const snapshot = await runtime.ensureReady();

    expect(snapshot.cache).toBe("session-only");
    expect(snapshot.warnings.join(" ")).toMatch(/not on a persistent data disk/);
  });

  it("leaves the cache decision unknown when the caller does not say", async () => {
    const environment = new FakeEnvironment({
      handlers: {
        [PROBE]: () => ({ stdout: "v26.13.1\n" }),
        [WARMUP]: () => ({ stdout: "v26.13.1\n11.20.0\n" }),
      },
    });
    await environment.initialize();
    const runtime = new RuntimeBootstrap({ environment, retryDelayMs: 0 });

    expect((await runtime.ensureReady()).cache).toBe("unknown");
  });
});

describe("commands this guest cannot run", () => {
  it("refuses apk with the measured reason and runs nothing", async () => {
    const { runtime, commands } = await harness();

    await expect(runtime.exec("apk add libgcc")).rejects.toThrow(/cannot run here/);
    await expect(runtime.exec("sudo apk add cmd:curl")).rejects.toThrow(RuntimeBootstrapError);
    expect(commands()).toEqual([]);
    expect(APK_RESTRICTION).toMatch(/package manager/);
  });

  it("does not refuse bun, because on Debian it installs and builds", async () => {
    // Measured in the guest: `bun --version` = 1.4.5, `bun install` exit 0 in 33 s,
    // `bun run build` exit 0 in 203 s with dist/ written. Refusing it here would make the
    // bootstrap contradict `detectRuntime`, which selects Bun when it answers.
    const { runtime, commands } = await harness();

    await expect(runtime.exec("bun install")).resolves.toBeDefined();
    expect(commands()).toContain("bun install");
    // The Alpine measurement is history, not a rule.
    expect(BUN_EXCLUSION.image).toBe("alpine");
    expect(BUN_EXCLUSION.exitCode).toBe(127);
  });

  it("states the Node-only runtime path for the docs", () => {
    expect(SUPPORTED_RUNTIME).toEqual({
      runtime: "node",
      packageManager: "npm",
      bundler: "vite/esbuild",
      bun: true,
    });
    const sentence = describeRuntimeSupport();
    expect(sentence).toContain("node");
    expect(sentence).toContain("vite/esbuild");
    expect(sentence).toContain("Bun usable");
    expect(sentence).toMatch(/apk and apt refuse/);
  });
});

describe("the guest's network", () => {
  it("does not start a download the guest cannot finish", async () => {
    const { runtime, commands } = await harness({ network: "offline" });

    await expect(runtime.ensureReady()).rejects.toThrow(/no internet/);
    expect(commands()).toEqual([PROBE, NETWORK]);
    expect(runtime.snapshot()).toMatchObject({ state: "failed", network: "offline" });
    expect(runtime.snapshot().error).toBe(OFFLINE_MESSAGE);
  });

  it("still serves a warm cache while offline", async () => {
    const { runtime } = await harness({ cached: true, knownNetwork: "offline" });

    expect(await runtime.ensureReady()).toMatchObject({ state: "ready", reused: true });
  });

  it("records that the network is up when the probe succeeds", async () => {
    const { runtime } = await harness({ network: "online" });

    expect((await runtime.ensureReady()).network).toBe("online");
  });

  it("does not depend on one downloader to answer at all", () => {
    // The Debian image has no `wget` (exit 127) and a real `/usr/bin/curl`; the Alpine
    // image is the other way round. A probe that names only one of them reported
    // "offline" for a guest whose network was fine, and stopped the warm-up in 5 s.
    expect(DEFAULT_NETWORK_PROBE).toContain("command -v curl");
    expect(DEFAULT_NETWORK_PROBE).toContain("command -v wget");
    // And when it has neither, it must say so rather than claim the guest is offline.
    expect(DEFAULT_NETWORK_PROBE).toContain("NO_PROBE");
  });

  it("warms up when the probe could not run, instead of calling that offline", async () => {
    const { runtime, commands } = await harness({
      realProbe: true,
      defaultProbeAnswer: { stdout: "NO_PROBE\n" },
    });

    expect(await runtime.ensureReady()).toMatchObject({ state: "ready", network: "unknown" });
    expect(commands()).toContain(WARMUP);
  });

  it("still stops when the probe reports a real failure", async () => {
    const { runtime, commands } = await harness({
      realProbe: true,
      defaultProbeAnswer: { stdout: "OFFLINE\n", exitCode: 1 },
    });

    await expect(runtime.ensureReady()).rejects.toThrow(OFFLINE_MESSAGE);
    expect(commands()).not.toContain(WARMUP);
  });
});

describe("parseRuntimeVersions", () => {
  it("reads the versions out of the shim's output", () => {
    expect(parseRuntimeVersions("v26.13.1\n11.20.0\n")).toEqual({
      nodeVersion: "v26.13.1",
      npmVersion: "11.20.0",
    });
  });

  it("reports nulls rather than inventing versions", () => {
    expect(parseRuntimeVersions("", "node: not found")).toEqual({
      nodeVersion: null,
      npmVersion: null,
    });
  });
});
