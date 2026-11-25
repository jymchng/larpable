/**
 * The preview, backed by a *running* app instead of a directory of files.
 *
 * `proxy.ts` answers from a snapshot: a build's files were read once, and the preview serves
 * those bytes. That is exactly right for a Vite build and exactly wrong for anything that
 * listens on a port — Next.js's `/_next/image`, its server actions, a dev server's modules,
 * an Express route. Those bytes do not exist until the request does.
 *
 * So this module is the second half of the transport: given a path under
 * `/__preview__/<session>/`, it asks the running app (through the same `PreviewTransport`
 * the static path uses, so there is one timeout and one header normalisation), then applies
 * the three rewrites a proxied app needs:
 *
 * - **Root-absolute URLs are rebased onto the preview prefix.** Next emits
 *   `/_next/static/…`; the preview serves the app from `/__preview__/<session>/`, so those
 *   URLs would escape to the host app and 404. `rebaseDocument` already does this for build
 *   files; the same function is reused rather than reimplemented.
 * - **Module specifiers are rebased too.** A built bundle names its chunks relatively, but a
 *   *dev* server transforms one module at a time and leaves `from "/node_modules/.vite/deps/…"`
 *   root-absolute, which is the bug that made a Vite dev preview render as unstyled text: the
 *   first import escaped the prefix, the module graph collapsed, and Vite injects a project's
 *   CSS from JavaScript, so every stylesheet went with it.
 * - **Redirects keep their path under the prefix.** An app that answers `302 /login` must not
 *   navigate the *pane* out of the preview.
 *
 * What it deliberately does not do: rewrite URLs the app computes at runtime. `fetch("/api/status")`
 * or `history.pushState({}, "", "/x")` are values, not places the module graph names, and an
 * app that hard-codes them reaches the host origin — the honest answer is that the preview of a
 * *server* app is a proxy, not a deployment (documented in `docs/preview.md`).
 */

import {
  PREVIEW_DOCUMENT_HEADERS,
  cacheControlFor,
  isJavaScriptType,
  mimeTypeFor,
  previewBasePath,
  rebaseDocument,
  rebaseModule,
  rebaseStylesheet,
} from "./routing";
import type { PreviewTransport } from "./transport";

/** The result shape `proxy.ts` uses, so a caller can treat both modes alike. */
export interface AppPreviewResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface AppPreviewOptions {
  transport: PreviewTransport;
  /** Guest port the app listens on — part of the transport, kept for messages. */
  port: number;
  /** The session id used in the URL; the app's own routes live under it. */
  buildId: string;
  /** Budget for one request, in the transport. */
  timeoutMs?: number;
}

function text(status: number, message: string): AppPreviewResponse {
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...PREVIEW_DOCUMENT_HEADERS,
    },
    body: new TextEncoder().encode(message),
  };
}

/** The guest's own content type, or a guess from the path when it sent none. */
function contentTypeFor(path: string, headers: Record<string, string>): string {
  const sent = headers["content-type"];
  if (sent !== undefined && sent.trim().length > 0) return sent;
  return mimeTypeFor(path);
}

/**
 * Forward one path to the running app and return what the pane should serve.
 *
 * `path` is the preview-relative path *with* its leading slash (`/_next/static/x.js`,
 * `/api/health`, `/`). Errors are the preview's own, in its own words: a 502 that says the
 * guest app did not answer is worth more than a blank frame.
 */
export async function serveAppRequest(
  request: { path: string; method?: string },
  options: AppPreviewOptions,
): Promise<AppPreviewResponse> {
  const method = (request.method ?? "GET").toUpperCase();
  const path = request.path.length === 0 ? "/" : request.path;

  let answer;
  try {
    answer = await options.transport.fetch(path, { method: method === "HEAD" ? "GET" : method });
  } catch (error) {
    return text(
      502,
      `The app on port ${String(options.port)} did not answer for ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const type = contentTypeFor(path, answer.headers);
  const base = previewBasePath(options.buildId);
  const isDocument = type.startsWith("text/html");
  const isStylesheet = type.startsWith("text/css");
  const isScript = isJavaScriptType(type);

  // A redirect must stay inside the preview, or the click that caused it navigates the pane
  // to the host app (which answers with the app's own HTML in an iframe).
  let body = answer.body;
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": cacheControlFor(path),
    "x-content-type-options": "nosniff",
    "x-larpable-build": options.buildId,
    "x-larpable-served-by": "app",
    ...(isDocument ? PREVIEW_DOCUMENT_HEADERS : {}),
  };

  const location = answer.headers.location;
  if (location !== undefined) {
    headers.location = location.startsWith("/") && !location.startsWith("//") ? `${base}${location.slice(1)}` : location;
  }

  if (isDocument || isStylesheet || isScript) {
    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(answer.body);
    } catch {
      // Not text after all: serve the bytes as they came rather than half-rewriting them.
      return { status: answer.status, headers, body };
    }
    const rewritten = isDocument
      ? rebaseDocument(decoded, base)
      : isStylesheet
        ? rebaseStylesheet(decoded, base)
        : rebaseModule(decoded, base);
    body = new TextEncoder().encode(rewritten);
  }

  return {
    status: answer.status,
    headers,
    // HEAD promises headers, not bytes — the same rule the static path follows.
    body: method === "HEAD" ? new Uint8Array(0) : body,
  };
}
