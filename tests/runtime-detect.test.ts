/**
 * Runtime selection: Bun is *tried*, Node is *used*, and the reason is data.
 *
 * The acceptance criterion for this goal is "runtime selection/fallback". A test that
 * only asserted `runtime === "node"` would pass just as happily if the module never
 * probed Bun at all — which is exactly the claim the PRD (§7.1, Bun preferred if it
 * works) needs to be true. So each case asserts the probes that ran and the words the
 * fallback reason is built from.
 */

import { describe, expect, it } from "vitest";

import { ExecutionCancelledError, ExecutionTimeoutError } from "@/env/environment-errors";
import { FakeEnvironment, type FakeCommandHandler } from "@/env/fake-environment";
import {
  LOCKFILES,
  RuntimeDetectionError,
  describeRuntime,
  detectRuntime,
  installCommand,
} from "@/runtime/detect";

const BUN = "bun --version";
const NODE = "node --version";
const NPM = "npm --version";

interface Harness {
  environment: FakeEnvironment;
  commands(): string[];
}

async function harness(
  handlers: Record<string, FakeCommandHandler> = {},
): Promise<Harness> {
  const environment = new FakeEnvironment({ handlers });
  await environment.initialize();
  return {
    environment,
    commands: () =>
      environment.calls.filter((call) => call.method === "execute").map((call) => call.command),
  };
}

const answers = {
  bunOk: { [BUN]: () => ({ stdout: "1.3.13\n" }) },
  bunRejected: {
    [BUN]: () => ({
      exitCode: 127,
      stderr: "bun: error while loading shared libraries: libstdc++.so.6\n",
    }),
  },
  nodeOk: { [NODE]: () => ({ stdout: "v26.13.1\n" }) },
  npmOk: { [NPM]: () => ({ stdout: "11.20.0\n" }) },
};

describe("selecting Bun", () => {
  it("uses Bun when Bun actually answers, and probes nothing else", async () => {
    const { environment, commands } = await harness({ ...answers.bunOk, ...answers.nodeOk });

    const info = await detectRuntime(environment);

    expect(commands()).toEqual([BUN]);
    expect(info).toMatchObject({
      runtime: "bun",
      version: "1.3.13",
      packageManager: "bun",
      packageManagerVersion: "1.3.13",
      fallbackReason: null,
    });
    expect(info.probes).toHaveLength(1);
  });

  it("does not probe Bun when the caller says not to", async () => {
    const { environment, commands } = await harness({ ...answers.bunOk, ...answers.nodeOk, ...answers.npmOk });

    const info = await detectRuntime(environment, { preferBun: false });

    expect(commands()).toEqual([NODE, NPM]);
    expect(info.runtime).toBe("node");
    expect(info.fallbackReason).toBeNull();
  });
});

describe("falling back to Node", () => {
  it("records why Bun was rejected, quoting its exit code and its own words", async () => {
    const { environment, commands } = await harness({
      ...answers.bunRejected,
      ...answers.nodeOk,
      ...answers.npmOk,
    });

    const info = await detectRuntime(environment);

    expect(commands()).toEqual([BUN, NODE, NPM]);
    expect(info.runtime).toBe("node");
    expect(info.packageManager).toBe("npm");
    expect(info.version).toBe("v26.13.1");
    expect(info.packageManagerVersion).toBe("11.20.0");
    expect(info.fallbackReason).toContain("exited 127");
    expect(info.fallbackReason).toContain("libstdc++");
    expect(info.fallbackReason).toContain("Using Node + npm instead");
    expect(info.probes.map((probe) => probe.ok)).toEqual([false, true, true]);
  });

  it("falls back when the Bun probe cannot run at all", async () => {
    const { environment } = await harness({
      [BUN]: () => {
        throw new Error("spawn failed: no such file");
      },
      ...answers.nodeOk,
      ...answers.npmOk,
    });

    const info = await detectRuntime(environment);

    expect(info.probes[0]).toMatchObject({ ok: false, exitCode: null });
    expect(info.fallbackReason).toContain("could not run");
    expect(info.fallbackReason).toContain("spawn failed");
  });

  it("reports npm's absence as a null version rather than failing the whole detection", async () => {
    const { environment } = await harness({
      ...answers.bunRejected,
      ...answers.nodeOk,
      [NPM]: () => ({ exitCode: 127, stderr: "npm: not found\n" }),
    });

    const info = await detectRuntime(environment);

    expect(info.runtime).toBe("node");
    expect(info.packageManagerVersion).toBeNull();
    expect(describeRuntime(info)).toContain("npm");
    expect(describeRuntime(info)).not.toContain("npm 11");
  });

  it("does not treat half a version string as a working runtime", async () => {
    const { environment } = await harness({
      ...answers.bunRejected,
      [NODE]: () => ({ stdout: "node: installing node 26.13.1\n", exitCode: 127 }),
    });

    await expect(detectRuntime(environment)).rejects.toBeInstanceOf(RuntimeDetectionError);
  });
});

