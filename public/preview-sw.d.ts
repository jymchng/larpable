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
