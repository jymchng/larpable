/**
 * The page's side of the preview: register the worker, publish a build to it, clear it.
 *
 * The service worker is what gives guest content real URLs, and it only holds bytes
 * in memory. So publishing is a message, and this module is the only place that knows
 * the message names — the worker (`public/preview-sw.js`) and this file are the two
 * halves of one contract, and both sides are tested against it.
 *
 * Everything is injected rather than reached for (`navigator.serviceWorker`), for two
 * reasons: the publish protocol has to be testable without a browser, and a browser that
 * refuses registration must produce a usable error rather than a `TypeError` at import
 * time. When no worker is available the caller falls back to `proxy.ts`, which serves the
 * same URLs from the guest on demand.
 */

import type { PreviewSnapshot } from "./proxy";
import { PREVIEW_PREFIX } from "./routing";

/** The script Vite copies out of `public/`. Registered as a module worker. */
export const PREVIEW_WORKER_URL = "/preview-sw.js";

/**
 * The scope the worker claims.
 *
 * A trailing slash matters: a scope of `/__preview__` would also claim a sibling path
 * that merely starts with those characters. The script lives at `/preview-sw.js`, so
 * this scope is below its directory and needs no `Service-Worker-Allowed` header.
 */
export const PREVIEW_WORKER_SCOPE = `${PREVIEW_PREFIX}/`;

export const PUBLISH_MESSAGE = "larpable:preview:publish";
export const PUBLISHED_MESSAGE = "larpable:preview:published";
export const CLEAR_MESSAGE = "larpable:preview:clear";

/** The published reply the worker sends back, so a caller can assert the count. */
export interface PublishedReply {
  type: typeof PUBLISHED_MESSAGE;
  buildId: string;
  files: number;
}

/**
 * The slice of `ServiceWorker` this module uses.
 *
 * `statechange` is dispatched by a **`ServiceWorker`**, not by its registration: the
 * registration dispatches only `updatefound`. That distinction is not cosmetic. This module
 * once listened for `"statechange"` on the registration, which no browser ever sends, so on a
 * first visit the promise below was never resolved: every cold publish waited out the whole
 * timeout and then reported "the preview worker did not activate" while the worker was in
 * fact activating milliseconds later. The types here say so — `PreviewWorkerRegistration`
 * accepts only `"updatefound"`, so putting that listener back is a compile error.
 *
 * `state` is optional because not every engine implements `ServiceWorker.state`; when it is
 * absent the wait still works by polling `registration.active`.
 */
export interface PreviewWorker {
  /** `parsed` | `installing` | `installed` | `activating` | `activated` | `redundant`. */
  readonly state?: string;
  postMessage(message: unknown): void;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}

/** The slice of `ServiceWorkerRegistration` this module uses. */
export interface PreviewWorkerRegistration {
  readonly active: PreviewWorker | null;
  readonly installing: PreviewWorker | null;
  readonly waiting: PreviewWorker | null;
  /** The only event a registration dispatches; `statechange` belongs to the worker. */
  addEventListener(type: "updatefound", listener: () => void): void;
  removeEventListener(type: "updatefound", listener: () => void): void;
}

