/**
 * The controller is where "a build exists in the guest" becomes "the pane can show one", so
 * these tests are about the states a user actually experiences: starting a server takes a
 * minute, a publish can fail while the server is fine, and a machine that is not running
 * must say so instead of showing an empty frame.
 *
 * Everything is injected — the environment is a `FakeEnvironment`, the session is a stub —
 * because the point here is the ordering and the wording, not the guest. The real path is
 * proved by `tests/guest/preview.guest.test.ts` and the browser acceptance run.
 */

import { describe, expect, it } from "vitest";

import { FakeEnvironment } from "../src/env/fake-environment";
import { createPreviewController, type PreviewPhase } from "../src/preview/controller";
import type { PreviewSession, StartPreviewSessionOptions } from "../src/preview/session";
import type { PreviewPublishOutcome } from "../src/preview/session";

const TREE = {
  "dist/index.html": '<!doctype html><div id="root"></div>',
  "dist/assets/index-abc123.js": "console.log('answer = 42');",
  "dist/assets/index-def456.css": "body { background: #123456; }",
};

interface StubSession extends PreviewSession {
  published: string[];
  stops: number;
  options: StartPreviewSessionOptions | null;
}

/** A session that publishes without a guest, so the controller's own behaviour is visible. */
function stubSession(
  options: StartPreviewSessionOptions | null,
  behaviour: {
    outcome?: (buildId: string) => PreviewPublishOutcome;
    publishError?: Error;
  } = {},
): StubSession {
  let current: string | null = null;
  let stops = 0;
  const published: string[] = [];

  return {
    port: options?.port ?? 8123,
    root: "/workspace/dist",
    get url() {
      return current === null ? null : `/__preview__/${current}/`;
    },
    get buildId() {
      return current;
    },
    published,
    get stops() {
      return stops;
    },
    options,
    async publish(buildId: string) {
      if (behaviour.publishError) throw behaviour.publishError;
      published.push(buildId);
      current = buildId;
      return (
        behaviour.outcome?.(buildId) ?? {
          kind: "published",
          buildId,
          files: 3,
          waited: false,
        }
      );
    },
    async serve() {
      return null;
    },
    async stop() {
      stops += 1;
    },
  };
}

interface Harness {
  environment: FakeEnvironment;
  phases: PreviewPhase[];
  sessions: StubSession[];
  controller: ReturnType<typeof createPreviewController>;
}

async function harness(
  options: {
    tree?: Record<string, string>;
    initialize?: boolean;
    guestHttp?: boolean;
    behaviour?: { outcome?: (buildId: string) => PreviewPublishOutcome; publishError?: Error };
    startError?: Error;
    fallbackPath?: string | null;
  } = {},
): Promise<Harness> {
  const environment = new FakeEnvironment({
    workspacePath: "/workspace",
    tree: options.tree ?? TREE,
    ...(options.guestHttp === false
      ? {}
      : { guestHttp: () => Promise.resolve(new Response("", { status: 200 })) }),
  });
  if (options.initialize !== false) await environment.initialize();

  const sessions: StubSession[] = [];
  const phases: PreviewPhase[] = [];
  const controller = createPreviewController({
    environment,
    http: () => environment.guestHttp(),
    ...(options.fallbackPath !== undefined ? { fallbackPath: options.fallbackPath } : {}),
    startSession: async (startOptions) => {
      if (options.startError) throw options.startError;
      const session = stubSession(startOptions, options.behaviour ?? {});
      sessions.push(session);
      return session;
    },
    onPhase: (phase) => phases.push(phase),
  });

  return { environment, phases, sessions, controller };
}

