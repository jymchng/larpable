/**
 * The rules a preview request is answered by, with no browser and no guest in sight.
 *
 * A preview is a web server that happens to run in two places at once: the guest holds
 * the built files, and the browser has to answer real URLs so that relative asset paths,
 * module imports and client-side routing behave the way they will on Netlify. The split
 * used here is deliberate:
 *
 * - **this module** decides everything that can be decided from a path: what the path
 *   means, which file answers it, what `Content-Type` it goes out with, whether it may be
 *   cached, and whether the build it belongs to is still the current one.
 * - the service worker (`public/preview-sw.js`) only does what needs a browser — hold the
 *   published bytes and answer `fetch` events — using decisions this module made. It
 *   carries no MIME table of its own, so there is exactly one place where a
 *   `Content-Type` can be wrong.
 * - the guest server (`guest-server.ts`) only does what needs a guest — read files from
 *   the publish directory and list them.
 *
 * PRD §12 asks for MIME types, nested paths, SPA fallback, binary assets and source maps
 * specifically, which is why each of those is a case here rather than an afterthought:
 * a source map served as `text/html` breaks devtools silently, and a JS asset served with
 * a wrong type is refused by the browser's module loader.
 */

/** Where preview URLs live. A prefix, so the app's own routes are never shadowed. */
export const PREVIEW_PREFIX = "/__preview__";

/** A preview request, after the URL has been understood. */
export interface PreviewTarget {
  /** The build the URL names. */
  buildId: string;
  /** Workspace-relative-ish path inside the build, always starting with `/`. */
  path: string;
  /** True when the URL points at a build that is no longer current. */
  stale: boolean;
}

/**
 * Understand a preview URL.
 *
 * `/__preview__/b-17/assets/app.js?v=2` → `{ buildId: "b-17", path: "/assets/app.js",
 * stale: false }` (given `currentBuildId === "b-17"`). Anything that is not a preview URL
 * — or a path that tries to escape the build — returns null, so the caller can fall
 * through to a 404 instead of guessing.
 */
export function parsePreviewUrl(rawUrl: string, currentBuildId: string | null): PreviewTarget | null {
  const url = rawUrl.startsWith("/") ? rawUrl : safePathOf(rawUrl);
  if (url === null) return null;

  // The prefix is matched at a segment boundary. `/__preview__x/…` is *not* a preview URL,
  // and treating it as one would let a build id be read out of a path the app owns.
  const withoutPrefix =
    url === PREVIEW_PREFIX || url.startsWith(`${PREVIEW_PREFIX}/`)
      ? url.slice(PREVIEW_PREFIX.length + 1)
      : null;
  if (withoutPrefix === null) return null;

  const [rawPath = ""] = withoutPrefix.split(/[?#]/, 1);
  const segments = rawPath.split("/").filter((segment) => segment.length > 0);
  const buildId = segments.shift();
  if (buildId === undefined || buildId.length === 0) return null;

  const path = normalisePreviewPath(`/${segments.join("/")}`);
  if (path === null) return null;

  return { buildId, path, stale: currentBuildId !== null && buildId !== currentBuildId };
}

function safePathOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return null;
  }
}

/**
 * Normalise a path inside the build, or reject it.
 *
 * `..` is rejected rather than resolved, because there is nothing outside the build to
 * resolve *to*: a preview server that walks upwards reads the workspace, and the workspace
 * is the project's own source — including a `.env` the user never meant to publish.
 * Percent-encoded dot segments (`%2e%2e`) and NUL bytes are rejected for the same reason;
 * a browser will decode them before it sends them, but a hand-written request need not.
 */
export function normalisePreviewPath(rawPath: string): string | null {
  const [pathOnly = ""] = rawPath.split(/[?#]/, 1);
  if (pathOnly.includes("\0")) return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    // A malformed escape is not a path. Answering 404 is honest; guessing is not.
    return null;
  }
  if (decoded.includes("\0")) return null;

  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return null;
    segments.push(segment);
  }

  return `/${segments.join("/")}` || "/";
}

/**
 * What a request for `path` is answered with, given the files the build contains.
 *
 * The fallback is passed in rather than assumed: a Vite SPA needs `/index.html`, an Astro
 * site needs none at all, and a static site has one file per route. Deciding it from the
 * path alone is how a preview ends up rendering the home page for every 404 — the exact
 * lie PRD §12 forbids.
 */
