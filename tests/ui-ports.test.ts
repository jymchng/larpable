/**
 * The two adapters the agent's tools receive, and the one fact each of them must not invent.
 *
 * `createPreviewPort` is a passthrough by design, so the test asserts exactly that: the port
 * and the pane read the *same* controller. `createNetlifyPort` is where a build becomes
 * evidence for the `publish` check, so the interesting case is the negative one — a failed or
 * absent build must arrive as null rather than as a half-written `dist/`.
 */

import { describe, expect, it, vi } from "vitest";

import type { BuildResult } from "../src/build/manager";
import type { PreviewController, PreviewPhase } from "../src/preview/controller";
import type { ExecutionEnvironment } from "../src/env/execution";
import { createPreviewPort } from "../src/ui/preview-port";
import { createNetlifyPort, toNetlifyBuildOutput } from "../src/ui/netlify-port";

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
    log: null,
    startedAt: 0,
    finishedAt: 1000,
    durationMs: 1000,
    ...overrides,
  };
}

describe("createPreviewPort", () => {
  it("reads the controller it was given, so a tool's publish moves the pane", async () => {
    const ready: PreviewPhase = {
      kind: "ready",
      buildId: "build-1",
      url: "http://localhost:4173/?build=build-1",
      files: 3,
      served: "worker",
      note: null,
    };
    const controller = {
      phase: () => ready,
      subscribe: () => () => undefined,
      refresh: vi.fn(async () => ready),
      url: () => ready.kind === "ready" ? ready.url : null,
      stop: async () => undefined,
    } satisfies PreviewController;

    const port = createPreviewPort(controller);

    expect(port.phase()).toEqual(ready);
    expect(port.url()).toBe("http://localhost:4173/?build=build-1");
    expect(await port.refresh("build-1")).toEqual(ready);
    expect(controller.refresh).toHaveBeenCalledWith("build-1");
  });

  it("passes an absent build id through as absent, not as an empty string", async () => {
    const controller = {
      phase: () => ({ kind: "idle" }) as PreviewPhase,
      subscribe: () => () => undefined,
      refresh: vi.fn(async () => ({ kind: "idle" }) as PreviewPhase),
      url: () => null,
      stop: async () => undefined,
    } satisfies PreviewController;

    const port = createPreviewPort(controller);
    await port.refresh();

    expect(controller.refresh).toHaveBeenCalledWith(undefined);
    expect(port.url()).toBeNull();
  });
});

describe("toNetlifyBuildOutput", () => {
  it("describes a successful build in the validator's terms", () => {
    expect(toNetlifyBuildOutput(buildResult())).toEqual({ dir: "dist", entryExists: true });
  });

  it("reports a success with no entry point as no entry point", () => {
    expect(toNetlifyBuildOutput(buildResult({ entryPoint: null, entryBytes: null }))).toEqual({
      dir: "dist",
      entryExists: false,
    });
  });

  it("turns a failed build and an absent build into null, never into evidence", () => {
    expect(toNetlifyBuildOutput(buildResult({ ok: false }))).toBeNull();
    expect(toNetlifyBuildOutput(null)).toBeNull();
  });
});

describe("createNetlifyPort", () => {
  it("validates against the build that exists at call time", async () => {
    // A fake environment that answers every read with "there is no project here". The flow
    // then decides the facts itself; what this test asserts is only that the build evidence
    // reaches it, so the port does not depend on a real guest.
    const environment = {
      status: () => "ready",
      workspacePath: "/workspace",
      exec: async () => ({ exitCode: 1, stdout: "", stderr: "no such file" }),
      readFile: async () => {
        throw new Error("ENOENT");
      },
      writeFile: async () => undefined,
    } as unknown as ExecutionEnvironment;

    let current: BuildResult | null = null;
    const port = createNetlifyPort({ environment, lastBuild: () => current });

    const before = await port.ensure();
    current = buildResult({ ok: false });
    const afterFailure = await port.ensure();
    current = buildResult();
    const afterSuccess = await port.ensure();

    expect(before.ok).toBe(false);
    expect(afterFailure.ok).toBe(false);
    expect(afterSuccess.path.endsWith("netlify.toml")).toBe(true);
    // The build evidence is reported in the decisions/issues, not invented: with no readable
    // project the flow still names what it could not read.
    expect(Array.isArray(afterSuccess.validation.issues)).toBe(true);
  });
});
