import { describe, expect, it } from "vitest";

import { serveAppRequest } from "../src/preview/app-preview";
import type { PreviewTransport } from "../src/preview/transport";

const NEXT_HTML =
  '<!doctype html><html><head><link rel="stylesheet" href="/_next/static/css/app.css">' +
  '</head><body><div id="root"></div>' +
  '<script src="/_next/static/chunks/main.js"></script></body></html>';

/** A transport that answers from a table, so these tests need no guest. */
function transport(
  table: Record<string, { status?: number; headers?: Record<string, string>; body?: string | Uint8Array }>,
  seen: string[] = [],
): PreviewTransport {
  return {
    async fetch(path) {
      seen.push(path);
      const answer = table[path] ?? { status: 404, body: "not found" };
      return {
        status: answer.status ?? 200,
        headers: answer.headers ?? { "content-type": "text/html; charset=utf-8" },
        body:
          typeof answer.body === "string"
            ? new TextEncoder().encode(answer.body)
            : (answer.body ?? new Uint8Array()),
      };
    },
  };
}

describe("serveAppRequest", () => {
  it("rebases a Next document's root-absolute URLs onto the preview prefix", async () => {
    const seen: string[] = [];
    const answer = await serveAppRequest(
      { path: "/" },
      { transport: transport({ "/": { body: NEXT_HTML } }, seen), port: 3000, buildId: "app-1" },
    );

    const html = new TextDecoder().decode(answer.body);
    expect(seen).toEqual(["/"]);
    expect(html).toContain('href="/__preview__/app-1/_next/static/css/app.css"');
    expect(html).toContain('src="/__preview__/app-1/_next/static/chunks/main.js"');
    expect(html).not.toContain('src="/_next/');
  });

  it("sends the headers a cross-origin-isolated app needs to frame the document", async () => {
    const answer = await serveAppRequest(
      { path: "/" },
      { transport: transport({ "/": { body: NEXT_HTML } }), port: 3000, buildId: "app-1" },
    );

    expect(answer.status).toBe(200);
    expect(answer.headers["content-type"]).toContain("text/html");
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(answer.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(answer.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(answer.headers["x-larpable-served-by"]).toBe("app");
    expect(answer.headers["x-larpable-build"]).toBe("app-1");
  });

  it("keeps the app's own content type for a module, and does not rewrite its bytes", async () => {
    const source = "export const x = 1;\n";
    const answer = await serveAppRequest(
      { path: "/_next/static/chunks/main.js" },
      {
        transport: transport({
          "/_next/static/chunks/main.js": {
            headers: { "content-type": "application/javascript; charset=utf-8" },
            body: source,
          },
        }),
        port: 3000,
        buildId: "app-1",
      },
    );

    expect(answer.headers["content-type"]).toBe("application/javascript; charset=utf-8");
    expect(new TextDecoder().decode(answer.body)).toBe(source);
  });

  it("rebases a stylesheet's url() references too", async () => {
    const answer = await serveAppRequest(
      { path: "/_next/static/css/app.css" },
      {
        transport: transport({
          "/_next/static/css/app.css": {
            headers: { "content-type": "text/css" },
            body: "body{background:url(/fonts/x.woff2)}",
          },
        }),
        port: 3000,
        buildId: "app-1",
      },
    );

    expect(new TextDecoder().decode(answer.body)).toContain("url(/__preview__/app-1/fonts/x.woff2)");
  });

  it("serves a binary body byte-for-byte", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const answer = await serveAppRequest(
      { path: "/logo.png" },
      {
        transport: transport({ "/logo.png": { headers: { "content-type": "image/png" }, body: png } }),
        port: 3000,
        buildId: "app-1",
      },
    );

    expect(Array.from(answer.body)).toEqual(Array.from(png));
    expect(answer.headers["content-type"]).toBe("image/png");
  });

  it("keeps a redirect's target inside the preview, so the pane cannot navigate away", async () => {
    const answer = await serveAppRequest(
      { path: "/old" },
      {
        transport: transport({ "/old": { status: 307, headers: { location: "/dashboard" }, body: "" } }),
        port: 3000,
        buildId: "app-1",
      },
    );

    expect(answer.status).toBe(307);
    expect(answer.headers.location).toBe("/__preview__/app-1/dashboard");
  });

  it("leaves an external redirect alone, because rewriting it would break it", async () => {
    const answer = await serveAppRequest(
      { path: "/out" },
      {
        transport: transport({ "/out": { status: 302, headers: { location: "https://example.com/x" }, body: "" } }),
        port: 3000,
        buildId: "app-1",
      },
    );

    expect(answer.headers.location).toBe("https://example.com/x");
  });

  it("answers 502 with the reason when the app is not answering", async () => {
    const failing: PreviewTransport = {
      async fetch() {
        throw new Error("/: no answer within 10000 ms");
      },
    };

    const answer = await serveAppRequest({ path: "/" }, { transport: failing, port: 3000, buildId: "app-1" });
    const body = new TextDecoder().decode(answer.body);

    expect(answer.status).toBe(502);
    expect(body).toContain("did not answer for /");
    expect(body).toContain("no answer within 10000 ms");
    // The failure is rendered inside the iframe, so it needs the document headers as well.
    expect(answer.headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("forwards the app's own 404 rather than inventing one", async () => {
    const answer = await serveAppRequest(
      { path: "/nope" },
      {
        transport: transport({ "/nope": { status: 404, headers: { "content-type": "text/html" }, body: "<h1>404</h1>" } }),
        port: 3000,
        buildId: "app-1",
      },
    );

    expect(answer.status).toBe(404);
    expect(new TextDecoder().decode(answer.body)).toContain("404");
  });

  it("answers HEAD with headers only", async () => {
    const answer = await serveAppRequest(
      { path: "/", method: "HEAD" },
      { transport: transport({ "/": { body: NEXT_HTML } }), port: 3000, buildId: "app-1" },
    );

    expect(answer.status).toBe(200);
    expect(answer.body.byteLength).toBe(0);
    expect(answer.headers["content-type"]).toContain("text/html");
  });

  it("gives a hashed asset the immutable cache policy and a document none", async () => {
    const asset = await serveAppRequest(
      { path: "/_next/static/chunks/main-abc12345.js" },
      { transport: transport({ "/_next/static/chunks/main-abc12345.js": { body: "x" } }), port: 3000, buildId: "app-1" },
    );
    const document = await serveAppRequest(
      { path: "/" },
      { transport: transport({ "/": { body: NEXT_HTML } }), port: 3000, buildId: "app-1" },
    );

    expect(asset.headers["cache-control"]).toContain("immutable");
    expect(document.headers["cache-control"]).toBe("no-store");
  });
});
