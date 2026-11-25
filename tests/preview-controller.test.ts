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
import type { GuestAttachOptions, GuestAttachResult } from "../src/preview/attach";
import type { AppServerOptions, AppServerSession, AppServerStart, StartScriptFacts } from "../src/preview/app-server";
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

/* ------------------------------------------------------------------ *
 * The dev preview runs the project first
 * ------------------------------------------------------------------ */

/**
 * A dev-mode controller with the whole outside world injected.
 *
 * The point of these tests is the *order* of three decisions — is anything listening, does the
 * project know how to start, does the preview then attach — so every answer is a value the test
 * chose, and nothing here needs a guest, a process or a browser.
 */
interface DevHarness {
  controller: ReturnType<typeof createPreviewController>;
  phases: PreviewPhase[];
  calls: { probe: number; start: number; attach: number; startedStops: number; attachStops: number };
  /** What the start was asked to do, for the assertions about command and port. */
  started: AppServerOptions | null;
  sections: string[];
}

function appSession(port: number, onStop: () => void): AppServerSession {
  return {
    port,
    command: "bun run dev",
    url: `http://127.0.0.1:${String(port)}/`,
    status: 200,
    output: () => "",
    running: () => true,
    async stop() {
      onStop();
    },
  };
}

async function devHarness(options: {
  /** What the probe answers: an HTTP status, or null for "nothing is listening". A function is
   * asked afresh on every probe, with the port, for the tests about a second attempt seeing the
   * first one's server and about two ports in one session. */
  answers?: number | null | ((port: number) => number | null);
  facts?: StartScriptFacts;
  /** Overrides the default "it started and answered 200". */
  start?: (startOptions: AppServerOptions) => Promise<AppServerStart>;
  /** Overrides the default "the attach succeeded". */
  attach?: (attachOptions: GuestAttachOptions) => GuestAttachResult;
  port?: number;
} = {}): Promise<DevHarness> {
  const calls = { probe: 0, start: 0, attach: 0, startedStops: 0, attachStops: 0 };
  const phases: PreviewPhase[] = [];
  const sections: string[] = [];
  const state: { started: AppServerOptions | null } = { started: null };

  const environment = new FakeEnvironment({
    workspacePath: "/workspace",
    tree: TREE,
    guestHttp: () => Promise.resolve(new Response("", { status: 200 })),
  });
  await environment.initialize();

  const facts: StartScriptFacts = options.facts ?? {
    dev: "next dev",
    start: "next start",
    command: "bun run dev",
    script: "dev",
    packageManager: "bun",
    problem: null,
  };

  const controller = createPreviewController({
    environment,
    http: () => environment.guestHttp(),
    prod: false,
    ...(options.port !== undefined ? { port: options.port } : {}),
    probe: async (_http, port) => {
      calls.probe += 1;
      if (options.answers === undefined) return null;
      return typeof options.answers === "function" ? options.answers(port) : options.answers;
    },
    readScript: async () => facts,
    startApp: async (startOptions) => {
      calls.start += 1;
      state.started = startOptions;
      return options.start === undefined
        ? {
            ok: true,
            reason: null,
            message: "Running `bun run dev` on port 3000.",
            session: appSession(startOptions.port ?? 3000, () => {
              calls.startedStops += 1;
            }),
          }
        : options.start(startOptions);
    },
    attach: async (attachOptions) => {
      calls.attach += 1;
      if (options.attach !== undefined) return options.attach(attachOptions);
      sections.push(attachOptions.buildId);
      return {
        ok: true,
        attach: {
          port: attachOptions.port,
          buildId: attachOptions.buildId,
          url: `/__preview__/${attachOptions.buildId}/`,
          status: 200,
          note: `Forwarding to guest port ${String(attachOptions.port)}.`,
          serve: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
          async stop() {
            calls.attachStops += 1;
          },
          answered: () => 0,
          failures: () => [],
        },
      };
    },
    onPhase: (phase) => phases.push(phase),
  });

  return {
    controller,
    phases,
    calls,
    get started() {
      return state.started;
    },
    sections,
  };
}