export type PreviewResolution =
  | { kind: "file"; path: string }
  | { kind: "fallback"; path: string; requested: string }
  | { kind: "missing"; path: string };

export function resolvePreviewPath(options: {
  path: string;
  /** Every file in the build, as `/`-prefixed paths. */
  files: Iterable<string>;
  /** `/index.html` for an SPA build, null when deep links are not rewritten. */
  fallbackPath: string | null;
}): PreviewResolution {
  const { fallbackPath } = options;
  // A directory request may arrive with a trailing slash (`/docs/`) or, after
  // `parsePreviewUrl`, without one. Both must find `/docs/index.html`; leaving the slash
  // in would look for `/docs//index.html`, which no build ever contains.
  const path =
    options.path.length > 1 ? options.path.replace(/\/+$/, "") : options.path;
  const known = new Set(options.files);
  const wanted = path === "/" ? "/index.html" : path;

  if (known.has(wanted)) return { kind: "file", path: wanted };
  // A directory request (`/docs/`) is answered by its index file when the build has one.
  if (known.has(`${wanted}/index.html`)) return { kind: "file", path: `${wanted}/index.html` };
  if (fallbackPath !== null && known.has(fallbackPath)) {
    return { kind: "fallback", path: fallbackPath, requested: path };
  }
  return { kind: "missing", path: wanted };
}

/** Extensions whose bytes are text and whose types browsers are picky about. */
export const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

/**
 * The `Content-Type` for a path.
 *
 * Unknown extensions get `application/octet-stream`, never `text/html`: a browser that is
 * told an unknown file is HTML will happily parse it as a document, which turns any
 * uploaded file into a script-execution path. `nosniff` goes out with every response for
 * the same reason.
 */
export function mimeTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  // A dotfile (`.env`) has no extension; a trailing dot (`.`) names nothing.
  if (dot <= 0) return "application/octet-stream";
  return MIME_TYPES[name.slice(dot)] ?? "application/octet-stream";
}

export function isSourceMap(path: string): boolean {
  return path.toLowerCase().endsWith(".map");
}

/**
 * Vite/Astro/CRA write `name-<hash>.ext` under `assets/` (or `static/`). Those bytes can
 * never change under the same name, so they are cached hard; everything else is
 * revalidated, because `index.html` is what changes between builds and a cached copy of it
 * is exactly how a preview shows the *previous* build.
 */
export function isImmutableAsset(path: string): boolean {
  return /\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i.test(path) && !path.endsWith(".html");
}

/** Cache policy for a path. */
export function cacheControlFor(path: string): string {
  if (isImmutableAsset(path)) return "public, max-age=31536000, immutable";
  if (path.endsWith(".html") || path === "/" || isSourceMap(path)) return "no-store";
  return "no-cache";
}

/**
 * The headers a *document* needs in order to be framed by this app at all.
 *
 * Measured, not assumed (Chromium 159, this app, `bun run dev`):
 *
 * - a `sandbox`ed iframe without `allow-same-origin` has an opaque origin and is **not** a
 *   service-worker client — the worker's `clients.matchAll()` does not list it and its
 *   `fetch` handler never sees the frame's navigation, so `/__preview__/<id>/` is answered
 *   by the dev server (and by Netlify's `/*` redirect in production) with the *app's* own
 *   `index.html`. That document then dies on `indexedDB` in an opaque origin: a blank pane;
 * - with `allow-same-origin` the worker *does* answer, but this app is cross-origin isolated
 *   (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`,
 *   see `vite.config.ts` and `netlify.toml`), and an embedded same-origin document without
 *   its own `Cross-Origin-Opener-Policy` is refused with `ERR_BLOCKED_BY_RESPONSE`.
 *
 * So a previewed document must carry `cross-origin-opener-policy: same-origin`,
 * `cross-origin-embedder-policy: require-corp` **and** `cross-origin-resource-policy:
 * cross-origin` itself — all three, measured: COOP alone still produced
 * `net::ERR_BLOCKED_BY_RESPONSE` on the frame's navigation, and adding COEP made the frame
 * render the build (stylesheet applied, module executed, `location.pathname` the preview
 * path).
 *
 * The cost of `require-corp` is real and worth stating: the previewed site becomes
 * cross-origin isolated, so a *third-party* asset it pulls without CORS (a font or image
 * from a CDN that sends no `Cross-Origin-Resource-Policy`) is blocked in the preview even
 * though it loads on the deployed site. The build's own files are unaffected: the worker
 * serves them from the same origin with `access-control-allow-origin` and
 * `cross-origin-resource-policy: cross-origin`. A preview that renders nothing is worse
 * than a preview that is stricter than production about third-party assets, and this is the
 * cheapest honest trade — the alternative, an opaque-origin frame, cannot be served by a
 * worker at all, and a truly separate preview origin is its own piece of work.
 */
