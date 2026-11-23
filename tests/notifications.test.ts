/**
 * Every notification the app can produce, and the colour it gets.
 *
 * This is the file that answers "ALL NOTIFICATIONS SHOULD BE TOASTS IN APPROPRIATE COLORS" in a
 * way a later refactor cannot quietly undo: for each source there is a state that produces a
 * toast with a named tone, and a state that produces nothing at all. The tones are asserted, not
 * merely described — a build that fails in blue would fail here.
 */

import { describe, expect, it } from "vitest";

import { INITIAL_ENVIRONMENT, type EnvironmentSnapshot } from "../src/env/status";
import type { PreviewPhase } from "../src/preview/controller";
import type { BuildStatus } from "../src/ui/build-state";
import { notificationsFor, type NotificationInput } from "../src/ui/notifications";
import type { AppPreviewState } from "../src/ui/use-app-preview";
import type { NetlifyStatus } from "../src/ui/status-bar";

/**
 * A machine nobody has booted, and nothing else happening: the quiet baseline every case starts
 * from. `idle` rather than `ready` on purpose — "Linux is ready." is itself a notification, and a
 * baseline that announced one would make every case below pass for the wrong reason.
 */
const quiet: NotificationInput = {
  environment: { ...INITIAL_ENVIRONMENT, status: "idle" },
  bootStage: null,
  build: { kind: "none" },
  preview: { kind: "idle" },
  app: undefined,
  netlify: { kind: "unknown" },
};

function notes(overrides: Partial<NotificationInput>): ReturnType<typeof notificationsFor> {
  return notificationsFor({ ...quiet, ...overrides });
}

/** The one notification for a source, or a useful failure. */
function only(overrides: Partial<NotificationInput>): { id: string; message: string; tone: string } {
  const found = notes(overrides);
  expect(found).toHaveLength(1);
  return found[0] as { id: string; message: string; tone: string };
}

const machine = (status: EnvironmentSnapshot["status"], error: string | null = null): EnvironmentSnapshot => ({
  ...INITIAL_ENVIRONMENT,
  status,
  error,
});

const build: Record<string, BuildStatus> = {
  installing: { kind: "running", stage: "installing" },
  building: { kind: "running", stage: "building" },
  ok: { kind: "ok", id: "build-3", durationMs: 4200 },
  failed: { kind: "failed", summary: "src/main.ts(3,1): error TS2322" },
};

const phases: Record<string, PreviewPhase> = {
  starting: { kind: "starting", detail: "Starting the guest's server…" },
  publishing: { kind: "publishing", buildId: "b-1", detail: "Reading 3 files out of the guest…" },
  failed: { kind: "failed", message: "There is no build to preview: dist/ is empty." },
};

const appStates: Record<string, AppPreviewState> = {
  starting: { kind: "starting", message: "Starting `bun run start` in the guest on port 3000…" },
  running: { kind: "running", buildId: "app-1", port: 3000, command: "bun run start", status: 200 },
  failed: { kind: "failed", message: "No `start` script in package.json." },
};

describe("the machine", () => {
  it("is blue while it boots, green when it is up, red when it is not", () => {
    expect(only({ environment: machine("booting"), bootStage: "rooting…" })).toMatchObject({
      id: "machine",
      tone: "info",
      message: "Starting the Linux machine: rooting…",
    });
    expect(only({ environment: machine("initializing") }).message).toBe("Starting the Linux machine…");
    expect(only({ environment: machine("ready") })).toMatchObject({
      tone: "success",
      message: "Linux is ready.",
    });
    expect(only({ environment: machine("error", "no shared memory") })).toMatchObject({
      tone: "danger",
      message: "The Linux machine could not start: no shared memory",
    });
  });

  it("still has something true to say when the failure carries no reason", () => {
    expect(only({ environment: machine("error", null) }).message).toBe(
      "The Linux machine could not start.",
    );
  });

  it("says nothing about a machine nobody has asked to start, or one the user stopped", () => {
    expect(notes({ environment: machine("idle") })).toEqual([]);
    expect(notes({ environment: machine("stopped") })).toEqual([]);
  });
});

