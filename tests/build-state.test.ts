/**
 * The four build states, and the two ways they must not lie.
 *
 * `src/ui/build-state.ts` is the only place a build result becomes something a pane can show,
 * so the properties worth asserting are negative ones: an install after a success is not a
 * success, a failure cannot be folded into an `ok`, and an empty history is `none` rather than
 * either verdict.
 */

import { describe, expect, it } from "vitest";

import type { BuildResult } from "../src/build/manager";
import {
  applyBuildProgress,
  buildStatusFromHistory,
  describeBuildProgress,
  initialBuild,
  summarizeBuildFailure,
} from "../src/ui/build-state";

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

describe("initialBuild", () => {
  it("starts as `none` — not as a success and not as a failure", () => {
    expect(initialBuild()).toEqual({ kind: "none" });
  });

  it("says nothing at all before the first build", () => {
    // "No build has run yet." was removed on request: the strip's own hammer says what it would
    // do, and the line is not rendered when the answer is empty.
    expect(describeBuildProgress(initialBuild())).toBe("");
  });
});

describe("applyBuildProgress", () => {
  it("reports installing and building as running, with the stage named", () => {
    expect(applyBuildProgress(initialBuild(), { kind: "installing" })).toEqual({
      kind: "running",
      stage: "installing",
    });
    expect(applyBuildProgress(initialBuild(), { kind: "building" })).toEqual({
      kind: "running",
      stage: "building",
    });
  });

  it("carries the build id and duration from a real success", () => {
    expect(applyBuildProgress(initialBuild(), { kind: "built", id: "build-mf3k2-1", durationMs: 4200 })).toEqual({
      kind: "ok",
      id: "build-mf3k2-1",
      durationMs: 4200,
    });
  });

  it("turns a success into a running rebuild rather than keeping the green", () => {
    const ok = applyBuildProgress(initialBuild(), { kind: "built", id: "build-1", durationMs: 10 });
    expect(applyBuildProgress(ok, { kind: "installing" }).kind).toBe("running");
  });

  it("cannot promote a failure without a new `built` event", () => {
    const failed = applyBuildProgress(initialBuild(), { kind: "failed", summary: "TS2307" });
    expect(failed).toEqual({ kind: "failed", summary: "TS2307" });
    expect(applyBuildProgress(failed, { kind: "building" }).kind).toBe("running");
  });

  it("forgets the build on reset", () => {
    const ok = applyBuildProgress(initialBuild(), { kind: "built", id: "build-1", durationMs: 10 });
    expect(applyBuildProgress(ok, { kind: "reset" })).toEqual({ kind: "none" });
  });
});

describe("buildStatusFromHistory", () => {
  it("is `none` when nothing has been attempted", () => {
    expect(buildStatusFromHistory([])).toEqual({ kind: "none" });
  });

  it("takes the newest attempt, so a failed rebuild after a success is a failure", () => {
    const ok = buildResult({ id: "build-1", ok: true });
    const failed = buildResult({
      id: "build-2",
      ok: false,
      failure: { kind: "compile", summary: "The build failed.", detail: "TS2307: cannot find module", hint: "Fix the import." },
    });
    expect(buildStatusFromHistory([ok])).toEqual({ kind: "ok", id: "build-1", durationMs: 1000 });
    expect(buildStatusFromHistory([ok, failed])).toEqual({ kind: "failed", summary: "TS2307: cannot find module" });
  });

  it("takes a successful rebuild after a failure as the current verdict", () => {
    const failed = buildResult({ id: "build-1", ok: false, failure: { kind: "compile", summary: "s", detail: "d", hint: "h" } });
    expect(buildStatusFromHistory([failed, buildResult({ id: "build-2", ok: true })]).kind).toBe("ok");
  });
});

describe("summarizeBuildFailure", () => {
  it("is empty for a success, so it cannot be rendered as an error", () => {
    expect(summarizeBuildFailure(buildResult())).toBe("");
  });

  it("prefers the guest's detail and falls back to the failure kind", () => {
    expect(
      summarizeBuildFailure(
        buildResult({ ok: false, failure: { kind: "compile", summary: "s", detail: "TS2307", hint: "h" } }),
      ),
    ).toBe("TS2307");
    expect(
      summarizeBuildFailure(
        buildResult({ ok: false, failure: { kind: "compile", summary: "s", detail: "  ", hint: "h" } }),
      ),
    ).toBe("compile");
  });

  it("says a failure has no recorded reason instead of inventing one", () => {
    expect(summarizeBuildFailure(buildResult({ ok: false, failure: null }))).toBe(
      "the build failed without a recorded reason",
    );
  });
});

describe("describeBuildProgress", () => {
  it("names the stage while it runs", () => {
    expect(describeBuildProgress({ kind: "running", stage: "installing" })).toBe(
      "Installing dependencies in the guest…",
    );
    expect(describeBuildProgress({ kind: "running", stage: "building" })).toBe(
      "Building the site in the guest…",
    );
  });

  it("names the build and its duration on success, and the reason on failure", () => {
    expect(describeBuildProgress({ kind: "ok", id: "build-1", durationMs: 4200 })).toBe(
      "Build build-1 succeeded in 4.2 s.",
    );
    expect(describeBuildProgress({ kind: "ok", id: "build-1", durationMs: null })).toBe(
      "Build build-1 succeeded.",
    );
    expect(describeBuildProgress({ kind: "failed", summary: "TS2307" })).toBe(
      "The build failed: TS2307",
    );
  });
});