export const PREVIEW_DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "cross-origin",
};

/** True for the build's HTML entry documents, which get `PREVIEW_DOCUMENT_HEADERS`. */
export function isPreviewDocument(path: string): boolean {
  return mimeTypeFor(path).startsWith("text/html");
}

/**
 * Response headers for a preview file.
 *
 * `x-larpable-build` is the staleness contract: the page reads it back to notice that the
 * bytes it received belong to a different build than the one it asked for, which is the
 * one failure mode a preview server must never hide.
 *
 * A document additionally gets `PREVIEW_DOCUMENT_HEADERS`, because those are not about the
 * file — they are about the browser allowing the frame to load it at all. Error bodies get
 * them too (`previewErrorHeaders`): a 503 shown in a frame is a *document* as well, and a
 * blocked one would replace this product's explanation with Chromium's error page.
 */
export function previewHeaders(options: {
  path: string;
  buildId: string;
  length?: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": mimeTypeFor(options.path),
    "cache-control": cacheControlFor(options.path),
    "x-content-type-options": "nosniff",
    "x-larpable-build": options.buildId,
    ...(isPreviewDocument(options.path) ? PREVIEW_DOCUMENT_HEADERS : {}),
  };
  if (options.length !== undefined) headers["content-length"] = String(options.length);
  return headers;
}

/** Headers for a plain-text failure body that an iframe may be showing. */
export function previewErrorHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...PREVIEW_DOCUMENT_HEADERS,
    ...extra,
  };
}

/**
 * Why a request cannot be answered, in a form the iframe can show.
 *
 * These are plain-text bodies on purpose: a preview error must not itself be a document
 * that runs script.
 */
export type PreviewFailure = {
  status: number;
  message: string;
};

export function previewFailure(options: {
  reason: "no-build" | "stale" | "missing" | "server";
  path: string;
  buildId?: string;
  currentBuildId?: string | null;
  detail?: string;
}): PreviewFailure {
  switch (options.reason) {
    case "no-build":
      return {
        status: 503,
        message:
          "No preview build has been published yet. Build the project, then open the preview again.",
      };
    case "stale":
      return {
        status: 409,
        message:
          `This page belongs to build ${options.buildId ?? "?"}, but the current build is ` +
          `${options.currentBuildId ?? "none"}. Reload the preview to see the current build.`,
      };
    case "missing":
      return {
        status: 404,
        message: `No file at ${options.path} in this build, and no single-page fallback is configured.`,
      };
    case "server":
      return {
        status: 502,
        message: `The guest file server did not answer for ${options.path}${options.detail ? `: ${options.detail}` : "."}`,
      };
  }
}

/**
 * The URL a build is previewed at, with the trailing slash a prefix needs.
 *
 * Exported here as well as in `preview-frame.tsx` because the *documents* need it, not just
 * the iframe: a build's own HTML is written for the site root, and the preview serves it
 * from a subpath.
 */
export function previewBasePath(buildId: string): string {
  return `${PREVIEW_PREFIX}/${encodeURIComponent(buildId)}/`;
}

/** An absolute path inside the build, or the value unchanged (`https://`, `//cdn`, `data:`). */
function rebaseValue(value: string, base: string): string {
  return value.startsWith("/") && !value.startsWith("//") ? `${base}${value.slice(1)}` : value;
}

