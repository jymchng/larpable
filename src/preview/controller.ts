/**
 * The app's preview: one small state machine between a build in the guest and an iframe.
 *
 * Everything else in `src/preview/` is honest about one thing each — routing decides paths,
 * the guest server serves bytes, the transport speaks HTTP, the proxy answers requests, the
 * session puts those in order. None of them decides *when* a preview happens or what the
 * pane should say while it does. That decision is here, and it is deliberately not a React
 * hook: the acceptance run in `scripts/preview-browser-acceptance.ts` drives this same
 * object, so what a test asserts is what the app runs.
 *
 * The phases are the user's experience, not the implementation's:
 *
 * - `idle` — nothing has been asked for yet;
 * - `starting` — the guest's file server is being written and started (seconds to a minute
 *   on a cold `node`, which is why this is its own phase and not a silent await);
 * - `publishing` — the build was listed, has an id, and is being read out of the guest;
 * - `ready` — the iframe can be pointed at `url`, with a note saying whether a service
 *   worker is holding the bytes or the guest is answering on demand;
 * - `failed` — what went wrong, in the words the pane shows.
 *
 * Two modes reach `ready`, and they are the two answers to "where do the bytes come from":
 *
 * - **prod** (`prod: true`, the default here) publishes a build: list `dist/`, start the guest's
 *   static server, read the bytes out of it, hand them to the worker.
 * - **dev** (`prod: false`, the Settings switch off) *attaches*: it makes sure something answers
 *   on the port — starting the project's own `dev`/`start` script when nothing does — then
 *   forwards every request to it (`attach.ts`). No build and no static server of ours, which is
 *   the whole point of previewing a dev server.
 *
 * The starting is the part that used to be missing, and it was a visible failure: the arrow said
 * "attach to whatever answers", and on a fresh project *nothing* did, so the one control that
 * promised a preview could only report that there was nothing on the port. A preview that shows
 * the site served by the project's own dev server has to be allowed to *run* that server; the
 * user's terminal remains a perfectly good place to run it instead, which is why the probe comes
 * first and an already-listening server is attached to rather than duplicated.
 *
 * The mode is a constructor option rather than a method because it changes what the controller
 * *is*: switching it rebuilds the controller (`use-preview.ts` memoises on it), so a prod
 * preview's guest server can never be left listening by a switch to dev.
 *
 * Two behaviours are failure-proofing rather than features:
 *
 * - a publish that fails keeps the guest server: the next attempt does not pay the start-up
 *   cost again, and the *previous* build is still published, so the pane keeps a working
 *   preview instead of going blank;
 * - a start that fails drops the session, so the next attempt starts a new one rather than
 *   reusing a server that never listened.
 */

import type { ExecutionEnvironment } from "@/env/execution";
import type { GuestHttpFetch } from "@/env/unkernel-kernel";
import {
  attachGuestServer,
  type GuestAttach,
  type GuestAttachOptions,
  type GuestAttachResult,
} from "./attach";
import {
  readStartScript,
  startAppServer,
  type AppServerOptions,
  type AppServerSession,
  type AppServerStart,
  type StartScriptFacts,
} from "./app-server";
import { deriveBuildId, listPublishFiles, type PublishFile } from "./build-id";
import { startPreviewSession, type PreviewSession, type StartPreviewSessionOptions } from "./session";

/** What the preview pane is showing, as one exhaustive value. */
export type PreviewPhase =
  | { kind: "idle" }
  | { kind: "starting"; detail: string }
  | { kind: "publishing"; buildId: string; detail: string }
  | {
      kind: "ready";
      buildId: string;
      url: string;
      files: number;
      /** `worker`: the service worker holds the bytes. `guest`: answered on demand. */
      served: "worker" | "guest";
      /** Why the guest is answering, when it is. Shown verbatim. */
      note: string | null;
      /**
       * The guest port a *forwarded* preview is attached to, or null/absent for a published build.
       *
       * It is what lets the address bar print `localhost:1234/app` instead of the pane's own URL
       * space: a forwarded preview's address is the user's address, and showing
       * `/__preview__/dev-1/app` for a page they typed as `localhost:1234/app` would be the bar
       * lying about where they are.
       */
      forwarded?: { port: number } | null;
    }
  | { kind: "failed"; message: string };