describe("the build", () => {
  it("is blue in progress, green on success and red on failure, in the manager's own words", () => {
    expect(only({ build: build.installing as BuildStatus })).toMatchObject({
      id: "build",
      tone: "info",
      message: "Installing dependencies in the guest…",
    });
    expect(only({ build: build.building as BuildStatus })).toMatchObject({
      tone: "info",
      message: "Building the site in the guest…",
    });
    expect(only({ build: build.ok as BuildStatus })).toMatchObject({
      tone: "success",
      message: "Build build-3 succeeded in 4.2 s.",
    });
    expect(only({ build: build.failed as BuildStatus })).toMatchObject({
      tone: "danger",
      message: "The build failed: src/main.ts(3,1): error TS2322",
    });
  });

  it("says nothing before the first build", () => {
    expect(notes({ build: { kind: "none" } })).toEqual([]);
  });
});

describe("the preview", () => {
  it("is blue while a publish is prepared and red when it fails", () => {
    expect(only({ preview: phases.starting as PreviewPhase })).toMatchObject({ id: "preview", tone: "info" });
    expect(only({ preview: phases.publishing as PreviewPhase }).message).toBe(
      "Reading 3 files out of the guest…",
    );
    expect(only({ preview: phases.failed as PreviewPhase })).toMatchObject({
      tone: "danger",
      message: "The preview could not load: There is no build to preview: dist/ is empty.",
    });
  });

  it("does not cheer when a preview simply loads: the frame appearing is the announcement", () => {
    const ready: PreviewPhase = {
      kind: "ready",
      buildId: "b-1",
      url: "/__preview__/b-1/",
      files: 3,
      served: "worker",
      note: null,
    };
    expect(notes({ preview: ready })).toEqual([]);
    expect(notes({ preview: { kind: "idle" } })).toEqual([]);
  });
});

describe("the app server", () => {
  it("is blue when starting, green when it answers, red when it refuses", () => {
    expect(only({ app: appStates.starting })).toMatchObject({ id: "app", tone: "info" });
    expect(only({ app: appStates.running })).toMatchObject({
      tone: "success",
      message: "`bun run start` answered 200 on guest port 3000.",
    });
    expect(only({ app: appStates.failed })).toMatchObject({
      tone: "danger",
      message: "No `start` script in package.json.",
    });
  });

  it("says nothing for an idle server, which is the normal state", () => {
    expect(notes({ app: { kind: "idle" } })).toEqual([]);
    expect(notes({ app: undefined })).toEqual([]);
  });
});

describe("the Netlify check", () => {
  it("is green when valid and amber (not red) when it is not, because the agent can fix it", () => {
    expect(only({ netlify: { kind: "ok" } })).toMatchObject({
      id: "netlify",
      tone: "success",
      message: "netlify.toml is valid.",
    });
    expect(only({ netlify: { kind: "invalid", errors: ["build.publish is required"] } })).toMatchObject({
      tone: "warning",
      message: "netlify.toml has 1 problem: build.publish is required",
    });
    expect(
      only({ netlify: { kind: "invalid", errors: ["a", "b"] } as NetlifyStatus }).message,
    ).toBe("netlify.toml has 2 problems: a; b");
  });

  it("says nothing before a check has run", () => {
    expect(notes({ netlify: { kind: "unknown" } })).toEqual([]);
  });
});

describe("the whole list", () => {
  it("announces every source at once, in a fixed order, one toast each", () => {
    const all = notes({
      environment: machine("error", "no shared memory"),
      build: build.failed as BuildStatus,
      preview: phases.failed as PreviewPhase,
      app: appStates.failed,
      netlify: { kind: "invalid", errors: ["a"] },
    });

    expect(all.map((notification) => notification.id)).toEqual([
      "machine",
      "build",
      "preview",
      "app",
      "netlify",
    ]);
    expect(all.map((notification) => notification.tone)).toEqual([
      "danger",
      "danger",
      "danger",
      "danger",
      "warning",
    ]);
  });

  it("is empty on a quiet app, so the toast stack is not furniture", () => {
    expect(notes({})).toEqual([]);
  });
});