describe("the dev preview", () => {
  it("starts the project's own server when nothing answers, then attaches to it", async () => {
    const harness = await devHarness({ answers: null });
    const { controller, calls, phases } = harness;

    const phase = await controller.refresh();

    expect(calls.start).toBe(1);
    expect(calls.attach).toBe(1);
    // The command is the project's, and the port is the one the pane will knock on: the same
    // `PORT` the server is told, so the listener and the forwarder cannot disagree.
    expect(harness.started?.command).toBe("bun run dev");
    expect(harness.started?.port).toBe(5173);
    expect(phase.kind).toBe("ready");
    if (phase.kind !== "ready") throw new Error("expected ready");
    expect(phase.forwarded).toEqual({ port: 5173 });
    expect(phase.served).toBe("guest");
    // The stages are visible while it happens: a start can take a minute.
    expect(phases.filter((entry) => entry.kind === "starting")).not.toHaveLength(0);
    expect(
      phases.some(
        (entry) => entry.kind === "starting" && entry.detail.includes("bun run dev"),
      ),
    ).toBe(true);
  });

  it("attaches to a server that already answers, and starts nothing", async () => {
    // The user started their own dev server in the terminal: it is theirs, and a second server
    // on one port is the failure this probe exists to prevent.
    const { controller, calls } = await devHarness({ answers: 404 });

    const phase = await controller.refresh();
    await controller.stop();

    expect(calls.probe).toBe(1);
    expect(calls.start).toBe(0);
    expect(calls.attach).toBe(1);
    expect(calls.startedStops).toBe(0);
    expect(phase.kind).toBe("ready");
  });

  it("says the project has nothing to run instead of waiting for a port that never answers", async () => {
    const { controller, calls } = await devHarness({
      answers: null,
      facts: {
        dev: null,
        start: null,
        command: null,
        script: null,
        packageManager: "npm",
        problem: "No `dev` or `start` script in package.json, so the project has nothing to run.",
      },
      attach: (attachOptions) => ({
        ok: false,
        message: `Nothing answered on guest port ${String(attachOptions.port)}.`,
      }),
    });

    const phase = await controller.refresh();

    expect(calls.start).toBe(0);
    // The attach is still attempted, because a server started elsewhere may be answering — so
    // the failure carries both sentences, in the order they happened.
    expect(calls.attach).toBe(1);
    expect(phase.kind).toBe("failed");
    if (phase.kind !== "failed") throw new Error("expected failed");
    expect(phase.message).toContain("No `dev` or `start` script");
    expect(phase.message).toContain("Nothing answered on guest port");
  });

  it("reports a start that died beside a preview that works", async () => {
    // The classic case: the port was already in use, so the script exited — but something *is*
    // answering there. Hiding that preview behind the failed start would be the worst answer.
    const { controller } = await devHarness({
      answers: null,
      start: async () => ({
        ok: false,
        session: null,
        reason: "exited",
        message: "`bun run dev` exited before it answered on port 5173.",
      }),
    });

    const phase = await controller.refresh();

    expect(phase.kind).toBe("ready");
    if (phase.kind !== "ready") throw new Error("expected ready");
    expect(phase.note).toContain("exited before it answered");
    expect(phase.note).toContain("attached to what does answer");
  });

  it("stops the server it started, and only that one", async () => {
    const own = await devHarness({ answers: null });
    await own.controller.refresh();
    await own.controller.stop();

    expect(own.calls.startedStops).toBe(1);
    expect(own.calls.attachStops).toBe(1);
    expect(own.controller.phase()).toEqual({ kind: "idle" });

    // A server the controller did not start is nobody's to kill.
    const userOwned = await devHarness({ answers: 200 });
    await userOwned.controller.refresh();
    await userOwned.controller.stop();

    expect(userOwned.calls.start).toBe(0);
    expect(userOwned.calls.startedStops).toBe(0);
  });

  it("re-attaches on a later press instead of starting a second server", async () => {
    // The first press starts the project; every press after it must find that server answering.
    // Starting another would fail with EADDRINUSE and would be the pane's own fault.
    let harness: DevHarness | undefined;
    harness = await devHarness({ answers: () => ((harness?.calls.start ?? 0) > 0 ? 200 : null) });
    const { controller, calls } = harness;

    await controller.refresh();
    await controller.refresh();

    expect(calls.probe).toBe(2);
    expect(calls.start).toBe(1);
    expect(calls.attach).toBe(2);
    expect(calls.startedStops).toBe(0);
  });

  it("stops its previous server before starting one on another port", async () => {
    // The address bar can name a port of its own. Only one server is the preview's, so the one it
    // started on the old port is stopped rather than left listening beside the new one.
    let harness: DevHarness | undefined;
    harness = await devHarness({
      answers: (port) =>
        port === 3000 ? null : (harness?.calls.start ?? 0) > 0 ? 200 : null,
    });
    const { controller, calls } = harness;

    await controller.refresh();
    expect(calls.start).toBe(1);
    expect(calls.startedStops).toBe(0);

    await controller.attach(3000);

    expect(calls.start).toBe(2);
    expect(calls.startedStops).toBe(1);
  });

  it("shares one run between two presses, so a double click is one start", async () => {
    const { controller, calls } = await devHarness({ answers: null });

    await Promise.all([controller.refresh(), controller.refresh()]);

    expect(calls.probe).toBe(1);
    expect(calls.start).toBe(1);
    expect(calls.attach).toBe(1);
  });

  it("stops the server it was starting when the pane is stopped mid-start", async () => {
    // A stop that a slow start outlived: the machine is being replaced or Prod was switched on,
    // and the controller is about to be thrown away. Without the generation check the session it
    // produced would keep listening, and the pane would repaint a preview after being stopped.
    const release: { resolve: ((value: AppServerStart) => void) | null } = { resolve: null };
    const harness = await devHarness({
      answers: null,
      start: () =>
        new Promise<AppServerStart>((resolve) => {
          release.resolve = resolve;
        }),
    });
    const { controller, calls, phases } = harness;

    const run = controller.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await controller.stop();
    expect(controller.phase()).toEqual({ kind: "idle" });

    release.resolve?.({
      ok: true,
      session: appSession(5173, () => {
        calls.startedStops += 1;
      }),
      reason: null,
      message: "Running `bun run dev` on port 5173.",
    });
    await run;

    expect(calls.attach).toBe(0);
    expect(calls.startedStops).toBe(1);
    expect(controller.phase()).toEqual({ kind: "idle" });
    expect(phases.some((entry) => entry.kind === "ready")).toBe(false);
  });

  it("knocks on the guest's own loopback with the Settings port when nothing is injected", async () => {
    // The default probe, exercised for real: the URL it builds and the throw-means-nothing rule.
    const environment = new FakeEnvironment({
      workspacePath: "/workspace",
      tree: TREE,
      guestHttp: () => Promise.resolve(new Response("", { status: 200 })),
    });
    await environment.initialize();

    const asked: string[] = [];
    const http = async (url: string) => {
      asked.push(url);
      throw new Error("connection refused");
    };
    const starts: number[] = [];
    const controller = createPreviewController({
      environment,
      http: () => http,
      prod: false,
      port: 4000,
      readScript: async () => ({
        dev: "vite",
        start: null,
        command: "npm run dev",
        script: "dev",
        packageManager: "npm",
        problem: null,
      }),
      startApp: async (startOptions) => {
        starts.push(startOptions.port ?? 0);
        return { ok: false, session: null, reason: "timeout", message: "did not answer" };
      },
      attach: async (attachOptions) => ({ ok: false, message: `no attach: ${String(attachOptions.port)}` }),
    });

    await controller.refresh();

    expect(asked).toContain("http://127.0.0.1:4000/");
    // A refused connection is the only "nothing is there" — so the project was started.
    expect(starts).toEqual([4000]);
  });
});