export interface PreviewControllerOptions {
  /** The booted guest. Writes and runs the server script. */
  environment: ExecutionEnvironment;
  /**
   * HTTP to the guest's loopback — `UnkernelEnvironment.guestHttp()` in the app. A
   * function rather than a value because the answer changes: it is null before boot, and a
   * test double may never provide one.
   */
  http: () => GuestHttpFetch | null;
  /** Publish directory, workspace-relative. Default `dist`. */
  root?: string;
  /** Guest port for the preview server. Default `DEFAULT_PREVIEW_PORT`. */
  port?: number;
  /** `/index.html` for an SPA build; null to make deep links 404. Default `/index.html`. */
  fallbackPath?: string | null;
  /**
   * Budget for the guest's server to announce its port. Default 300 s.
   *
   * Not the session's 120 s default, because the guest's `node` is a first-use shim that
   * downloads the runtime on its first call — measured at ~147 s on this image. A user's
   * first preview of their first project is exactly the case that pays it, and a timeout
   * there would look like a broken preview rather than a slow machine.
   */
  startTimeoutMs?: number;
  /** Injected by tests and by the acceptance run. Default: the real session. */
  startSession?: (options: StartPreviewSessionOptions) => Promise<PreviewSession>;
  /** Injected by tests. Default: walk the guest's publish directory. */
  listFiles?: (environment: ExecutionEnvironment, root: string) => Promise<PublishFile[]>;
  /**
   * Which preview this controller is: `true` (the default here) publishes a build, `false`
   * attaches to the server the user runs.
   *
   * The default is `true` so every existing caller — the agent's `preview_site` tool and the
   * browser acceptance run — keeps the behaviour it was written against. The *app* passes the
   * Settings switch, whose own default is `false` (dev): a developer editing a component wants
   * their dev server, and the built output is one checkbox away.
   */
  prod?: boolean;
  /** Injected by tests and by the acceptance run. Default: `attachGuestServer`. */
  attach?: (options: GuestAttachOptions) => Promise<GuestAttachResult>;
  /**
   * Ask the guest whether anything is already listening on `port`: the HTTP status it answered
   * with, or null when nothing answered. Default: one `GET http://127.0.0.1:<port>/`.
   *
   * Injected so a test can decide "a server is already there" (no start) or "nothing is" (a
   * start) without a guest, and so the acceptance run can record which of the two happened.
   */
  probe?: (http: GuestHttpFetch, port: number) => Promise<number | null>;
  /**
   * Read the project's own start command, for the dev preview. Default: `readStartScript`.
   *
   * Given the workspace (not the publish directory): `package.json` lives at the project root,
   * and `dist/` is a directory inside it.
   */
  readScript?: (environment: ExecutionEnvironment, root: string) => Promise<StartScriptFacts>;
  /**
   * Run the project's server in the guest. Default: `startAppServer`, which waits for the port
   * to answer instead of sleeping. Injected by tests, which have no process to run.
   */
  startApp?: (options: AppServerOptions) => Promise<AppServerStart>;
  /** Called on every phase change, after the state is readable. */
  onPhase?: (phase: PreviewPhase) => void;
}

export interface PreviewController {
  /** The current phase. Always the last value published to subscribers. */
  phase(): PreviewPhase;
  /** Subscribe to phase changes. Returns the unsubscribe function. */
  subscribe(listener: (phase: PreviewPhase) => void): () => void;
  /**
   * Publish the current contents of the publish directory.
   *
   * `buildId` is for callers that already know the id — `BuildResult.id` — so a preview is
   * labelled with the build that produced it rather than with a hash of its files.
   * Concurrent calls share one run: a double click is one publish, not two racing over the
   * same service-worker message channel.
   */
  refresh(buildId?: string): Promise<PreviewPhase>;
  /**
   * Attach the pane to whatever is listening on `port` in the guest — the dev preview.
   *
   * `refresh()` already does this in dev mode; this method exists for the address bar, which can
   * name a port of its own (`localhost:3000`). It stops the previous attach first, so one pane
   * never has two forwarders answering for two servers.
   */
  attach(port: number): Promise<PreviewPhase>;
  /** The published build's URL, or null before the first successful publish. */
  url(): string | null;
  /** Stop the guest's server (and any attach). Idempotent, and safe before `refresh()`. */
  stop(): Promise<void>;
}