describe("createPreviewController", () => {
  it("starts on idle and publishes nothing until asked", async () => {
    const { controller, sessions } = await harness();

    expect(controller.phase()).toEqual({ kind: "idle" });
    expect(controller.url()).toBeNull();
    expect(sessions).toHaveLength(0);
  });

  it("reports starting, then publishing, then ready with a real URL", async () => {
    const { controller, phases } = await harness();

    const phase = await controller.refresh();

    expect(phases.map((entry) => entry.kind)).toEqual(["starting", "publishing", "ready"]);
    expect(phase.kind).toBe("ready");
    if (phase.kind !== "ready") throw new Error("expected ready");
    expect(phase.url).toBe(`/__preview__/${phase.buildId}/`);
    expect(phase.files).toBe(3);
    expect(phase.served).toBe("worker");
    expect(phase.note).toBeNull();
    // The URL the pane points the iframe at is the one the session confirms.
    expect(controller.url()).toBe(phase.url);
  });

  it("labels the preview with the build manager's id when it is given one", async () => {
    const { controller, sessions } = await harness();

    const phase = await controller.refresh("build-mf3k2-1");

    expect(phase.kind).toBe("ready");
    if (phase.kind !== "ready") throw new Error("expected ready");
    expect(phase.buildId).toBe("build-mf3k2-1");
    expect(phase.url).toBe("/__preview__/build-mf3k2-1/");
    // The id the caller supplied is what the session publishes — not a fingerprint.
    expect(sessions[0]?.published).toEqual(["build-mf3k2-1"]);
  });

  it("keeps one guest server across refreshes, because starting it is the slow part", async () => {
    const { controller, sessions } = await harness();

    const first = await controller.refresh("build-1");
    const second = await controller.refresh("build-2");

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.published).toEqual(["build-1", "build-2"]);
    if (first.kind !== "ready" || second.kind !== "ready") throw new Error("expected ready");
    // A new build means a new URL, so an iframe pinned to the old one is refused, not shown.
    expect(first.url).not.toBe(second.url);
    expect(second.url).toBe("/__preview__/build-2/");
  });

  it("says the machine is not running rather than showing an empty pane", async () => {
    const { controller, sessions } = await harness({ initialize: false });

    const phase = await controller.refresh();

    expect(phase.kind).toBe("failed");
    if (phase.kind !== "failed") throw new Error("expected failed");
    expect(phase.message).toContain("Boot it first");
    expect(sessions).toHaveLength(0);
  });

  it("says the guest has no HTTP door when the kernel exposes no fetch", async () => {
    const { controller, sessions } = await harness({ guestHttp: false });

    const phase = await controller.refresh();

    expect(phase.kind).toBe("failed");
    if (phase.kind !== "failed") throw new Error("expected failed");
    expect(phase.message).toContain("cannot be reached over HTTP");
    expect(sessions).toHaveLength(0);
  });

  it("explains an empty publish directory instead of publishing nothing", async () => {
    const { controller, sessions } = await harness({ tree: {} });

    const phase = await controller.refresh();

    expect(phase.kind).toBe("failed");
    if (phase.kind !== "failed") throw new Error("expected failed");
    expect(phase.message).toContain("There is no build to preview");
    expect(phase.message).toContain("dist/");
    expect(sessions).toHaveLength(0);
  });

  it("drops a session that failed to start, so the next attempt retries", async () => {
    const { controller, phases } = await harness({ startError: new Error("node: not found") });

    const failed = await controller.refresh();

    expect(failed.kind).toBe("failed");
    if (failed.kind !== "failed") throw new Error("expected failed");
    expect(failed.message).toContain("start the preview");
    expect(failed.message).toContain("node: not found");
    expect(phases.at(-1)).toEqual(failed);
  });

  it("keeps the server when only the publish failed, and reports what it said", async () => {
    const { controller, sessions } = await harness({
      behaviour: { publishError: new Error("The guest answered 500 for /index.html") },
    });

    const phase = await controller.refresh();

    expect(phase.kind).toBe("failed");
    if (phase.kind !== "failed") throw new Error("expected failed");
    expect(phase.message).toContain("publish the build");
    expect(phase.message).toContain("/index.html");
    // One server, not two: a failed publish must not cost another cold start.
    expect(sessions).toHaveLength(1);
    expect(controller.url()).toBeNull();
  });

  it("reports a browsed-without-a-worker preview as served by the guest, with the reason", async () => {
    const reason = "This browser has no service worker, so the guest answers preview URLs.";
    const { controller } = await harness({
      behaviour: {
        outcome: (buildId) => ({ kind: "proxied", buildId, files: 3, reason }),
      },
    });

    const phase = await controller.refresh();

    expect(phase.kind).toBe("ready");
    if (phase.kind !== "ready") throw new Error("expected ready");
    // Still a working preview: the fallback is slower, not broken. The pane says which.
    expect(phase.served).toBe("guest");
    expect(phase.note).toBe(reason);
  });

  it("shares one run between concurrent refreshes, so a double click publishes once", async () => {
    const { controller, sessions } = await harness();

    const [first, second] = await Promise.all([
      controller.refresh("build-1"),
      controller.refresh("build-1"),
    ]);

    expect(first).toBe(second);
    expect(sessions[0]?.published).toEqual(["build-1"]);
  });

  it("stops the guest server and returns to idle", async () => {
    const { controller, sessions } = await harness();
    await controller.refresh("build-1");

    await controller.stop();

    expect(sessions[0]?.stops).toBe(1);
    expect(controller.phase()).toEqual({ kind: "idle" });
    expect(controller.url()).toBeNull();
  });

  it("notifies subscribers and stops notifying after unsubscribe", async () => {
    const { controller } = await harness();
    const seen: PreviewPhase[] = [];
    const unsubscribe = controller.subscribe((phase) => seen.push(phase));

    await controller.refresh("build-1");
    const afterRefresh = seen.length;
    unsubscribe();
    await controller.refresh("build-2");

    expect(afterRefresh).toBeGreaterThan(0);
    expect(seen).toHaveLength(afterRefresh);
    expect(seen.at(-1)?.kind).toBe("ready");
  });

  it("passes the publish directory and SPA fallback through to the session", async () => {
    const { controller, sessions } = await harness({ fallbackPath: null });

    await controller.refresh("build-1");

    expect(sessions[0]?.options?.root).toBe("dist");
    expect(sessions[0]?.options?.fallbackPath).toBeNull();
  });

  it("gives the guest's server a budget that survives a cold runtime download", async () => {
    const { controller, sessions } = await harness();

    await controller.refresh("build-1");

    // The guest's `node` is a first-use shim (~147 s measured); the session's own default is
    // 120 s, which would report a broken preview for a slow first start.
    expect(sessions[0]?.options?.timeoutMs).toBe(300_000);
  });
});
