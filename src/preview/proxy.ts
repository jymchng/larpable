/**
 * The host half of the preview: a proxy that answers preview URLs out of the guest.
 *
 * Two jobs, in this order, because the second is built out of the first:
 *
 * 1. **serve** — given a preview URL, decide what it means with `routing.ts`, ask the
 *    guest's server for those bytes through `PreviewTransport`, and return a response the
 *    caller can hand to a `Response` constructor. This is the path used when no service
 *    worker controls the page (first load, a browser that refused registration, a
 *    screenshot harness). It is also the code that decides what `Content-Type` a file
 *    goes out with: the guest's own answer is *not* trusted for that, because the guest
 *    server is a generic static file server and the preview's single MIME table lives in
 *    `routing.ts`.
 * 2. **publish** — walk the guest's manifest once, fetch every file, and return a
 *    snapshot whose headers were decided by the same routing module. The service worker
 *    holds that snapshot so a previewed page's own asset requests never make a round trip
 *    into the guest.
 *
 * Staleness is a first-class outcome in both: a URL that names an old build is refused
 * with 409, never answered with the current build's bytes. A preview that quietly serves
 * the previous build is worse than one that says "reload".
 */

import { PREVIEW_MANIFEST_PATH } from "./guest-server";
import {
  parsePreviewUrl,
  previewFailure,
  previewHeaders,
  resolvePreviewPath,
} from "./routing";
import { PreviewTransportError, type PreviewTransport } from "./transport";

/** A response the caller can turn into a `Response` (or assert against in a test). */
export interface PreviewHttpResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The build currently published, as routing needs it. */
export interface PreviewBuild {
  buildId: string;
  /** `/index.html` for an SPA build; null when deep links are not rewritten. */
  fallbackPath: string | null;
  /** Every file in the build, `/`-prefixed. */
  files: ReadonlySet<string>;
}

export interface PreviewState {
  /** null until a build has been published. */
  build: PreviewBuild | null;
  transport: PreviewTransport;
}

/**
 * Answer one preview request, or return null when the URL is not a preview URL.
 *
 * Null is what lets a caller wire this into a `fetch` handler without shadowing the app's
 * own routes: "not mine" is a distinct answer from "no such file".
 */
export async function servePreviewRequest(
  request: { url: string; method?: string },
  state: PreviewState,
): Promise<PreviewHttpResult | null> {
  const target = parsePreviewUrl(request.url, state.build?.buildId ?? null);
  if (target === null) return null;

  const method = (request.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return text(405, `The preview is read-only; ${method} is not answered.`, {
      allow: "GET, HEAD",
    });
  }

  if (state.build === null) {
    const failure = previewFailure({ reason: "no-build", path: target.path });
    return text(failure.status, failure.message);
  }

  const build = state.build;
  if (target.buildId !== build.buildId) {
    // Checked before the file lookup, so a stale page cannot be answered with the new
    // build's bytes and look correct in a screenshot.
    const failure = previewFailure({
      reason: "stale",
      path: target.path,
      buildId: target.buildId,
      currentBuildId: build.buildId,
    });
    return text(failure.status, failure.message, { "x-larpable-build": build.buildId });
  }

  const resolution = resolvePreviewPath({
    path: target.path,
    files: build.files,
    fallbackPath: build.fallbackPath,
  });

  if (resolution.kind === "missing") {
    const failure = previewFailure({ reason: "missing", path: resolution.path });
    return text(failure.status, failure.message, { "x-larpable-build": build.buildId });
  }

  let answer;
  try {
    answer = await state.transport.fetch(resolution.path, { method: "GET" });
  } catch (error) {
    // The guest is the thing that failed, not the file. 502 says so; a 404 here would
    // send the user looking for a missing asset that is actually there.
    const failure = previewFailure({
      reason: "server",
      path: resolution.path,
      detail: error instanceof PreviewTransportError ? error.message : String(error),
    });
    return text(failure.status, failure.message, { "x-larpable-build": build.buildId });
  }

  if (answer.status === 404) {
    const failure = previewFailure({ reason: "missing", path: resolution.path });
    return text(failure.status, failure.message, { "x-larpable-build": build.buildId });
  }

  if (answer.status !== 200) {
    const failure = previewFailure({
      reason: "server",
      path: resolution.path,
      detail: `the guest answered ${String(answer.status)}`,
    });
    return text(failure.status, failure.message, { "x-larpable-build": build.buildId });
  }

  return {
    status: 200,
    headers: fileHeaders(resolution.path, build.buildId, answer.body.byteLength),
    // HEAD promises headers, not bytes.
    body: method === "HEAD" ? new Uint8Array(0) : answer.body,
  };
}

/**
 * The headers a preview file goes out with.
 *
 * `Content-Type` and `cache-control` come from `routing.ts` even though the guest sent
 * its own: the guest is a generic file server, and the preview's cache policy (HTML must
 * not be stored; a hashed asset may be) is a decision about *this* product, not about
 * that server.
 */