/** The message a user sees when the guest cannot be reached at all. */
const NO_DOOR =
  "This guest cannot be reached over HTTP, so the preview has no way to read a build. " +
  "A kernel without `fetch()` (a test double) has no loopback to serve from.";

export function createPreviewController(options: PreviewControllerOptions): PreviewController {
  const root = options.root ?? "dist";
  const listFiles = options.listFiles ?? listPublishFiles;
  const startSession = options.startSession ?? startPreviewSession;
  const startTimeoutMs = options.startTimeoutMs ?? 300_000;

  const listeners = new Set<(phase: PreviewPhase) => void>();
  let phase: PreviewPhase = { kind: "idle" };
  let session: PreviewSession | null = null;
  /** The dev preview: a forwarded session, or null. Mutually exclusive with `session`. */
  let attach: GuestAttach | null = null;
  /**
   * The server the dev preview started *itself*, or null.
   *
   * Null and "a server is listening" are different states: a server the user started in the
   * terminal answers the probe too, but it is theirs and this controller must never kill it.
   * Only what we started is stopped, and it is stopped before another start and with `stop()`.
   */
  let startedServer: AppServerSession | null = null;
  /** How many attaches this controller has made, so each gets its own URL and frame key. */
  let attaches = 0;
  let inFlight: Promise<PreviewPhase> | null = null;
  /**
   * Bumped by `stop()`: work that was already in flight must not publish a phase afterwards.
   *
   * A start can take a minute, and the things that stop a preview — the pane's own stop, a
   * machine being replaced, Prod being switched on (which rebuilds this controller) — do not
   * wait for it. Without this, such a stop would be undone by the attach that was already
   * running: a server nobody asked for would be left listening, and the pane would show a
   * preview after being told to stop. It is a counter rather than a boolean because the
   * controller is not dead after a stop — a later `refresh()` is a new generation.
   */
  let generation = 0;

  function set(next: PreviewPhase): PreviewPhase {
    phase = next;
    for (const listener of listeners) listener(next);
    options.onPhase?.(next);
    return next;
  }

  /** Drop the dev attach, if there is one. Its forwarder must stop before a new one starts. */
  async function detach(): Promise<void> {
    const active = attach;
    attach = null;
    await active?.stop().catch(() => undefined);
  }

  /**
   * Stop the server *we* started. The user's own server is never touched, and this is idempotent
   * because the reference is cleared before the await.
   */
  async function stopStartedServer(): Promise<void> {
    const started = startedServer;
    startedServer = null;
    await started?.stop().catch(() => undefined);
  }

  /**
   * Make something answer on `port`, running the project's own script when nothing does.
   *
   * Returns the sentence to show when the project could not be started, or null when the port
   * answers. A non-null answer is *not* a final failure: `attachTo` still knocks, because a
   * server the user started elsewhere may well be answering — the start that failed is then
   * reported beside a preview that works, which is more useful than either alone.
   *
   * Failure is deliberately not fatal to the attach, and success is deliberately not a claim:
   * `startAppServer` only resolves `ok` once the port has answered, so this cannot report a
   * green ready over a socket nobody is holding.
   */
  async function ensureServer(http: GuestHttpFetch, port: number): Promise<string | null> {
    const probe = options.probe ?? portAnswers;
    const already = await probe(http, port);
    if (already !== null) return null;

    // Ours first: a previous start whose server has died (or is on an older port) must not stay
    // listening while a second one takes its port.
    await stopStartedServer();

    set({
      kind: "starting",
      detail: `Nothing answers on guest port ${String(port)} yet, so the preview is starting the project's server…`,
    });

    const readScript = options.readScript ?? readStartScript;
    let facts: StartScriptFacts;
    try {
      facts = await readScript(options.environment, options.environment.workspacePath);
    } catch (error) {
      return describe("read the project's start script", error);
    }
    // Said in the project's own terms ("No `dev` or `start` script in package.json…") rather
    // than as a timeout on a port that was never going to answer.
    if (facts.command === null) return facts.problem ?? "The project has no script to run.";

    set({
      kind: "starting",
      detail: `Starting \`${facts.command}\` in the guest, on port ${String(port)}…`,
    });

    const startApp = options.startApp ?? startAppServer;
    let started: AppServerStart;
    try {
      started = await startApp({
        environment: options.environment,
        command: facts.command,
        port,
        // The same door every forwarded request will use, so the probe and the preview cannot
        // disagree about which guest they are talking to.
        fetch: http,
        onStage: (detail) => set({ kind: "starting", detail }),
      });
    } catch (error) {
      return describe(`run \`${facts.command}\``, error);
    }

    if (!started.ok || started.session === null) return started.message;
    startedServer = started.session;
    return null;
  }

  /**
   * The dev preview: make sure something answers on `port`, then forward every request to it.
   *
   * Deliberately short after that. There is no build step, no `dist/` listing and no guest
   * `node` of our own serving bytes: the server is the project's (or the user's), and this
   * side's job is to find out whether it is there, start it if not, and then hand each request
   * to it. The id is derived from the count rather than from the bytes, because there are no
   * bytes here to fingerprint — and it has to change on every attach so the iframe gets a fresh
   * document at a URL no cached response can answer.
   */
  async function attachTo(port: number): Promise<PreviewPhase> {
    if (options.environment.status() !== "ready") {
      return set({
        kind: "failed",
        message:
          "The Linux environment is not running, so there is no server to attach to. Boot it first.",
      });
    }

    const http = options.http();
    if (http === null) return set({ kind: "failed", message: NO_DOOR });

    // The previous attach goes first: two forwarders answering for one pane is how a request
    // ends up at the port that was configured a minute ago.
    await detach();

    // Read before the first await: `stop()` may land at any point after this, and what it means
    // is "the run that was happening is not wanted any more" — see `generation`.
    const myGeneration = generation;

    const startProblem = await ensureServer(http, port);
    if (generation !== myGeneration) {
      // Stopped while the project's server was starting. The session it just produced is the one
      // this controller would have owned, so it is stopped here instead of being left listening;
      // nothing is published, because the pane is idle by request.
      await stopStartedServer();
      return phase;
    }

    attaches += 1;
    const buildId = `dev-${String(attaches)}`;
    if (startProblem === null) {
      set({ kind: "starting", detail: `Looking for a server on guest port ${String(port)}…` });
    }

    const attachFn = options.attach ?? attachGuestServer;
    const result = await attachFn({ http, port, buildId });
    if (generation !== myGeneration) {
      // Stopped while the knock was out: a forwarder that answered after the stop is stopped too,
      // so a stopped pane holds neither a server nor a forwarder.
      if (result.ok) await result.attach.stop().catch(() => undefined);
      return phase;
    }
    if (!result.ok) {
      return set({
        kind: "failed",
        // Both sentences, in the order they happened: what the project's own script did, then
        // what the port answered. Either alone would send the user to the wrong place.
        message: startProblem === null ? result.message : `${startProblem} ${result.message}`,
      });
    }

    const live = result.attach;
    attach = live;
    return set({
      kind: "ready",
      buildId: live.buildId,
      url: live.url,
      files: 0,
      // `guest` is exact: nothing was published, so the bytes are answered on demand.
      served: "guest",
      note:
        startProblem === null
          ? live.note
          : `${startProblem} The preview is attached to what does answer on guest port ${String(port)}.`,
      forwarded: { port: live.port },
    });
  }

  async function publish(buildId: string | undefined): Promise<PreviewPhase> {
    // Checked before anything is written into the guest: a preview request against a
    // half-booted machine cannot succeed, and saying so beats a connection error from
    // inside the VM.
    if (options.environment.status() !== "ready") {
      return set({
        kind: "failed",
        message:
          "The Linux environment is not running, so there is no build to preview. " +
          "Boot it first.",
      });
    }

    const http = options.http();
    if (http === null) return set({ kind: "failed", message: NO_DOOR });

    let files: PublishFile[];
    try {
      files = await listFiles(options.environment, root);
    } catch (error) {
      return set({ kind: "failed", message: describe("read the publish directory", error) });
    }

    if (files.length === 0) {
      return set({
        kind: "failed",
        message:
          `There is no build to preview: ${root}/ is empty or missing in the guest. ` +
          "Run the project's build command and check its publish directory.",
      });
    }

    // The caller's id wins: it names the build that produced these files, which is what
    // the pane should say. The derived id is a fingerprint of the listing, and is what a
    // preview of "whatever is in dist right now" can honestly claim.
    const id = buildId ?? deriveBuildId(files);
    if (id === null) {
      return set({
        kind: "failed",
        message: `There is no build to preview: ${root}/ listed no files.`,
      });
    }

    try {
      if (session === null) {
        set({ kind: "starting", detail: `Starting the guest's server for ${root}/…` });
        session = await startSession({
          environment: options.environment,
          http,
          root,
          timeoutMs: startTimeoutMs,
          ...(options.port !== undefined ? { port: options.port } : {}),
          ...(options.fallbackPath !== undefined ? { fallbackPath: options.fallbackPath } : {}),
        });
      }

      set({
        kind: "publishing",
        buildId: id,
        detail: `Reading ${String(files.length)} file${files.length === 1 ? "" : "s"} out of the guest…`,
      });

      const outcome = await session.publish(id);
      const url = session.url;
      if (url === null) {
        // `publish()` resolved without a snapshot: the session's own invariant broke, and
        // a blank frame with a green badge is the failure this exists to prevent.
        return set({
          kind: "failed",
          message: "The build was read but the preview has no URL for it. Nothing to show.",
        });
      }

      return set({
        kind: "ready",
        buildId: id,
        url,
        files: outcome.files,
        served: outcome.kind === "published" ? "worker" : "guest",
        note: outcome.kind === "published" ? null : outcome.reason,
      });
    } catch (error) {
      // A failure *inside* the session leaves it usable: the server may well be listening
      // and the previous build still published. Only a session that failed to start is
      // dropped, so the next attempt pays the start-up cost again rather than talking to a
      // server that never was.
      if (session === null) {
        return set({ kind: "failed", message: describe("start the preview", error) });
      }
      return set({ kind: "failed", message: describe("publish the build", error) });
    }
  }

  return {
    phase() {
      return phase;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    refresh(buildId) {
      if (inFlight !== null) return inFlight;
      // Dev publishes nothing: the reload arrow means "attach again", which is what makes it
      // useful after the user restarts their dev server. The fallback port is Vite's own default
      // — the app always passes the Settings port, so this only applies to a caller with none.
      const run = (options.prod === false ? attachTo(options.port ?? 5173) : publish(buildId)).finally(
        () => {
          inFlight = null;
        },
      );
      inFlight = run;
      return run;
    },

    attach(port) {
      if (inFlight !== null) return inFlight;
      const run = attachTo(port).finally(() => {
        inFlight = null;
      });
      inFlight = run;
      return run;
    },

    url() {
      return attach?.url ?? session?.url ?? null;
    },

    async stop() {
      // Before anything is awaited: whatever is in flight from here on must not publish a phase
      // or keep a listener, including a start that resolves after this call returns.
      generation += 1;
      const active = session;
      session = null;
      await detach();
      // Before the session: a decided stop is a stop, and the process we started is the one
      // thing here that keeps listening after the pane is gone.
      await stopStartedServer();
      await active?.stop();
      set({ kind: "idle" });
    },
  };
}

/**
 * One `GET` to the guest's own loopback: the status anything listening answered with, or null.
 *
 * A 404 is an answer — a dev server that has not compiled a route yet is still a running dev
 * server, and starting a second one on the same port would be the wrong repair. A throw is the
 * only "nothing is there": the kernel's `fetch()` rejects when the connection is refused.
 */
async function portAnswers(http: GuestHttpFetch, port: number): Promise<number | null> {
  try {
    const response = await http(`http://127.0.0.1:${String(port)}/`, { method: "GET" });
    return response.status;
  } catch {
    return null;
  }
}

/** One sentence naming the step that failed, keeping the cause's own words. */
function describe(step: string, error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  return `The preview could not ${step}: ${cause}`;
}
