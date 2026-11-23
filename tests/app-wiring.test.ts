/**
 * The shell's wiring, asserted without a browser.
 *
 * `src/ui/App.tsx` is the one file that knows the four objects a session needs exist: the booted
 * environment, the build controller, the Netlify port and the preview controller. It has no test
 * \u2014 it cannot have one, because it boots a kernel \u2014 so the wiring it performs is reproduced
 * here, in the same order, against the same real pieces:
 *
 *   build controller (real `BuildManager` in the app) \u2192 onBuilt \u2192 preview.refresh(build id)
 *   netlify port, reading the build at call time   \u2192 onVerdict \u2192 status bar segment
 *
 * The value of doing it here is that the seams are addresses, not prose: if `onBuilt` stopped
 * being called, if the preview were refreshed without an id, if the Netlify port read the build
 * at construction, or if the status bar were fed a hard-coded `unknown`, one of these tests fails.
 * What it does *not* prove is that `App.tsx` calls these constructors \u2014 that is why the default
 * factories in `use-build.ts` are exported and asserted to build the real objects rather than a
 * stub, which is the closest a non-browser test can get to "the shell owns a build".
 */

import { describe, expect, it } from "vitest";

import type { BuildPort } from "@/agent/tools/types";
import { BuildManager, type BuildResult, type InstallResult } from "@/build/manager";
import { FakeEnvironment } from "@/env/fake-environment";
import { INITIAL_ENVIRONMENT } from "@/env/status";
import type { PreviewController, PreviewPhase } from "@/preview/controller";
import { RuntimeBootstrap } from "@/runtime/bootstrap";
import { createBuildController } from "@/ui/build-controller";
import { createNetlifyPort } from "@/ui/netlify-port";
import { createPreviewPort } from "@/ui/preview-port";
import { defaultBuildManager, defaultBuildRuntime } from "@/ui/use-build";
import { deriveStatusSegments, type NetlifyStatus } from "@/ui/status-bar";
import { NO_TERMINAL } from "../src/ui/terminal-connection";

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
    id: "build-7",
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

/** A manager whose answers the test chooses, and whose successful build it can report. */
function stubManager(options: { build?: BuildResult } = {}) {
  const installed = installResult();
  const built = options.build ?? buildResult();
  const history: BuildResult[] = [];
  const manager: BuildPort = {
    packageManager: "npm",
    runtimeNote: null,
    install: async () => installed,
    build: async () => {
      history.push(built);
      return built;
    },
    lastSuccessfulBuild: () => history.filter((result) => result.ok).at(-1) ?? null,
    history: () => history,
  };
  return { manager, history };
}

/** The preview controller, narrowed to what the wiring touches, recording its refreshes. */
function stubPreview() {
  const refreshed: (string | undefined)[] = [];
  const phase: PreviewPhase = { kind: "idle" };
  const controller: PreviewController = {
    phase: () => phase,
    subscribe: () => () => undefined,
    refresh: async (buildId?: string) => {
      refreshed.push(buildId);
      return phase;
    },
    attach: async () => phase,
    url: () => null,
    stop: async () => undefined,
  };
  return { controller, refreshed };
}

const PACKAGE = JSON.stringify({
  name: "site",
  scripts: { build: "vite build" },
  dependencies: { react: "^18" },
});

const VITE_REACT_TREE = {
  "package.json": PACKAGE,
  "vite.config.ts": "export default {};",
  "index.html": "<div id=app>",
  "src/main.tsx": "export {};",
};

async function environment(tree: Record<string, string> = VITE_REACT_TREE) {
  const env = new FakeEnvironment({ tree });
  await env.initialize();
  return env;
}