/** The slice of `ServiceWorkerContainer` this module uses. */
export interface PreviewWorkerContainer {
  register(
    scriptUrl: string,
    options?: { scope?: string; type?: "module" | "classic" },
  ): Promise<PreviewWorkerRegistration>;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface RegisterPreviewWorkerOptions {
  container: PreviewWorkerContainer;
  /** Defaults to `PREVIEW_WORKER_URL`. */
  scriptUrl?: string;
  /** Defaults to `PREVIEW_WORKER_SCOPE`. */
  scope?: string;
  /** How long to wait for the worker to activate. Default 15 s. */
  timeoutMs?: number;
  /** How often `registration.active` is re-read while waiting. Default 100 ms. */
  pollMs?: number;
}

/** A worker state, or "none" for a slot the registration has not filled. */
function describeWorker(worker: PreviewWorker | null): string {
  if (worker === null) return "none";
  return worker.state ?? "state unknown";
}

/**
 * The error for a worker that never got there, naming the state of each slot.
 *
 * The sentence has to be specific: "did not activate" alone sent a previous investigation
 * looking for a missing service worker when the real cause was a listener attached to an
 * object that never dispatches that event, and installing/active are what distinguish
 * "never registered" from "installed but discarded".
 */
function activationTimeout(
  timeoutMs: number,
  registration: PreviewWorkerRegistration,
): Error {
  return new Error(
    `The preview worker did not activate within ${String(timeoutMs)} ms ` +
      `(installing: ${describeWorker(registration.installing)}, ` +
      `waiting: ${describeWorker(registration.waiting)}, ` +
      `active: ${describeWorker(registration.active)}). ` +
      "Preview URLs are served directly from the guest instead; a reload retries registration.",
  );
}

/**
 * Wait until `registration.active` holds a worker that can answer `fetch` events.
 *
 * Three signals, because no one of them is enough:
 *
 * 1. `statechange` on the worker objects (`installing`, `waiting`, `active` — whichever the
 *    registration currently holds). This is the real event; it is *not* dispatched on the
 *    registration, which is the mistake this function exists to not repeat.
 * 2. `updatefound` on the registration, which is how a worker that installs *after*
 *    `register()` resolved becomes visible — its `installing` slot was still empty when the
 *    first listeners were attached.
 * 3. A poll of `registration.active`, because a worker can become active between two events,
 *    and because `ServiceWorker.state` is optional in some engines.
 *
 * A worker that reaches `redundant` during install can never activate: Chromium does that
 * when the script fails to install (a 404 or an HTML body at the script URL, a syntax error,
 * a rejected `install` handler). Waiting out the remaining timeout would report a symptom
 * seconds late, so that case fails at once and names the likely causes.
 *
 * Every listener and timer is released on both paths: a preview is republished on every
 * build, and a leak here would accumulate one interval per build.
 */
export async function waitForPreviewWorker(
  registration: PreviewWorkerRegistration,
  options: { timeoutMs: number; pollMs: number },
): Promise<void> {
  if (registration.active !== null) return;

  await new Promise<void>((resolve, reject) => {
    /** Workers this wait has attached to, so none is left with a listener. */
    const watched = new Set<PreviewWorker>();
    let settled = false;
    let poll: ReturnType<typeof setInterval> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;

    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (poll !== null) clearInterval(poll);
      if (deadline !== null) clearTimeout(deadline);
      for (const worker of watched) worker.removeEventListener("statechange", onStateChange);
      registration.removeEventListener("updatefound", onUpdateFound);
      if (error === undefined) resolve();
      else reject(error);
    };

    /** Attach to any worker slot that has been filled since the last call. */
    const watchAll = (): void => {
      for (const worker of [
        registration.installing,
        registration.waiting,
        registration.active,
      ]) {
        if (worker === null || watched.has(worker)) continue;
        watched.add(worker);
        worker.addEventListener("statechange", onStateChange);
      }
    };

    const checkActive = (): boolean => {
      if (registration.active === null) return false;
      settle();
      return true;
    };

    const checkDiscarded = (): boolean => {
      for (const worker of watched) {
        if (worker.state !== "redundant") continue;
        settle(
          new Error(
            "The preview worker was discarded while installing (state \"redundant\"). " +
              "Chromium does that when the worker script cannot be installed — an HTML page " +
              `or a 404 at ${PREVIEW_WORKER_URL}, a syntax error in it, or a rejected install ` +
              "handler. Preview URLs are served directly from the guest instead.",
          ),
        );
        return true;
      }
      return false;
    };

    function onStateChange(): void {
      if (checkActive() || checkDiscarded()) return;
      watchAll();
    }

    function onUpdateFound(): void {
      watchAll();
      // The new worker starts in `parsed`; `statechange` will follow, but a poll tick is a
      // cheap guard for an engine that has already moved on.
    }

    deadline = setTimeout(() => settle(activationTimeout(options.timeoutMs, registration)), options.timeoutMs);
    poll = setInterval(() => {
      watchAll();
      if (checkActive() || checkDiscarded()) return;
    }, options.pollMs);
    registration.addEventListener("updatefound", onUpdateFound);
    watchAll();
    checkActive();
  });
}

