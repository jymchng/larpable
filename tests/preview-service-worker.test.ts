/**
 * The preview service worker, tested against the routing module rather than against
 * itself.
 *
 * The worker exists so a preview has real URLs. It is deliberately dumb: it holds the
 * published snapshot and answers `fetch` events, and every decision that can be *wrong*
 * (MIME type, cache policy) is made once in `src/preview/routing.ts`. These tests hold
 * the two together — a worker with its own MIME table would pass its own tests and still
 * serve a module as `text/html`.
 */

import { describe, expect, it } from "vitest";

import {
  mimeTypeFor,
  previewHeaders,
  cacheControlFor,
} from "../src/preview/routing";
// The worker is a plain module with no imports, which is what makes it importable here.
import {
  PREVIEW_PREFIX,
  claimForward,
  clearSnapshot,
  currentBuildId,
  forwardRequest,
  handlePreviewRequest,
  installSnapshot,
  settleForward,
} from "../public/preview-sw.js";

type WorkerFile = { path: string; body: Uint8Array | string; headers?: Record<string, string> };

interface WorkerSnapshot {
  buildId: string;
  fallbackPath: string | null;
  files: Map<string, { body: Uint8Array | string; headers: Record<string, string>; size: number }>;
  publishedAt: number;
}

/** A snapshot shaped exactly as `installSnapshot` builds it, with real routing headers. */
function snapshotOf(buildId: string, files: WorkerFile[], fallbackPath: string | null): WorkerSnapshot {
  const map: WorkerSnapshot["files"] = new Map();
  for (const file of files) {
    map.set(file.path, {
      body: file.body,
      headers: file.headers ?? previewHeaders({ path: file.path, buildId }),
      size: file.body instanceof Uint8Array ? file.body.byteLength : file.body.length,
    });
  }
  return { buildId, fallbackPath, files: map, publishedAt: 0 };
}

function requestFor(path: string, method = "GET"): Request {
  return new Request(`https://larpable.netlify.app${PREVIEW_PREFIX}/${path}`, { method });
}

/** The worker's own view of state: it reads `state.snapshot` on every request. */
function stateOf(snapshot: WorkerSnapshot | null) {
  return {
    get snapshot() {
      return snapshot;
    },
  };
}

