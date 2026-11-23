/**
 * The six facts, and the rule that keeps the bar from lying.
 *
 * Each segment is green only when its *own* source says so. These tests are written as pairs
 * of that rule: a ready machine with no build is not a green build; a live preview does not
 * turn a failed build green; an amber preview is not a green one.
 */

import { describe, expect, it } from "vitest";

import type { EnvironmentSnapshot } from "../src/env/status";
import { INITIAL_ENVIRONMENT } from "../src/env/status";
import type { PreviewPhase } from "../src/preview/controller";
import {
  deriveStatusSegments,
  netlifyStatusFrom,
  summarizeStatus,
  type StatusInput,
  type StatusKey,
  type StatusSegment,
} from "../src/ui/status-bar";

const readyEnvironment: EnvironmentSnapshot = {
  status: "ready",
  runtime: "node 22.9.0",
  distro: "debian",
  cpus: 4,
  memoryMiB: 2048,
  error: null,
};

const livePreview: PreviewPhase = {
  kind: "ready",
  buildId: "build-mf3k2-1",
  url: "/__preview__/build-mf3k2-1/",
  files: 14,
  served: "worker",
  note: null,
};

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    environment: readyEnvironment,
    project: { name: "my-site", root: "/workspace" },
    build: { kind: "none" },
    netlify: { kind: "unknown" },
    preview: { kind: "idle" },
    ...overrides,
  };
}

function segment(overrides: Partial<StatusInput>, key: StatusKey): StatusSegment {
  const found = deriveStatusSegments(input(overrides)).find((candidate) => candidate.key === key);
  if (found === undefined) throw new Error(`no ${key} segment`);
  return found;
}

describe("deriveStatusSegments", () => {
  it("always renders exactly the six facts, in order", () => {
    expect(deriveStatusSegments(input()).map((entry) => entry.key)).toEqual([
      "linux",
      "runtime",
      "project",
      "build",
      "netlify",
      "preview",
    ]);
  });

  it("is grey everywhere before anything has happened", () => {
    const segments = deriveStatusSegments(input({ environment: INITIAL_ENVIRONMENT, project: null }));
    expect(segments.map((entry) => entry.tone)).toEqual(["grey", "grey", "grey", "grey", "grey", "grey"]);
  });
});

describe("the Linux and runtime segments", () => {
  it("are green only when the adapter reports ready", () => {
    expect(segment({}, "linux")).toMatchObject({ value: "Ready", tone: "green" });
    expect(segment({}, "runtime")).toMatchObject({ value: "node 22.9.0", tone: "green" });
  });

  it("are amber while booting and red on error", () => {
    const booting: EnvironmentSnapshot = { ...INITIAL_ENVIRONMENT, status: "booting" };
    expect(segment({ environment: booting }, "linux").tone).toBe("amber");

    const failed: EnvironmentSnapshot = { ...INITIAL_ENVIRONMENT, status: "error", error: "wasm rejected" };
    expect(segment({ environment: failed }, "linux")).toMatchObject({ tone: "red" });
    expect(segment({ environment: failed }, "runtime").tone).toBe("red");
    expect(segment({ environment: failed }, "linux").detail).toContain("wasm rejected");
  });

  it("says a runtime is not detected rather than naming one", () => {
    expect(segment({ environment: { ...readyEnvironment, runtime: null } }, "runtime")).toMatchObject({
      value: "not detected",
      tone: "grey",
    });
  });
});

describe("the project segment", () => {
  it("is grey and says none when no project is open", () => {
    expect(segment({ project: null }, "project")).toMatchObject({ value: "none", tone: "grey" });
  });

  it("names the project and points at its root", () => {
    const found = segment({}, "project");
    expect(found).toMatchObject({ value: "my-site", tone: "green" });
    expect(found.detail).toContain("/workspace");
  });
});

