/**
 * The host proxy: the rules that turn a preview URL into bytes that came out of the guest.
 *
 * The transport is a table here, so every case is about a decision rather than about a
 * VM: which `Content-Type` wins when the guest disagrees, what a stale build id does
 * before any fetch, what a 404 from a manifest-listed file means, and whether a binary
 * asset survives the round trip byte for byte. The last one is the reason this file
 * exists in the shape it does: a `Uint8Array`-through-`Response` path that happens to
 * work for HTML and mangles a PNG is a classic preview bug.
 */

import { describe, expect, it } from "vitest";

import { PREVIEW_MANIFEST_PATH } from "../src/preview/guest-server";
import {
  collectPreviewSnapshot,
  fileHeaders,
  servePreviewRequest,
  snapshotBuild,
  snapshotFiles,
  type PreviewBuild,
  type PreviewSnapshot,
} from "../src/preview/proxy";
import { PREVIEW_PREFIX, mimeTypeFor, cacheControlFor } from "../src/preview/routing";
import { PreviewTransportError, type PreviewHttpResponse, type PreviewTransport } from "../src/preview/transport";

interface FakeFile {
  status?: number;
  body: Uint8Array | string;
  headers?: Record<string, string>;
}

/**
 * A transport over a table of paths. It records what was asked for, so a test can assert
 * that the proxy did *not* go to the guest (a stale build) or went to the right file (a
 * directory index).
 */
function tableTransport(
  table: Record<string, FakeFile>,
  options: { throwFor?: string; fail?: (path: string) => Error | null } = {},
): PreviewTransport & { requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    async fetch(path, request = {}): Promise<PreviewHttpResponse> {
      requests.push(`${request.method ?? "GET"} ${path}`);
      const failure = options.fail?.(path);
      if (failure) throw failure;
      if (options.throwFor === path) throw new PreviewTransportError(`${path}: boom`);
      const entry = table[path];
      if (entry === undefined) return { status: 404, headers: {}, body: new Uint8Array(0) };
      const body =
        typeof entry.body === "string" ? new TextEncoder().encode(entry.body) : entry.body;
      return { status: entry.status ?? 200, headers: entry.headers ?? {}, body };
    },
  };
}

const encoder = new TextEncoder();

/** A small SPA build: index.html, two hashed assets, a source map, a nested page. */
function spaBuild(overrides: Partial<PreviewBuild> = {}): PreviewBuild {
  return {
    buildId: "b-7",
    fallbackPath: "/index.html",
    files: new Set([
      "/index.html",
      "/assets/index-abc12345.js",
      "/assets/index-def67890.css",
      "/assets/index-abc12345.js.map",
      "/docs/index.html",
    ]),
    ...overrides,
  };
}

function spaTable(): Record<string, FakeFile> {
  return {
    "/index.html": { body: "<!doctype html><div id=root></div>", headers: { "content-type": "text/html" } },
    // The guest's own answer says text/plain on purpose: the preview must not trust it.
    "/assets/index-abc12345.js": { body: "export const x=1;", headers: { "content-type": "text/plain" } },
    "/assets/index-def67890.css": { body: "body{margin:0}" },
    "/assets/index-abc12345.js.map": { body: "{}" },
    "/docs/index.html": { body: "<h1>docs</h1>" },
  };
}