/** Attributes that hold one URL. `srcset` is handled separately: it holds a list. */
const URL_ATTRIBUTE = /(\s(?:src|href|poster|action|formaction|data)\s*=\s*)(["'])([\s\S]*?)\2/gi;
const SRCSET_ATTRIBUTE = /(\ssrcset\s*=\s*)(["'])([\s\S]*?)\2/gi;
/**
 * `url(/x.woff2)` and `@import "/x.css"` inside a stylesheet, with the leading slash.
 *
 * The `(?<!new )` matters: this pattern is applied to JavaScript too (a dev server hands CSS
 * over as a module), where `new URL("/x", import.meta.url)` would otherwise match `URL(` and
 * get the prefix twice — once here, once from `MODULE_ASSET`.
 */
const CSS_URL = /(?<!new )(url\(\s*)(["']?)(\/)(?!\/)/gi;
const CSS_IMPORT = /(@import\s+)(["'])(\/)(?!\/)/gi;
/**
 * The module specifiers that survive into a *dev* server's response, with their leading slash.
 *
 * A dev server transforms per request and leaves import specifiers root-absolute — Vite emits
 * `import … from "/node_modules/.vite/deps/react.js?v=…"`, `import "/src/index.css"`,
 * `import("/src/x.tsx")` — because it assumes the app owns the origin root. Served from
 * `/__preview__/<id>/`, those escape to the host app and 404, so the whole module graph fails
 * and the page renders as unstyled text.
 *
 * Each pattern anchors on the syntactic position, not on the string: a specifier can only
 * appear after `from`, after a bare `import`, inside `import(`, inside `new URL(` (which is
 * how a module names an asset), or after `sourceMappingURL=`. A quoted `"/api/x"` passed to
 * `fetch()` is deliberately *not* matched — rewriting a runtime URL is a different question
 * from rewriting a static one, and guessing at it would break apps that compute paths.
 */
const MODULE_FROM = /(\bfrom\s*)(["'])(\/)(?!\/)/g;
const MODULE_BARE = /(\bimport\s+)(["'])(\/)(?!\/)/g;
const MODULE_DYNAMIC = /(\bimport\s*\(\s*)(["'])(\/)(?!\/)/g;
const MODULE_ASSET = /(\bnew\s+URL\s*\(\s*)(["'])(\/)(?!\/)/g;
const SOURCE_MAP = /(\/\/[#@]\s*sourceMappingURL=)(\/)(?!\/)/g;

/**
 * Rebase a document's root-absolute references onto the build's preview URL.
 *
 * This is the one rewrite the preview cannot avoid. A Vite build with the default
 * `base: "/"` emits `<script type="module" src="/assets/index-abc.js">` and
 * `<link rel="stylesheet" href="/assets/index-def.css">`. On Netlify those are correct; here
 * the same document is served from `/__preview__/<buildId>/`, so `/assets/…` would reach
 * the *app's* origin and 404 — a preview that renders as unstyled HTML with no script, which
 * looks exactly like a bug in the user's project.
 *
 * What is rewritten: `src`, `href`, `poster`, `action`, `formaction`, `data` and `srcset`
 * attributes whose value starts with a single `/`. What is left alone: `//cdn.example/x`
 * (protocol-relative, a different origin), `https://…`, `data:` and fragment-only values
 * (`#main`), because rewriting those would break them.
 *
 * Known limits, documented rather than pretended: a `<base href="/">` in the document wins
 * over the document URL, and a root-absolute URL built at runtime in JavaScript
 * (`new URL("/api", location.origin)`, `fetch("/config.json")`) is not text this module ever
 * sees. A site that needs either should build with a relative base (`base: "./"`), which is
 * what the scaffold's Vite template does.
 */
export function rebaseDocument(text: string, base: string): string {
  return text
    .replace(URL_ATTRIBUTE, (_match, prefix: string, quote: string, value: string) =>
      `${prefix}${quote}${rebaseValue(value, base)}${quote}`,
    )
    .replace(SRCSET_ATTRIBUTE, (_match, prefix: string, quote: string, value: string) =>
      `${prefix}${quote}${value
        .split(",")
        .map((candidate) => {
          const [url = "", ...descriptor] = candidate.trim().split(/\s+/);
          return [rebaseValue(url, base), ...descriptor].join(" ");
        })
        .join(", ")}${quote}`,
    )
    // An inline `<style>` block and a `style="…"` attribute are stylesheets too, and their
    // `url(/bg.svg)` is owed the same rewrite as a `.css` file's: a full-page background, a
    // `@font-face` source, a `cursor: url(…)` all escape the prefix otherwise. Measured against
    // a real Vite dev server: an inline style was the one request left pointing at the host app.
    .replace(CSS_URL, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`)
    .replace(CSS_IMPORT, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`);
}

/**
 * The same rewrite for a stylesheet: `url(/…)` and `@import "/…"`.
 *
 * The leading slash is *consumed* by the pattern rather than left in place: `base` already
 * ends in `/`, so keeping it produced `/__preview__/<id>//fonts/x.woff2` — a path with a
 * double slash, which the guest's server answers with 404 while the browser's own URL
 * handling hides the bug from a casual look.
 */
export function rebaseStylesheet(text: string, base: string): string {
  return text
    .replace(CSS_URL, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`)
    .replace(CSS_IMPORT, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`);
}

/**
 * The same rewrite for a JavaScript *module*: static imports, re-exports, dynamic `import()`,
 * `new URL("/asset", import.meta.url)` and `sourceMappingURL`.
 *
 * This is the rewrite that makes a *dev* server usable in the pane. A built bundle is
 * self-contained — chunks reference each other relatively — so the static preview never sees a
 * root-absolute specifier. A dev server is the opposite: it transforms one module at a time and
 * emits `from "/node_modules/.vite/deps/react.js?v=…"`, because it assumes its app owns the
 * origin root. Under `/__preview__/<id>/` those requests go to the *host* app instead, the
 * module graph collapses on the first import, and the page shows as unstyled text — Vite injects
 * a project's CSS from JavaScript, so one broken import costs every stylesheet.
 *
 * Only the specifier's leading slash is consumed (`base` already ends in one), so query strings
 * survive: `/src/index.css?import` becomes `/__preview__/<id>/src/index.css?import`, and Vite's
 * `?import`, `?direct` and `?v=` variants mean what they meant before.
 *
 * What is left alone, on purpose: relative (`./x.js`) and protocol-relative (`//cdn/x.js`)
 * specifiers, and *runtime* strings — `fetch("/api/status")`, `history.pushState`. Those are
 * values the app computes, not places the module graph names, and an app that hard-codes them
 * cannot be proxied from a subpath (see `docs/preview.md`).
 *
 * Source maps are approximate after this: the prefix shifts every column by its length. A dev
 * preview with slightly-shifted column numbers is worth more than no preview at all, and the
 * alternative — not rewriting — is a blank page.
 */
export function rebaseModule(text: string, base: string): string {
  return text
    .replace(MODULE_FROM, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`)
    .replace(MODULE_BARE, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`)
    .replace(MODULE_DYNAMIC, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`)
    .replace(MODULE_ASSET, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`)
    .replace(SOURCE_MAP, (_match, prefix: string) => `${prefix}${base}`)
    // A dev server hands a project's CSS over *as* a module: the stylesheet's bytes are a string
    // inside the script (`__vite__css = "body{background:url(/fonts/x.woff2)}"`). Its `url(/)`
    // references leave the prefix exactly like the module's imports do, so the stylesheet rule
    // is applied to scripts too — here, and only here.
    .replace(CSS_URL, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`)
    .replace(CSS_IMPORT, (_match, prefix: string, quote: string) => `${prefix}${quote}${base}`);
}

/** True for the content types a browser will execute as a module or classic script. */
export function isJavaScriptType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (
    type.startsWith("text/javascript") ||
    type.startsWith("application/javascript") ||
    type.startsWith("application/x-javascript") ||
    type.startsWith("application/ecmascript") ||
    type.startsWith("text/ecmascript")
  );
}

/**
 * The bytes a preview serves for one file of a build.
 *
 * Documents and stylesheets are rebased; everything else — images, fonts, source maps,
 * WebAssembly — is served byte-for-byte, because a byte changed in a `.map` breaks the
 * mapping and a byte changed in a PNG is a corrupt image.
 */
export function previewBody(path: string, body: Uint8Array, buildId: string): Uint8Array {
  const type = mimeTypeFor(path);
  const isDocument = type.startsWith("text/html");
  const isStylesheet = type.startsWith("text/css");
  if (!isDocument && !isStylesheet) return body;

  const base = previewBasePath(buildId);
  // A malformed UTF-8 document is not this module's problem to fix; leave the bytes alone
  // rather than half-rewriting them.
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return body;
  }

  const rewritten = isDocument ? rebaseDocument(text, base) : rebaseStylesheet(text, base);
  return new TextEncoder().encode(rewritten);
}