describe("the build segment", () => {
  it("is grey for no build, amber while running, green on an id, red on failure", () => {
    expect(segment({}, "build")).toMatchObject({ value: "none", tone: "grey" });
    expect(segment({ build: { kind: "running", stage: "building" } }, "build")).toMatchObject({
      value: "building",
      tone: "amber",
    });
    expect(segment({ build: { kind: "ok", id: "build-1", durationMs: 1000 } }, "build")).toMatchObject({
      value: "build-1",
      tone: "green",
    });
    expect(segment({ build: { kind: "failed", summary: "TS2307" } }, "build")).toMatchObject({
      value: "failed",
      tone: "red",
    });
  });

  it("keeps a failed build red even while the old preview is still live", () => {
    const failedBuild = segment({ build: { kind: "failed", summary: "TS2307" }, preview: livePreview }, "build");
    expect(failedBuild.tone).toBe("red");
    expect(segment({ preview: livePreview }, "preview").tone).toBe("green");
  });
});

describe("the Netlify segment", () => {
  it("is grey until something has been validated", () => {
    expect(segment({}, "netlify")).toMatchObject({ value: "not validated", tone: "grey" });
  });

  it("is green only for a validation with no errors", () => {
    expect(segment({ netlify: { kind: "ok" } }, "netlify")).toMatchObject({ value: "valid", tone: "green" });
  });

  it("counts the errors on an invalid config", () => {
    expect(segment({ netlify: { kind: "invalid", errors: ["no publish dir", "bad build"] } }, "netlify")).toMatchObject({
      value: "2 errors",
      tone: "red",
    });
    expect(segment({ netlify: { kind: "invalid", errors: ["no publish dir"] } }, "netlify").value).toBe("1 error");
  });
});

describe("the preview segment", () => {
  it("is grey when nothing has been published, amber while starting or publishing", () => {
    expect(segment({}, "preview")).toMatchObject({ value: "none", tone: "grey" });
    expect(segment({ preview: { kind: "starting", detail: "Starting the guest's server." } }, "preview")).toMatchObject({
      value: "starting",
      tone: "amber",
    });
    expect(segment({ preview: { kind: "publishing", buildId: "build-1", detail: "Copying dist/." } }, "preview")).toMatchObject({
      value: "publishing",
      tone: "amber",
    });
  });

  it("is green only when the worker is serving it, amber when the guest serves on demand", () => {
    expect(segment({ preview: livePreview }, "preview")).toMatchObject({
      value: "build-mf3k2-1",
      tone: "green",
    });
    const guestServed: PreviewPhase = { ...livePreview, served: "guest", note: "the guest answered slowly" };
    expect(segment({ preview: guestServed }, "preview").tone).toBe("amber");
    expect(segment({ preview: guestServed }, "preview").detail).toContain("the guest answered slowly");
  });

  it("is red when publishing failed, carrying the message", () => {
    expect(segment({ preview: { kind: "failed", message: "dist/index.html is missing" } }, "preview")).toMatchObject({
      value: "failed",
      tone: "red",
    });
  });
});

describe("summarizeStatus", () => {
  it("is one sentence naming every fact and its value", () => {
    expect(summarizeStatus(deriveStatusSegments(input()))).toBe(
      "Linux: Ready · Runtime: node 22.9.0 · Project: my-site · Build: none · Netlify: not validated · Preview: none",
    );
  });
});

describe("netlifyStatusFrom", () => {
  it("stays unknown until a validation was actually attempted", () => {
    expect(netlifyStatusFrom({ attempted: false, ok: false, errors: [] })).toEqual({ kind: "unknown" });
  });

  it("carries the verdict and the errors", () => {
    expect(netlifyStatusFrom({ attempted: true, ok: true, errors: [] })).toEqual({ kind: "ok" });
    expect(netlifyStatusFrom({ attempted: true, ok: false, errors: ["nope"] })).toEqual({
      kind: "invalid",
      errors: ["nope"],
    });
  });
});