/**
 * Register the preview worker and wait until it can serve requests.
 *
 * Registering is not the same as being ready: on a first visit the worker installs and
 * activates after `register()` resolves, and a message sent before activation is
 * silently dropped. So this waits for an `active` worker and reports how long it took.
 */
export async function registerPreviewWorker(
  options: RegisterPreviewWorkerOptions,
): Promise<{ registration: PreviewWorkerRegistration; waited: boolean }> {
  const registration = await options.container.register(
    options.scriptUrl ?? PREVIEW_WORKER_URL,
    { scope: options.scope ?? PREVIEW_WORKER_SCOPE, type: "module" },
  );

  if (registration.active !== null) return { registration, waited: false };

  await waitForPreviewWorker(registration, {
    timeoutMs: options.timeoutMs ?? 15_000,
    pollMs: options.pollMs ?? 100,
  });

  return { registration, waited: true };
}

export interface PublishPreviewOptions {
  container: PreviewWorkerContainer;
  registration: PreviewWorkerRegistration;
  snapshot: PreviewSnapshot;
  /** How long to wait for the worker's confirmation. Default 30 s (a build can be MB). */
  timeoutMs?: number;
}

/**
 * Hand a build to the worker and wait for it to confirm how many files it accepted.
 *
 * The confirmation is not ceremony: a `postMessage` that no worker received also
 * "succeeds". Without the reply, a failed publish looks exactly like a successful one and
 * the iframe shows the previous build — the failure this whole design exists to prevent.
 */
export async function publishPreviewSnapshot(
  options: PublishPreviewOptions,
): Promise<PublishedReply> {
  const { registration, snapshot } = options;
  if (registration.active === null) {
    throw new Error(
      "The preview worker is not active, so there is nowhere to publish this build.",
    );
  }

  const timeoutMs = options.timeoutMs ?? 30_000;
  const reply = new Promise<PublishedReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      options.container.removeEventListener("message", onMessage);
      reject(
        new Error(
          `The preview worker did not confirm the build within ${String(timeoutMs)} ms. ` +
            "The iframe would have shown the previous build, so this publish is reported " +
            "as a failure.",
        ),
      );
    }, timeoutMs);

    function onMessage(event: MessageEvent): void {
      const data = event.data as Partial<PublishedReply> | null;
      if (data?.type !== PUBLISHED_MESSAGE) return;
      if (data.buildId !== snapshot.buildId) return;
      clearTimeout(timer);
      options.container.removeEventListener("message", onMessage);
      resolve({ type: PUBLISHED_MESSAGE, buildId: String(data.buildId), files: Number(data.files ?? 0) });
    }

    options.container.addEventListener("message", onMessage);
  });

  registration.active.postMessage({
    type: PUBLISH_MESSAGE,
    buildId: snapshot.buildId,
    fallbackPath: snapshot.fallbackPath,
    files: snapshot.files,
  });

  return reply;
}

/** Tell the worker to forget the build, so `/__preview__/…` stops answering. */
export function clearPublishedPreview(registration: PreviewWorkerRegistration): void {
  registration.active?.postMessage({ type: CLEAR_MESSAGE });
}

/**
 * `navigator.serviceWorker`, or null where the browser has none.
 *
 * A module worker is required: `public/preview-sw.js` is ESM, and registering it as a
 * classic worker fails with a parse error that says nothing about the real cause.
 */
export function browserWorkerContainer(
  navigatorLike: { serviceWorker?: unknown } = globalThis.navigator ?? {},
): PreviewWorkerContainer | null {
  const container = navigatorLike.serviceWorker as PreviewWorkerContainer | undefined;
  return container ?? null;
}
