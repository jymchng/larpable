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

/** The slice of `ServiceWorkerRegistration` this module uses. */
export interface PreviewWorkerRegistration {
  readonly active: { postMessage(message: unknown): void } | null;
  readonly installing: unknown;
  readonly waiting: unknown;
  addEventListener(type: "statechange" | string, listener: () => void): void;
  removeEventListener(type: "statechange" | string, listener: () => void): void;
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

  const timeoutMs = options.timeoutMs ?? 15_000;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `The preview worker did not activate within ${String(timeoutMs)} ms. Preview ` +
            "URLs are served directly from the guest instead; a reload retries registration.",
        ),
      );
    }, timeoutMs);

    const check = () => {
      if (registration.active !== null) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      registration.removeEventListener("statechange", check);
    };
    registration.addEventListener("statechange", check);
    // `installing`/`waiting` can already have changed state before the listener attached.
    check();
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