describe("handlePreviewRequest", () => {
  const files: WorkerFile[] = [
    { path: "/index.html", body: "<!doctype html><div id=root></div>" },
    { path: "/assets/index-abc12345.js", body: "export const x = 1;" },
    { path: "/assets/index-def67890.css", body: "body{margin:0}" },
    { path: "/assets/index-abc12345.js.map", body: "{}" },
  ];

  it("serves the build's index for the build root", async () => {
    const response = handlePreviewRequest(requestFor("b-1"), stateOf(snapshotOf("b-1", files, "/index.html")));
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    expect(await response?.text()).toContain("id=root");
  });

  it("serves a JS asset with exactly the type the routing module decided", async () => {
    const response = handlePreviewRequest(
      requestFor("b-1/assets/index-abc12345.js"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    expect(response?.headers.get("content-type")).toBe(mimeTypeFor("/assets/index-abc12345.js"));
    expect(response?.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  });

  it("keeps every file's cache policy in agreement with the routing module", () => {
    const snapshot = snapshotOf("b-1", files, "/index.html");
    for (const file of files) {
      const response = handlePreviewRequest(requestFor(`b-1${file.path}`), stateOf(snapshot));
      expect(response?.headers.get("cache-control")).toBe(cacheControlFor(file.path));
    }
  });

  it("serves a source map as JSON, so devtools can read it", () => {
    const response = handlePreviewRequest(
      requestFor("b-1/assets/index-abc12345.js.map"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    expect(response?.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("stamps every file response with the build it came from", () => {
    const response = handlePreviewRequest(
      requestFor("b-1/index.html"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    expect(response?.headers.get("x-larpable-build")).toBe("b-1");
  });

  it("rewrites an unknown path to the SPA fallback with a 200", () => {
    const response = handlePreviewRequest(
      requestFor("b-1/app/editor"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    // A rewrite, not a redirect and not a 404: this is what Netlify does with the same rule.
    expect(response?.status).toBe(200);
  });

  it("404s an unknown path when the build configured no fallback", () => {
    const response = handlePreviewRequest(
      requestFor("b-1/nope"),
      stateOf(snapshotOf("b-1", files, null)),
    );
    expect(response?.status).toBe(404);
    expect(response?.headers.get("x-larpable-build")).toBe("b-1");
  });

  it("says no build has been published rather than 404ing every file", () => {
    const response = handlePreviewRequest(requestFor("b-1/index.html"), stateOf(null));
    expect(response?.status).toBe(503);
    expect(response?.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a stale build id before it looks up any bytes", async () => {
    // The page belongs to b-16; the snapshot is b-17. Serving b-17's HTML under b-16's URL
    // is the one thing a preview must never do quietly.
    const response = handlePreviewRequest(
      requestFor("b-16/index.html"),
      stateOf(snapshotOf("b-17", files, "/index.html")),
    );
    expect(response?.status).toBe(409);
    const body = await response?.text();
    expect(body).toContain("b-16");
    expect(body).toContain("b-17");
  });

  it("refuses a stale build even for a POST, because staleness is decided first", () => {
    const response = handlePreviewRequest(
      requestFor("b-16/index.html", "POST"),
      stateOf(snapshotOf("b-17", files, "/index.html")),
    );
    expect(response?.status).toBe(409);
  });

  it("is read-only", () => {
    const response = handlePreviewRequest(
      requestFor("b-1/index.html", "POST"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    expect(response?.status).toBe(405);
    expect(response?.headers.get("allow")).toBe("GET, HEAD");
  });

  it("answers HEAD with headers and no body", async () => {
    const response = handlePreviewRequest(
      requestFor("b-1//index.html", "HEAD"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("");
  });

  it("leaves non-preview requests alone, so the app still reaches its own files", () => {
    const notPreview = new Request("https://larpable.netlify.app/app/editor");
    expect(handlePreviewRequest(notPreview, stateOf(null))).toBeNull();
  });

  it("returns null for a path that escapes the build, instead of resolving it", () => {
    const escaping = new Request(`https://larpable.netlify.app${PREVIEW_PREFIX}/b-1/../../.env`);
    expect(handlePreviewRequest(escaping, stateOf(snapshotOf("b-1", files, null)))).toBeNull();
  });

  it("marks error bodies as plain text with nosniff", () => {
    const response = handlePreviewRequest(requestFor("b-1/nope"), stateOf(snapshotOf("b-1", files, null)));
    expect(response?.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

/**
 * The headers without which the preview renders nothing at all.
 *
 * Measured (Chromium 159, `bun run dev`): this app is cross-origin isolated, and an embedded
 * same-origin document that does not carry its own `Cross-Origin-Opener-Policy` is refused
 * with `net::ERR_BLOCKED_BY_RESPONSE`. That was the blank pane. The worker builds these
 * headers itself — it is a plain module with no imports — so the routing tests cannot
 * cover it, and until these tests existed deleting two lines here broke the product while
 * every test stayed green.
 */
describe("document headers", () => {
  const files: WorkerFile[] = [
    { path: "/index.html", body: "<!doctype html><div id=root></div>" },
    { path: "/assets/index-abc12345.css", body: "body{margin:0}" },
  ];

  function expectDocumentHeaders(headers: Headers | undefined, label: string): void {
    expect(headers?.get("cross-origin-opener-policy"), label).toBe("same-origin");
    expect(headers?.get("cross-origin-embedder-policy"), label).toBe("require-corp");
    expect(headers?.get("cross-origin-resource-policy"), label).toBe("cross-origin");
  }

  it("sends COOP, COEP and CORP with the build's HTML", () => {
    const response = handlePreviewRequest(
      requestFor("b-1/index.html"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    expectDocumentHeaders(response?.headers, "index.html");
  });

  it("sends them with the SPA fallback, which is the same document under another URL", () => {
    const response = handlePreviewRequest(
      requestFor("b-1/app/editor"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    expect(response?.status).toBe(200);
    expectDocumentHeaders(response?.headers, "/app/editor");
  });

  // A failure body is often the document the frame is showing: without its own COOP the
  // browser replaces the sentence that explains the failure with an error page of its own,
  // which is precisely the blank pane the explanation exists to prevent.
  it("sends them with the 503, 409 and 404 bodies an iframe may be showing", () => {
    const cases: Array<[string, Request, ReturnType<typeof stateOf>]> = [
      ["503 no build", requestFor("b-1/index.html"), stateOf(null)],
      [
        "409 stale build",
        requestFor("b-16/index.html"),
        stateOf(snapshotOf("b-17", files, "/index.html")),
      ],
      ["404 missing file", requestFor("b-1/nope"), stateOf(snapshotOf("b-1", files, null))],
    ];
    for (const [label, request, state] of cases) {
      const response = handlePreviewRequest(request, state);
      expect(response?.status, label).not.toBe(200);
      expectDocumentHeaders(response?.headers, label);
    }
  });

  it("does not hand a stylesheet the document headers it does not need", () => {
    const response = handlePreviewRequest(
      requestFor("b-1/assets/index-abc12345.css"),
      stateOf(snapshotOf("b-1", files, "/index.html")),
    );
    expect(response?.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(response?.headers.get("content-security-policy")).toBeNull();
  });
});

describe("installSnapshot", () => {
  it("reports how many files arrived, so a dropped asset cannot pass silently", () => {
    clearSnapshot();
    expect(currentBuildId()).toBeNull();
    const count = installSnapshot({
      buildId: "b-9",
      fallbackPath: "/index.html",
      files: [
        { path: "/index.html", body: "<html></html>", headers: {} },
        { path: "/assets/a.js", body: "x", headers: {} },
      ],
    });
    expect(count).toBe(2);
    expect(currentBuildId()).toBe("b-9");
    clearSnapshot();
    expect(currentBuildId()).toBeNull();
  });

  it("defaults the fallback to none, so a static site never invents a rewrite", () => {
    clearSnapshot();
    installSnapshot({ buildId: "b-10", files: [] });
    const response = handlePreviewRequest(
      new Request(`https://larpable.netlify.app${PREVIEW_PREFIX}/b-10/nope`),
      {
        get snapshot() {
          return { buildId: "b-10", fallbackPath: null, files: new Map(), publishedAt: 0 };
        },
      },
    );
    expect(response?.status).toBe(404);
    clearSnapshot();
  });
});

/**
 * Forwarding, and the one thing a worker cannot know by itself.
 *
 * A forwarded session lives in the *page*, not in the worker: the worker's memory does not survive
 * a restart (Chromium stops an idle worker after ~30 s, and a new script version replaces it), so a
 * preview that had been attached and working could revert to "No preview build has been published
 * yet" with nothing to explain it. Hence the claim: the worker asks, the page that owns the session
 * answers in one hop, and only then does the long budget for the guest apply. These tests hold the
 * three outcomes together — nobody claims (snapshot answer), somebody claims and answers (their
 * bytes), somebody claims and goes quiet (504, not a hang).
 */
describe("forwardRequest", () => {
  const request = () => new Request(`https://larpable.netlify.app${PREVIEW_PREFIX}/dev-1/`);

  it("answers from the snapshot path when no page claims the request", async () => {
    // The fallback is what this worker would have replied before forwarding existed, so a session
    // nobody forwards is answered exactly as it always was — just after the ownership window.
    const response = await forwardRequest(request(), {
      requestId: "own-1",
      post: () => undefined,
      ownershipMs: 5,
      fallback: () => new Response("no build yet", { status: 503 }),
    });

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("no build yet");
  });

  it("serves the claiming page's bytes, however slow the guest is", async () => {
    const response = forwardRequest(request(), {
      requestId: "own-2",
      post: () => undefined,
      ownershipMs: 5,
      timeoutMs: 1_000,
      fallback: () => new Response("no build yet", { status: 503 }),
    });

    // The claim arrives at once; the bytes arrive later than the ownership window, which is the
    // whole point: a first Vite compile takes seconds, and it must not lose its own session.
    expect(claimForward({ requestId: "own-2" })).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    settleForward({
      requestId: "own-2",
      status: 200,
      headers: { "content-type": "text/html" },
      body: new TextEncoder().encode("<html>vite</html>").buffer,
    });

    const settled = await response;
    expect(settled.status).toBe(200);
    expect(settled.headers.get("x-larpable-served-by")).toBe("app");
    expect(await settled.text()).toBe("<html>vite</html>");
  });

  it("turns a claimed-but-unanswered request into a 504 instead of a hang", async () => {
    const response = forwardRequest(request(), {
      requestId: "own-3",
      post: () => undefined,
      ownershipMs: 100,
      timeoutMs: 5,
      fallback: () => new Response("no build yet", { status: 503 }),
    });
    claimForward({ requestId: "own-3" });

    const settled = await response;
    expect(settled.status).toBe(504);
    expect(await settled.text()).toContain("did not answer");
  });

  it("ignores a claim for a request it is not waiting on", () => {
    expect(claimForward({ requestId: "never-sent" })).toBe(false);
    expect(settleForward({ requestId: "never-sent", status: 200 })).toBe(false);
  });
});