describe("servePreviewRequest", () => {
  it("returns null for the app's own URLs, so it never shadows them", async () => {
    const answer = await servePreviewRequest(
      { url: "/app/editor" },
      { build: spaBuild(), transport: tableTransport(spaTable()) },
    );
    expect(answer).toBeNull();
  });

  it("reports that nothing is published before it reports a missing file", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/index.html` },
      { build: null, transport: tableTransport({}) },
    );
    expect(answer?.status).toBe(503);
    expect(new TextDecoder().decode(answer?.body)).toMatch(/no preview build/i);
  });

  it("refuses a stale build id without touching the guest", async () => {
    const transport = tableTransport(spaTable());
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-6/index.html` },
      { build: spaBuild({ buildId: "b-7" }), transport },
    );
    expect(answer?.status).toBe(409);
    expect(transport.requests).toEqual([]);
    expect(answer?.headers["x-larpable-build"]).toBe("b-7");
  });

  it("serves index.html for the build root", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/` },
      { build: spaBuild(), transport: tableTransport(spaTable()) },
    );
    expect(answer?.status).toBe(200);
    expect(new TextDecoder().decode(answer?.body)).toContain("id=root");
  });

  it("decides Content-Type itself, even when the guest answered differently", async () => {
    // This is the invariant the two-table bug broke: the guest said text/plain, and a
    // module served as text/plain is refused by the browser's module loader.
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/assets/index-abc12345.js` },
      { build: spaBuild(), transport: tableTransport(spaTable()) },
    );
    expect(answer?.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(answer?.headers["content-type"]).toBe(mimeTypeFor("/assets/index-abc12345.js"));
  });

  it("serves a source map as JSON and never stores it", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/assets/index-abc12345.js.map` },
      { build: spaBuild(), transport: tableTransport(spaTable()) },
    );
    expect(answer?.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(answer?.headers["cache-control"]).toBe("no-store");
  });

  it("answers a directory with its index file", async () => {
    const transport = tableTransport(spaTable());
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/docs` },
      { build: spaBuild(), transport },
    );
    expect(transport.requests).toEqual(["GET /docs/index.html"]);
    expect(new TextDecoder().decode(answer?.body)).toContain("docs");
  });

  it("rewrites a deep link to the SPA fallback with a 200", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/app/editor/settings` },
      { build: spaBuild(), transport: tableTransport(spaTable()) },
    );
    expect(answer?.status).toBe(200);
    expect(new TextDecoder().decode(answer?.body)).toContain("id=root");
  });

  it("404s a deep link when the build configured no fallback", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/app/editor` },
      { build: spaBuild({ fallbackPath: null }), transport: tableTransport(spaTable()) },
    );
    expect(answer?.status).toBe(404);
    expect(answer?.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(new TextDecoder().decode(answer?.body)).toMatch(/no single-page fallback/i);
  });

  it("passes binary bytes through unchanged", async () => {
    // Every byte value, so a UTF-8 round trip cannot accidentally pass.
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/logo.png` },
      {
        build: spaBuild({ files: new Set(["/index.html", "/logo.png"]) }),
        transport: tableTransport({ "/logo.png": { body: bytes } }),
      },
    );
    expect(answer?.status).toBe(200);
    expect(answer?.body).toEqual(bytes);
    expect(answer?.headers["content-type"]).toBe("image/png");
    expect(answer?.headers["content-length"]).toBe("256");
  });

  it("advertises the file's length on a HEAD and sends no body", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/index.html`, method: "HEAD" },
      { build: spaBuild(), transport: tableTransport(spaTable()) },
    );
    expect(answer?.status).toBe(200);
    expect(answer?.body.byteLength).toBe(0);
    expect(answer?.headers["content-length"]).toBe(String(encoder.encode("<!doctype html><div id=root></div>").length));
  });

  it("is read-only", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/index.html`, method: "POST" },
      { build: spaBuild(), transport: tableTransport(spaTable()) },
    );
    expect(answer?.status).toBe(405);
    expect(answer?.headers["allow"]).toBe("GET, HEAD");
  });

  it("reports an unreachable guest as a gateway failure, not a missing file", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/index.html` },
      {
        build: spaBuild(),
        transport: tableTransport(spaTable(), {
          fail: (path) => (path === "/index.html" ? new PreviewTransportError("/index.html: no answer within 10 ms") : null),
        }),
      },
    );
    expect(answer?.status).toBe(502);
    expect(new TextDecoder().decode(answer?.body)).toContain("no answer within 10 ms");
  });

  it("reports a guest 500 as a gateway failure and keeps its status in the message", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/index.html` },
      {
        build: spaBuild(),
        transport: tableTransport({ "/index.html": { status: 500, body: "boom" } }),
      },
    );
    expect(answer?.status).toBe(502);
    expect(new TextDecoder().decode(answer?.body)).toContain("500");
  });

  it("treats a 404 from the guest as a missing file", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/index.html` },
      { build: spaBuild(), transport: tableTransport({}) },
    );
    expect(answer?.status).toBe(404);
  });

  it("sends the headers a sandboxed iframe needs to load a module", async () => {
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-7/assets/index-abc12345.js` },
      { build: spaBuild(), transport: tableTransport(spaTable()) },
    );
    // No `allow-same-origin` in the iframe means an opaque origin, which makes this request
    // cross-origin; without ACAO the browser refuses the module.
    expect(answer?.headers["access-control-allow-origin"]).toBe("*");
    expect(answer?.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("fileHeaders", () => {
  it("agrees with the routing module for every file it types", () => {
    for (const path of ["/index.html", "/a.js", "/a.css", "/a.js.map", "/logo.png", "/x.bin"]) {
      const headers = fileHeaders(path, "b-1", 3);
      expect(headers["content-type"]).toBe(mimeTypeFor(path));
      expect(headers["cache-control"]).toBe(cacheControlFor(path));
    }
  });
});

describe("collectPreviewSnapshot", () => {
  function manifestTransport(files: Record<string, FakeFile>, listed: string[]) {
    const table: Record<string, FakeFile> = {
      [PREVIEW_MANIFEST_PATH]: {
        body: JSON.stringify({
          root: "/workspace/dist",
          files: listed.map((path) => ({ path, size: 1 })),
        }),
      },
      ...files,
    };
    return tableTransport(table);
  }

  it("fetches every listed file and decides its headers once", async () => {
    const transport = manifestTransport(
      {
        "/index.html": { body: "<html></html>" },
        "/assets/a-12345678.js": { body: "x" },
      },
      ["/index.html", "/assets/a-12345678.js"],
    );
    const snapshot = await collectPreviewSnapshot({
      buildId: "b-1",
      fallbackPath: "/index.html",
      transport,
    });
    expect(snapshot.buildId).toBe("b-1");
    expect(snapshot.fallbackPath).toBe("/index.html");
    expect(snapshot.files.map((file) => file.path).sort()).toEqual([
      "/assets/a-12345678.js",
      "/index.html",
    ]);
    expect(snapshot.files.every((file) => file.headers["x-larpable-build"] === "b-1")).toBe(true);
    const html = snapshot.files.find((file) => file.path === "/index.html");
    expect(html?.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(html?.headers["content-length"]).toBe(String("<html></html>".length));
  });

  it("asks for the manifest once, then one request per file", async () => {
    const transport = manifestTransport(
      { "/a.js": { body: "a" }, "/b.js": { body: "b" } },
      ["/a.js", "/b.js"],
    );
    await collectPreviewSnapshot({ buildId: "b-1", fallbackPath: null, transport });
    expect(transport.requests.filter((request) => request.endsWith(PREVIEW_MANIFEST_PATH)).length).toBe(1);
    expect(transport.requests.length).toBe(3);
  });

  it("refuses to publish an empty build", async () => {
    const transport = manifestTransport({}, []);
    await expect(
      collectPreviewSnapshot({ buildId: "b-1", fallbackPath: null, transport }),
    ).rejects.toThrow(/empty/);
  });

  it("refuses to publish when the manifest itself fails", async () => {
    const transport = tableTransport({});
    await expect(
      collectPreviewSnapshot({ buildId: "b-1", fallbackPath: null, transport }),
    ).rejects.toThrow(/manifest/);
  });

  it("refuses a partial build rather than previewing something quietly wrong", async () => {
    // The manifest lists a stylesheet the server then 404s: the build moved mid-publish.
    const transport = tableTransport({
      [PREVIEW_MANIFEST_PATH]: {
        body: JSON.stringify({ files: [{ path: "/index.html", size: 1 }, { path: "/gone.css", size: 1 }] }),
      },
      "/index.html": { body: "<html></html>" },
    });
    await expect(
      collectPreviewSnapshot({ buildId: "b-1", fallbackPath: null, transport }),
    ).rejects.toThrow(/changed while it was being published/);
  });

  it("reports a transport failure with the file that failed", async () => {
    const transport = tableTransport(
      { [PREVIEW_MANIFEST_PATH]: { body: JSON.stringify({ files: [{ path: "/a.js", size: 1 }] }) } },
      { throwFor: "/a.js" },
    );
    await expect(
      collectPreviewSnapshot({ buildId: "b-1", fallbackPath: null, transport }),
    ).rejects.toThrow(/\/a\.js/);
  });

  it("produces a snapshot the request handler can serve, including the fallback", async () => {
    const transport = manifestTransport(
      { "/index.html": { body: "<html></html>" }, "/a-12345678.css": { body: "x" } },
      ["/index.html", "/a-12345678.css"],
    );
    const snapshot: PreviewSnapshot = await collectPreviewSnapshot({
      buildId: "b-9",
      fallbackPath: "/index.html",
      transport,
    });
    const build = snapshotBuild(snapshot);
    expect(snapshotFiles(snapshot).has("/index.html")).toBe(true);
    // A deep link resolves through the fallback the snapshot recorded.
    const answer = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-9/app/route` },
      { build, transport },
    );
    expect(answer?.status).toBe(200);
    // And the previous build id is refused even though the bytes are still in the table.
    const stale = await servePreviewRequest(
      { url: `${PREVIEW_PREFIX}/b-8/index.html` },
      { build, transport },
    );
    expect(stale?.status).toBe(409);
  });
});
