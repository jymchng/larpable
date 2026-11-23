/**
 * The preview service worker: real URLs for a site that lives in the guest.
 *
 * A preview has to be reachable at URLs, not handed over as a string of HTML. A Vite
 * build emits `<script type="module" src="/assets/index-abc.js">`, CSS that references
 * `/assets/index-def.woff2`, dynamic `import()` calls, and an SPA router that reads
 * `location.pathname`. Faking any of that with a blob URL works until the first relative
 * import; a service worker gets it right because the browser resolves those URLs exactly
 * as it will on Netlify.
 *
 * The division of labour is the point of this file being small:
 *
 * - the page decides *what* a path means (`src/preview/routing.ts`): MIME type, cache
 *   policy, SPA fallback, staleness. It sends the finished decisions with the bytes.
 * - this worker does *only* what needs a service worker: hold the published snapshot in
 *   memory and answer `fetch` events from it.
 *
 * So there is one MIME table in the product, not two, and no `Content-Type` can disagree
 * between them. `tests/preview-service-worker.test.ts` imports this module directly and
 * asserts it against the routing module's decisions, so the two cannot drift apart
 * silently.
 *
 * It is a *module* worker (`type: "module"` at registration) with no imports, which is
 * what lets a test import it: the exports below are the same functions the `fetch` handler
 * calls, and the listeners are only registered when a service-worker scope exists.
 */

export const PREVIEW_PREFIX = "/__preview__";

/**
 * Where the worker's scope ends up. Registered with `scope: PREVIEW_PREFIX`, so the
 * browser only sends it preview requests and the app is untouched.
 */
const SCOPE = `${PREVIEW_PREFIX}/`;

/** One published build. Replaced wholesale, so a request sees one build or another. */
let snapshot = null;

function parsePath(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return null;
  }

  const withoutScope = pathname.startsWith(SCOPE) ? pathname.slice(SCOPE.length) : null;
  if (withoutScope === null) return null;

  const [buildId = "", ...rest] = withoutScope.split("/");
  if (buildId.length === 0) return null;

  const segments = [];
  for (const segment of rest) {
    if (segment === "" || segment === ".") continue;
    // Rejected, never resolved: there is nothing above the build to serve.
    if (segment === "..") return null;
    segments.push(segment);
  }

  return { buildId, path: `/${segments.join("/")}` };
}

/**
 * Answer one preview request.
 *
 * Exported rather than inlined in the listener so the routing can be tested without a
 * service-worker scope, a browser, or a guest. The order of the checks matters: an empty
 * state is "no build yet" (503) before it is "missing file" (404), and a stale build id is
 * refused (409) before its bytes are looked up — a preview must never serve the previous
 * build's HTML under the current build's URL.
 */
export function handlePreviewRequest(request, state) {
  const target = parsePath(request.url);
  if (target === null) return null;

  const current = state.snapshot;
  if (current === null) {
    return textResponse(
      503,
      "No preview build has been published yet. Build the project, then open the preview again.",
    );
  }

  if (target.buildId !== current.buildId) {
    return textResponse(
      409,
      `This page belongs to build ${target.buildId}, but the current build is ${current.buildId}. ` +
        "Reload the preview to see the current build.",
    );
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return textResponse(405, `The preview is read-only; ${request.method} is not answered.`, {
      allow: "GET, HEAD",
    });
  }

  const wanted = target.path === "/" ? "/index.html" : target.path;
  const direct = current.files.get(wanted) ?? current.files.get(`${wanted}/index.html`);
  if (direct !== undefined) return fileResponse(request, direct, current.buildId);

  if (current.fallbackPath !== null) {
    const fallback = current.files.get(current.fallbackPath);
    // 200, not 404: this is a rewrite, which is what Netlify does with the same rule.
    if (fallback !== undefined) return fileResponse(request, fallback, current.buildId);
  }

  return textResponse(
    404,
    `No file at ${wanted} in build ${current.buildId}, and no single-page fallback is configured.`,
    { "x-larpable-build": current.buildId },
  );
}

function fileResponse(request, file, buildId) {
  const headers = new Headers(file.headers);
  headers.set("x-larpable-build", buildId);
  // `file.headers` already carries the type, the cache policy and — for a document — the
  // COOP/COEP pair that lets this app frame it at all (`PREVIEW_DOCUMENT_HEADERS`). What is
  // added here is the pair that makes the build's *subresources* usable: the frame shares
  // this app's origin (a worker cannot answer an opaque one, which is why the sandbox has
  // `allow-same-origin`), and these bytes are a build's static output the page already
  // holds, so saying "any origin may use these" gives nothing away.
  headers.set("access-control-allow-origin", "*");
  headers.set("cross-origin-resource-policy", "cross-origin");
  // HEAD must not carry a body, and a module worker cannot stream one it never reads.
  const body = request.method === "HEAD" ? null : file.body;
  return new Response(body, { status: 200, headers });
}

function textResponse(status, message, extraHeaders = {}) {
  const headers = new Headers({
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // These bodies are often what an iframe is showing, and this app is cross-origin
    // isolated: without its own COOP the *document* is refused with
    // ERR_BLOCKED_BY_RESPONSE and the user gets Chromium's error page instead of the
    // sentence that explains what went wrong. Same headers as the build's HTML; see
    // PREVIEW_DOCUMENT_HEADERS in `src/preview/routing.ts`.
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cross-origin-resource-policy": "cross-origin",
    ...extraHeaders,
  });
  return new Response(message, { status, headers });
}

/**
 * Take a published snapshot.
 *
 * The page sends the bytes already typed and cache-decided (`routing.ts`), so all this
 * does is rebuild the map. It returns the count so the caller can assert that every file
 * arrived: a silently dropped asset is a preview that renders without its stylesheet.
 */
export function installSnapshot(message) {
  const files = new Map();
  for (const file of message.files ?? []) {
    files.set(file.path, {
      body: file.body,
      headers: file.headers ?? {},
      size: file.body?.byteLength ?? file.body?.size ?? 0,
    });
  }

  snapshot = {
    buildId: message.buildId,
    fallbackPath: message.fallbackPath ?? null,
    files,
    publishedAt: Date.now(),
  };
  return files.size;
}

export function currentBuildId() {
  return snapshot?.buildId ?? null;
}

export function clearSnapshot() {
  snapshot = null;
}

// ---------------------------------------------------------------------------
// Service-worker wiring
// ---------------------------------------------------------------------------

const inServiceWorker =
  typeof self !== "undefined" &&
  typeof globalThis.ServiceWorkerGlobalScope !== "undefined" &&
  self instanceof globalThis.ServiceWorkerGlobalScope;

if (inServiceWorker) {
  self.addEventListener("install", (event) => {
    // The worker is only useful once it controls a page, so it takes over at once.
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
  });

  self.addEventListener("message", (event) => {
    const message = event.data ?? {};
    if (message.type === "larpable:preview:publish") {
      const count = installSnapshot(message);
      event.source?.postMessage?.({
        type: "larpable:preview:published",
        buildId: message.buildId,
        files: count,
      });
    } else if (message.type === "larpable:preview:clear") {
      clearSnapshot();
    }
  });

  self.addEventListener("fetch", (event) => {
    const response = handlePreviewRequest(event.request, { get snapshot() { return snapshot; } });
    // `null` means "not a preview request": let the network have it, untouched.
    if (response !== null) event.respondWith(response);
  });
}
