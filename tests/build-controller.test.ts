/**
 * The build as the app drives it: gated, published from the manager's own records, and
 * truthful about cancellation.
 *
 * Every assertion here is about a way this object could lie: a status that says "building"
 * after the manager already answered, a success published from a failure, or a cancellation
 * reported as a failure the user never saw. The stub manager is deliberately not a real
 * `BuildManager` — no kernel, no 147 s npm install — but its results are real
 * `BuildResult`/`InstallResult` values, so the shapes under test are the real ones.
 */

import { describe, expect, it } from "vitest";

import type { BuildResult, InstallResult } from "../src/build/manager";
import { createBuildController, type WarmGate } from "../src/ui/build-controller";
import type { BuildPort } from "../src/agent/tools/types";
import type { BuildStatus } from "../src/ui/build-state";

function commandLog() {
  return {
    command: "npm run build",
    exitCode: 0,
    durationMs: 10,
    stdout: "",
    stderr: "",
    truncated: false,
  };
}

function buildResult(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    id: "build-1",
    ok: true,
    command: "npm run build",
    commandSource: "scripts.build",
    reason: "package.json has a build script.",
    outputDir: "dist",
    outputSource: "vite-config",
    entryPoint: "dist/index.html",
    entryBytes: 1024,
    failure: null,
    log: commandLog(),
    startedAt: 0,
    finishedAt: 1000,
    durationMs: 1000,
    ...overrides,
  };
}

function installResult(overrides: Partial<InstallResult> = {}): InstallResult {
  return {
    ok: true,
    log: commandLog(),
    command: "npm ci --no-audit --no-fund",
    packageManager: "npm",
    lockfile: "package-lock.json",
    failure: null,
    note: null,
    ...overrides,
  };
}

/** A manager whose answers are chosen by the test, and whose calls are counted. */
function stubManager(options: {
  installs?: InstallResult[];
  builds?: BuildResult[];
  onBuild?: () => void;
}) {
  const installs = [...(options.installs ?? [installResult()])];
  const builds = [...(options.builds ?? [buildResult()])];
  const calls = { install: 0, build: 0 };
  const manager: BuildPort = {
    packageManager: "npm",
    runtimeNote: null,
    async install() {
      calls.install += 1;
      const next = installs.shift() ?? installResult();
      return next;
    },
    async build() {
      calls.build += 1;
      options.onBuild?.();
      const next = builds.shift() ?? buildResult();
      return next;
    },
    lastSuccessfulBuild: () => buildResult(),
    history: () => [buildResult()],
  };
  return { manager, calls };
}

function collect(controller: { subscribe(fn: (status: BuildStatus) => void): () => void }) {
  const seen: BuildStatus[] = [];
  controller.subscribe((status) => seen.push(status));
  return seen;
}

