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
 * - **dev** (`prod: false`, the Settings switch off) *attaches*: one knock on the port, then
 *   every request is forwarded to the server the user runs (`attach.ts`). No build, no static
 *   server of ours, no snapshot — which is the whole point of previewing a dev server.
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
  /** How many attaches this controller has made, so each gets its own URL and frame key. */
  let attaches = 0;
  let inFlight: Promise<PreviewPhase> | null = null;

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
   * The dev preview: knock on `port` and forward every request to it.
   *
   * Deliberately short. There is no build step, no `dist/` listing and no guest `node`: the
   * server is the user's, and this side's whole job is to find out whether it is there and then
   * hand each request to it. The id is derived from the count rather than from the bytes, because
   * there are no bytes here to fingerprint — and it has to change on every attach so the iframe
   * gets a fresh document at a URL no cached response can answer.
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

    attaches += 1;
    const buildId = `dev-${String(attaches)}`;
    set({ kind: "starting", detail: `Looking for a server on guest port ${String(port)}…` });

    const attachFn = options.attach ?? attachGuestServer;
    const result = await attachFn({ http, port, buildId });
    if (!result.ok) return set({ kind: "failed", message: result.message });

    const live = result.attach;
    attach = live;
    return set({
      kind: "ready",
      buildId: live.buildId,
      url: live.url,
      files: 0,
      // `guest` is exact: nothing was published, so the bytes are answered on demand.
      served: "guest",
      note: live.note,
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
      const active = session;
      session = null;
      await detach();
      await active?.stop();
      set({ kind: "idle" });
    },
  };
}

/** One sentence naming the step that failed, keeping the cause's own words. */
function describe(step: string, error: unknown): string {
  const cause = error instanceof Error ? error.message : String(error);
  return `The preview could not ${step}: ${cause}`;
}