describe("when there is no runtime at all", () => {
  it("throws with the probes it ran, and says how to fix it", async () => {
    const { environment } = await harness({
      [BUN]: () => ({ exitCode: 127, stderr: "bun: not found\n" }),
      [NODE]: () => ({ exitCode: 127, stderr: "node: not found\n" }),
    });

    const error = await detectRuntime(environment).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeDetectionError);
    expect((error as RuntimeDetectionError).probes).toHaveLength(2);
    expect((error as RuntimeDetectionError).message).toMatch(/Warm the runtime first/);
    expect((error as RuntimeDetectionError).message).toContain("node: not found");
  });

  it("survives a probe that blows its budget, keeping the timeout as the reason", async () => {
    const timeout = new ExecutionTimeoutError(20_000, {
      command: NODE,
      argv: ["/bin/sh", "-lc", NODE],
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: 9,
      durationMs: 20_000,
      truncated: false,
    });
    const { environment } = await harness({
      ...answers.bunRejected,
      [NODE]: () => {
        throw timeout;
      },
    });

    const error = await detectRuntime(environment).catch((caught: unknown) => caught);

    // Both probes failed, so there is no runtime to report: the failure has to be an
    // error, not a `RuntimeInfo` claiming `node` with a null version.
    expect(error).toBeInstanceOf(RuntimeDetectionError);
    expect((error as RuntimeDetectionError).probes[1]).toMatchObject({
      ok: false,
      exitCode: null,
    });
    expect((error as RuntimeDetectionError).probes[1]?.detail).toMatch(/timed out/);
  });
});

describe("install commands", () => {
  it("never spends the agent's log space on audit or funding text", () => {
    expect(installCommand("npm")).toBe("npm install --no-audit --no-fund");
    expect(installCommand("npm", { ci: true })).toBe("npm ci --no-audit --no-fund");
    expect(installCommand("bun")).toBe("bun install");
    expect(installCommand("bun", { ci: true })).toBe("bun install --frozen-lockfile");
  });

  it("knows the lockfiles of both managers", () => {
    expect(LOCKFILES.npm).toContain("package-lock.json");
    expect(LOCKFILES.bun).toContain("bun.lockb");
  });
});

describe("describeRuntime", () => {
  it("summarises the runtime, the manager and the Bun exclusion for the status bar", async () => {
    const { environment } = await harness({
      ...answers.bunRejected,
      ...answers.nodeOk,
      ...answers.npmOk,
    });

    const sentence = describeRuntime(await detectRuntime(environment));

    expect(sentence).toContain("Runtime: node v26.13.1, npm 11.20.0");
    expect(sentence).toContain("Bun is not used");
  });

  it("admits an unknown version instead of printing a fake one", () => {
    expect(
      describeRuntime({
        runtime: "node",
        version: null,
        packageManager: "npm",
        packageManagerVersion: null,
        fallbackReason: null,
        probes: [],
      }),
    ).toBe("Runtime: node (version unknown), npm.");
  });
});

describe("a cancelled probe", () => {
  it("propagates cancellation instead of pretending the runtime is missing", async () => {
    const cancelled = new ExecutionCancelledError({
      command: NODE,
      argv: ["/bin/sh", "-lc", NODE],
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: 9,
      durationMs: 10,
      truncated: false,
    });
    const { environment } = await harness({
      [BUN]: () => ({ exitCode: 127, stderr: "bun: not found\n" }),
      [NODE]: () => {
        throw cancelled;
      },
    });

    // `probe` deliberately swallows every error: it records "could not run" and lets the
    // caller decide. The decision here is to refuse, naming the cancellation in the
    // probes rather than reporting a runtime that never answered.
    const error = await detectRuntime(environment).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RuntimeDetectionError);
    expect((error as RuntimeDetectionError).probes[1]?.detail).toMatch(/cancelled/);
  });
});