describe("the objects the app shell builds", () => {
  it("are the real manager and the real warm-runtime gate, not stubs", async () => {
    const env = await environment();

    expect(defaultBuildManager(env, undefined)).toBeInstanceOf(BuildManager);
    expect(defaultBuildRuntime(env)).toBeInstanceOf(RuntimeBootstrap);
  });

  it("installs with Bun, because that is what the guest was measured to run", async () => {
    const env = await environment();

    const manager = defaultBuildManager(env, undefined);

    expect(manager.packageManager).toBe("bun");
    expect(manager.runtimeNote).toBeNull();
  });

  it("still works on an image without Bun: the pane's manager may fall back, and says why", async () => {
    const env = await environment();
    // The un-scripted `bun install` answers 127, which is the guest saying "no bun here".
    env.script("npm install --no-audit --no-fund", {
      stdout: "added 84 packages, and audited 85 packages in 5s\n",
      durationMs: 5_000,
    });
    const manager = defaultBuildManager(env, undefined);

    const result = await manager.install();

    expect(result.ok).toBe(true);
    expect(result.packageManager).toBe("npm");
    expect(result.note).toContain("no usable `bun`");
    // The fallback is recorded, not hidden: the tool that refuses after it reads this.
    expect(manager.packageManager).toBe("npm");
    expect(manager.runtimeNote).toContain("npm installed the dependencies instead");
  });
});

describe("build \u2192 preview", () => {
  it("refreshes the preview with the id the manager recorded, so the frame serves those bytes", async () => {
    const { manager } = stubManager();
    const preview = stubPreview();
    const previewPort = createPreviewPort(preview.controller);

    const build = createBuildController({
      manager,
      onBuilt: (result) => void previewPort.refresh(result.id),
    });

    await build.run();

    expect(build.status()).toEqual({ kind: "ok", id: "build-7", durationMs: 1000 });
    expect(preview.refreshed).toEqual(["build-7"]);
  });

  it("never refreshes the preview from a failed build", async () => {
    const { manager } = stubManager({ build: buildResult({ ok: false, failure: null }) });
    const preview = stubPreview();
    const previewPort = createPreviewPort(preview.controller);

    const build = createBuildController({
      manager,
      onBuilt: (result) => void previewPort.refresh(result.id),
    });

    await build.run();

    expect(build.status().kind).toBe("failed");
    expect(preview.refreshed).toEqual([]);
    expect(build.lastSuccessfulBuild()).toBeNull();
  });
});

describe("netlify \u2192 status bar", () => {
  it("turns the segment green for a run whose file validated, against the build that exists", async () => {
    const env = await environment();
    const { manager } = stubManager();
    const build = createBuildController({ manager });
    await build.run();

    const verdicts: NetlifyStatus[] = [];
    let buildReads = 0;
    const netlify = createNetlifyPort({
      environment: env,
      lastBuild: () => {
        buildReads += 1;
        return build.lastSuccessfulBuild();
      },
      onVerdict: (verdict) => verdicts.push(verdict),
    });

    const result = await netlify.ensure();

    expect(result.ok).toBe(true);
    expect(buildReads).toBe(1);
    expect(verdicts).toEqual([{ kind: "ok" }]);

    const segments = deriveStatusSegments({
      environment: INITIAL_ENVIRONMENT,
      project: { name: null, root: "/workspace" },
      build: build.status(),
      netlify: verdicts[0] ?? { kind: "unknown" },
      preview: { kind: "idle" },
      terminal: NO_TERMINAL,
    });

    expect(segments.find((segment) => segment.key === "build")).toMatchObject({
      value: "build-7",
      tone: "green",
    });
    expect(segments.find((segment) => segment.key === "netlify")).toMatchObject({
      value: "valid",
      tone: "green",
    });
  });

  it("says `not validated` before any run, and red after a run that could not justify a config", async () => {
    const before = deriveStatusSegments({
      environment: INITIAL_ENVIRONMENT,
      project: { name: null, root: "/workspace" },
      build: { kind: "none" },
      netlify: { kind: "unknown" },
      preview: { kind: "idle" },
      terminal: NO_TERMINAL,
    });
    expect(before.find((segment) => segment.key === "netlify")).toMatchObject({
      value: "not validated",
      tone: "grey",
    });

    const empty = await environment({ "README.md": "nothing to deploy" });
    const verdicts: NetlifyStatus[] = [];
    const netlify = createNetlifyPort({
      environment: empty,
      lastBuild: () => null,
      onVerdict: (verdict) => verdicts.push(verdict),
    });
    await netlify.ensure();

    const after = deriveStatusSegments({
      environment: INITIAL_ENVIRONMENT,
      project: { name: null, root: "/workspace" },
      build: { kind: "none" },
      netlify: verdicts[0] ?? { kind: "unknown" },
      preview: { kind: "idle" },
      terminal: NO_TERMINAL,
    });
    expect(after.find((segment) => segment.key === "netlify")?.tone).toBe("red");
  });
});
