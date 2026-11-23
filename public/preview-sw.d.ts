/**
 * Types for `preview-sw.js`, the preview service worker.
 *
 * The worker has to be a plain module file in `public/` — Vite copies it verbatim and the
 * browser registers it by URL — so it cannot be written in TypeScript. This declaration is
 * what lets `tests/preview-service-worker.test.ts` import it and still be type-checked.
 *
 * Keep it in step with the exports in `preview-sw.js`; the test fails loudly if a function
 * it uses disappears.
 */

export interface PreviewSnapshotFile {
  path: string;
  body: Uint8Array | string;
  headers?: Record<string, string>;
}

export interface PreviewSnapshotMessage {
  buildId: string;
  fallbackPath?: string | null;
  files: PreviewSnapshotFile[];
}

export interface PreviewWorkerState {
  readonly snapshot: {
    buildId: string;
    fallbackPath: string | null;
    files: Map<string, { body: Uint8Array | string; headers: Record<string, string>; size: number }>;
    publishedAt: number;
  } | null;
}

export const PREVIEW_PREFIX: string;

export function handlePreviewRequest(
  request: { url: string; method?: string },
  state: PreviewWorkerState,
): Response | null;

export function installSnapshot(message: PreviewSnapshotMessage): number;

export function currentBuildId(): string | null;

export function clearSnapshot(): void;

/** The session a running app is being forwarded under, or null in static mode. */
export function installForwarder(message: {
  buildId: string | null;
  timeoutMs?: number;
}): string | null;

export function clearForwarder(): void;

export function forwarderBuildId(): string | null;

export interface ForwardRequestOptions {
  requestId?: string;
  /** How long a *claimed* request may take. Default 30 s. */
  timeoutMs?: number;
  /** How long a page has to claim the request. Default 2 s. */
  ownershipMs?: number;
  /** What to answer when no page claims the request: the snapshot path's own response. */
  fallback?: () => Response;
  post: (message: unknown) => void;
}

/**
 * Ask the pages for one request's bytes.
 *
 * Resolves with the claiming page's answer, with `fallback()` when no page claims it inside the
 * ownership window, or with a 504 when a claim is never answered.
 */
export function forwardRequest(
  request: { url: string; method?: string },
  options: ForwardRequestOptions,
): Promise<Response>;

export function settleForward(message: {
  requestId: string;
  status?: number;
  headers?: Record<string, string>;
  body?: ArrayBuffer | null;
}): boolean;

export function claimForward(message: { requestId: string }): boolean;