export function fileHeaders(path: string, buildId: string, length: number): Record<string, string> {
  return {
    ...previewHeaders({ path, buildId, length }),
    // The iframe is deliberately an opaque origin (`sandbox` without `allow-same-origin`),
    // which makes its module requests CORS requests. `*` is safe here: these are static
    // build bytes, and the worker answers nothing that is not already public to the page.
    "access-control-allow-origin": "*",
  };
}

function text(
  status: number,
  message: string,
  extra: Record<string, string> = {},
): PreviewHttpResult {
  return {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
    body: new TextEncoder().encode(message),
  };
}

/** One file of a published build, with the headers the worker will serve it with. */
export interface PreviewSnapshotFile {
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** The message the page sends to the service worker. */
export interface PreviewSnapshot {
  buildId: string;
  fallbackPath: string | null;
  files: PreviewSnapshotFile[];
}

export interface CollectSnapshotOptions {
  /** The id of the build being published. New on every build, never reused. */
  buildId: string;
  fallbackPath: string | null;
  transport: PreviewTransport;
  /** How many files to fetch at once. The guest is local; this bounds queue growth. */
  concurrency?: number;
}

/**
 * Read the whole build out of the guest and decide every header once, on the host.
 *
 * Fetching every file up front is a choice: it makes the worker's answer synchronously
 * correct (a previewed page's `import()` cannot 404 on a file that exists), and it makes
 * "this build is complete" a fact rather than a hope. The cost is one pass over `dist/`
 * per build, which for a Vite site is a few dozen small files.
 *
 * It fails loudly instead of publishing a partial build: a snapshot missing its
 * stylesheet renders as unstyled HTML, which looks like a CSS bug in the user's project.
 */
export async function collectPreviewSnapshot(
  options: CollectSnapshotOptions,
): Promise<PreviewSnapshot> {
  const manifest = await readManifest(options.transport);
  const paths = manifest.map((entry) => entry.path).filter((path) => path.startsWith("/"));
  if (paths.length === 0) {
    throw new Error(
      `The build at ${PREVIEW_MANIFEST_PATH} is empty: there is nothing to preview. ` +
        "Run the project's build command and check its publish directory.",
    );
  }

  const files: PreviewSnapshotFile[] = new Array<PreviewSnapshotFile>(paths.length);
  let next = 0;
  const workers = Math.min(options.concurrency ?? 4, paths.length);

  async function pump(): Promise<void> {
    for (;;) {
      const index = next++;
      const path = paths[index];
      if (path === undefined) return;
      let answer;
      try {
        answer = await options.transport.fetch(path, { method: "GET" });
      } catch (error) {
        throw new Error(
          `The guest did not answer for ${path}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (answer.status !== 200) {
        // A file the manifest listed but the server will not serve means the build moved
        // under us. Publishing the rest would produce a preview that is quietly wrong.
        throw new Error(
          `The guest answered ${String(answer.status)} for ${path} after listing it in the ` +
            "manifest; the build changed while it was being published.",
        );
      }
      files[index] = {
        path,
        headers: fileHeaders(path, options.buildId, answer.body.byteLength),
        body: answer.body,
      };
    }
  }

  await Promise.all(Array.from({ length: workers }, () => pump()));

  return { buildId: options.buildId, fallbackPath: options.fallbackPath, files };
}

/** The file set of a snapshot, for `resolvePreviewPath`. */
export function snapshotFiles(snapshot: PreviewSnapshot): ReadonlySet<string> {
  return new Set(snapshot.files.map((file) => file.path));
}

/** A snapshot as the `PreviewBuild` the request handler takes. */
export function snapshotBuild(snapshot: PreviewSnapshot): PreviewBuild {
  return {
    buildId: snapshot.buildId,
    fallbackPath: snapshot.fallbackPath,
    files: snapshotFiles(snapshot),
  };
}

async function readManifest(
  transport: PreviewTransport,
): Promise<{ path: string; size: number }[]> {
  let answer;
  try {
    answer = await transport.fetch(PREVIEW_MANIFEST_PATH, { method: "GET" });
  } catch (error) {
    throw new Error(
      "The guest's preview server did not answer its manifest, so there is nothing to " +
        `publish: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (answer.status !== 200) {
    throw new Error(
      `The guest's preview server answered ${String(answer.status)} for its manifest.`,
    );
  }
  const decoded = JSON.parse(new TextDecoder().decode(answer.body)) as {
    files?: { path?: unknown; size?: unknown }[];
  };
  const files = decoded.files ?? [];
  return files
    .filter((file): file is { path: string; size: number } => typeof file.path === "string")
    .map((file) => ({ path: file.path, size: Number(file.size ?? 0) }));
}