describe("createBuildController", () => {
  it("starts as `none` and says so", () => {
    const { manager } = stubManager({});
    const controller = createBuildController({ manager });
    expect(controller.status()).toEqual({ kind: "none" });
    expect(controller.busy()).toBe(false);
  });

  it("publishes installing, then building, then the build's own id", async () => {
    const { manager } = stubManager({});
    const controller = createBuildController({ manager });
    const seen = collect(controller);

    await controller.run();

    expect(seen).toEqual([
      { kind: "running", stage: "installing" },
      { kind: "running", stage: "building" },
      { kind: "ok", id: "build-1", durationMs: 1000 },
    ]);
    expect(controller.status()).toEqual({ kind: "ok", id: "build-1", durationMs: 1000 });
  });

  it("publishes a failure from the guest's own detail, never as a success", async () => {
    const { manager } = stubManager({
      builds: [
        buildResult({
          id: "build-2",
          ok: false,
          entryPoint: null,
          entryBytes: null,
          failure: { kind: "compile", summary: "TypeScript did not compile.", detail: "src/main.ts(3,1): error TS2322", hint: "Fix the type." },
        }),
      ],
    });
    const controller = createBuildController({ manager });

    const result = await controller.build();

    expect(result.ok).toBe(false);
    expect(controller.status()).toEqual({
      kind: "failed",
      summary: "src/main.ts(3,1): error TS2322",
    });
  });

  it("does not call onBuilt for a failed build", async () => {
    const { manager } = stubManager({
      builds: [buildResult({ ok: false, failure: { kind: "unknown", summary: "It broke.", detail: "", hint: "Look." } })],
    });
    const ids: string[] = [];
    const controller = createBuildController({ manager, onBuilt: (result) => ids.push(result.id) });

    await controller.build();

    expect(ids).toEqual([]);
  });

  it("calls onBuilt with the successful result, so the preview can use its id", async () => {
    const { manager } = stubManager({});
    const ids: string[] = [];
    const controller = createBuildController({ manager, onBuilt: (result) => ids.push(result.id) });

    await controller.build();

    expect(ids).toEqual(["build-1"]);
  });

  it("stops after a failed install and never runs the build", async () => {
    const { manager, calls } = stubManager({
      installs: [
        installResult({
          ok: false,
          failure: { kind: "network", summary: "The registry could not be reached.", detail: "ECONNREFUSED registry.npmjs.org", hint: "Check the network." },
        }),
      ],
    });
    const controller = createBuildController({ manager });

    const status = await controller.run();

    expect(calls.build).toBe(0);
    expect(status).toEqual({ kind: "failed", summary: "ECONNREFUSED registry.npmjs.org" });
  });

  it("names the install command when an install fails without a reason", async () => {
    const { manager } = stubManager({
      installs: [installResult({ ok: false, failure: null, command: "npm ci" })],
    });
    const controller = createBuildController({ manager });

    const status = await controller.install();

    expect(status.ok).toBe(false);
    expect(controller.status()).toEqual({
      kind: "failed",
      summary: "the install failed without a recorded reason (npm ci)",
    });
  });

  it("pays the warm-runtime gate before the manager runs, with the run's signal", async () => {
    const order: string[] = [];
    const gates: { signal?: AbortSignal }[] = [];
    const runtime: WarmGate = {
      async ensureReady(options = {}) {
        order.push("gate");
        gates.push(options);
        return null;
      },
    };
    const { manager } = stubManager({ onBuild: () => order.push("build") });
    const controller = createBuildController({ manager, runtime });

    await controller.build();

    expect(order).toEqual(["gate", "build"]);
    expect(gates).toHaveLength(1);
    expect(gates[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("restores the status implied by history when a run throws", async () => {
    const manager: BuildPort = {
      packageManager: "npm",
      runtimeNote: null,
      install: async () => installResult(),
      build: async () => {
        throw new Error("the guest went away");
      },
      lastSuccessfulBuild: () => buildResult(),
      history: () => [buildResult({ id: "build-7" })],
    };
    const controller = createBuildController({ manager });

    await expect(controller.build()).rejects.toThrow("the guest went away");
    expect(controller.status()).toEqual({ kind: "ok", id: "build-7", durationMs: 1000 });
    expect(controller.busy()).toBe(false);
  });

  it("treats a cancellation as no verdict: the last completed attempt stands", async () => {
    const manager: BuildPort = {
      packageManager: "npm",
      runtimeNote: null,
      install: async () => installResult(),
      build: (options = {}) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
      lastSuccessfulBuild: () => buildResult(),
      history: () => [buildResult({ id: "build-9" })],
    };
    const controller = createBuildController({ manager });

    const running = controller.build();
    await Promise.resolve();
    expect(controller.busy()).toBe(true);
    controller.cancel();

    await expect(running).rejects.toThrow();
    expect(controller.status()).toEqual({ kind: "ok", id: "build-9", durationMs: 1000 });
    expect(controller.busy()).toBe(false);
  });

  it("is idle-safe: cancel with nothing running changes nothing", () => {
    const { manager } = stubManager({});
    const controller = createBuildController({ manager });

    expect(() => controller.cancel()).not.toThrow();
    expect(controller.status()).toEqual({ kind: "none" });
  });

  it("exposes the manager's history and last build to the tools", () => {
    const { manager } = stubManager({});
    const controller = createBuildController({ manager });

    expect(controller.history()).toHaveLength(1);
    expect(controller.lastSuccessfulBuild()?.id).toBe("build-1");
  });
});
