/**
 * The preview's routing rules (PRD §12), tested with no browser and no guest.
 *
 * These are the decisions a preview gets *wrong* in a way nobody notices until a demo:
 * a module served as `text/html` is refused by the browser, a source map served as HTML
 * breaks devtools silently, a path that walks upwards reads the user's `.env`, and an SPA
 * fallback applied to a static site renders the home page for every 404. So each of those
 * is a case here rather than an assertion bolted onto the end.
 */

import { describe, expect, it } from "vitest";

import {
  PREVIEW_PREFIX,
  cacheControlFor,
  isImmutableAsset,
  isPreviewDocument,
  isSourceMap,
  mimeTypeFor,
  normalisePreviewPath,
  parsePreviewUrl,
  previewErrorHeaders,
  previewFailure,
  previewHeaders,
  resolvePreviewPath,
} from "../src/preview/routing";

describe("parsePreviewUrl", () => {
  it("splits a preview URL into a build id and a path inside the build", () => {
    expect(parsePreviewUrl("/__preview__/b-17/assets/app.js", "b-17")).toEqual({
      buildId: "b-17",
      path: "/assets/app.js",
      stale: false,
    });
  });

  it("drops the query string, because a build has no query strings", () => {
    expect(parsePreviewUrl("/__preview__/b-17/assets/app.js?v=2", "b-17")?.path).toBe(
      "/assets/app.js",
    );
  });

  it("drops the hash, which never reaches a server anyway", () => {
    expect(parsePreviewUrl("/__preview__/b-17/index.html#/route", "b-17")?.path).toBe(
      "/index.html",
    );
  });

  it("accepts an absolute URL and reads only its pathname", () => {
    expect(parsePreviewUrl("https://larpable.netlify.app/__preview__/b-1/x.css", "b-1")).toEqual({
      buildId: "b-1",
      path: "/x.css",
      stale: false,
    });
  });

  it("maps a bare build URL to the root path", () => {
    expect(parsePreviewUrl("/__preview__/b-1", "b-1")?.path).toBe("/");
    expect(parsePreviewUrl("/__preview__/b-1/", "b-1")?.path).toBe("/");
  });

  it("marks a URL stale when it names a build that is no longer current", () => {
    expect(parsePreviewUrl("/__preview__/b-16/index.html", "b-17")?.stale).toBe(true);
  });

  it("does not claim staleness when no build is current yet", () => {
    // Nothing has been published: every URL is equally "not stale", it is simply too early.
    expect(parsePreviewUrl("/__preview__/b-1/index.html", null)?.stale).toBe(false);
  });

  it("returns null for the app's own routes, so they are never shadowed", () => {
    expect(parsePreviewUrl("/app/editor", "b-1")).toBeNull();
    expect(parsePreviewUrl("/", "b-1")).toBeNull();
    expect(parsePreviewUrl(`/__preview__x/b-1/a.js`, "b-1")).toBeNull();
  });

  it("returns null when the URL names no build", () => {
    expect(parsePreviewUrl("/__preview__/", "b-1")).toBeNull();
    expect(parsePreviewUrl(PREVIEW_PREFIX, "b-1")).toBeNull();
  });

  it("returns null for a relative URL that cannot be parsed", () => {
    expect(parsePreviewUrl("not a url at all", "b-1")).toBeNull();
  });

  it("refuses to walk out of the build", () => {
    expect(parsePreviewUrl("/__preview__/b-1/../../etc/passwd", "b-1")).toBeNull();
    // Percent-encoded dot segments are decoded by the browser before it sends them, and a
    // hand-written request need not bother: both must be refused.
    expect(parsePreviewUrl("/__preview__/b-1/%2e%2e/%2e%2e/.env", "b-1")).toBeNull();
  });
});

describe("normalisePreviewPath", () => {
  it("collapses repeated and trailing slashes", () => {
    expect(normalisePreviewPath("/a//b/./c/")).toBe("/a/b/c");
  });

  it("treats the build root as", () => {
    expect(normalisePreviewPath("/")).toBe("/");
    expect(normalisePreviewPath("")).toBe("/");
  });

  it("rejects dot segments instead of resolving them", () => {
    expect(normalisePreviewPath("/a/../b")).toBeNull();
    // Top-level `..`: there is nothing above the build to resolve to.
    expect(normalisePreviewPath("/..")).toBeNull();
  });

  it("rejects NUL bytes, which truncate a path in the guest", () => {
    expect(normalisePreviewPath("/a\0.js")).toBeNull();
    expect(normalisePreviewPath("/a%00.js")).toBeNull();
  });

  it("rejects a malformed escape rather than guessing at it", () => {
    expect(normalisePreviewPath("/100%.js")).toBeNull();
    expect(normalisePreviewPath("/%zz.js")).toBeNull();
  });

  it("keeps a space that arrived encoded", () => {
    expect(normalisePreviewPath("/my%20site/index.html")).toBe("/my site/index.html");
  });
});

describe("resolvePreviewPath", () => {
  const spa = ["/index.html", "/assets/index-abc12345.js", "/docs/index.html"];

  it("answers / with index.html", () => {
    expect(resolvePreviewPath({ path: "/", files: spa, fallbackPath: "/index.html" })).toEqual({
      kind: "file",
      path: "/index.html",
    });
  });

  it("answers a real file with itself", () => {
    expect(
      resolvePreviewPath({ path: "/assets/index-abc12345.js", files: spa, fallbackPath: "/index.html" }),
    ).toEqual({ kind: "file", path: "/assets/index-abc12345.js" });
  });

  it("answers a directory with its index file, with or without a trailing slash", () => {
    expect(resolvePreviewPath({ path: "/docs", files: spa, fallbackPath: null })).toEqual({
      kind: "file",
      path: "/docs/index.html",
    });
    expect(resolvePreviewPath({ path: "/docs/", files: spa, fallbackPath: null })).toEqual({
      kind: "file",
      path: "/docs/index.html",
    });
  });

  it("rewrites an unknown path to the SPA fallback when one is configured", () => {
    expect(
      resolvePreviewPath({ path: "/app/editor", files: spa, fallbackPath: "/index.html" }),
    ).toEqual({ kind: "fallback", path: "/index.html", requested: "/app/editor" });
  });

  it("reports a miss when no fallback is configured, instead of serving the home page", () => {
    // This is the lie PRD §12 forbids: a static site that renders index.html for every
    // 404 hides a broken link until it is deployed.
    expect(resolvePreviewPath({ path: "/nope", files: spa, fallbackPath: null })).toEqual({
      kind: "missing",
      path: "/nope",
    });
  });

  it("reports a miss when the fallback file is not in the build", () => {
    expect(resolvePreviewPath({ path: "/nope", files: ["/main.js"], fallbackPath: "/index.html" })).toEqual({
      kind: "missing",
      path: "/nope",
    });
  });
});

describe("mimeTypeFor", () => {
  it.each([
    ["/index.html", "text/html; charset=utf-8"],
    ["/assets/app.js", "text/javascript; charset=utf-8"],
    ["/assets/app.mjs", "text/javascript; charset=utf-8"],
    ["/assets/app.css", "text/css; charset=utf-8"],
    ["/data.json", "application/json; charset=utf-8"],
    ["/assets/app.js.map", "application/json; charset=utf-8"],
    ["/favicon.svg", "image/svg+xml"],
    ["/favicon.ico", "image/x-icon"],
    ["/fonts/inter.woff2", "font/woff2"],
    ["/render.wasm", "application/wasm"],
    ["/site.webmanifest", "application/manifest+json; charset=utf-8"],
    ["/robots.txt", "text/plain; charset=utf-8"],
  ])("types %s as %s", (path, expected) => {
    expect(mimeTypeFor(path)).toBe(expected);
  });

  it("is case-insensitive about the extension", () => {
    expect(mimeTypeFor("/LOGO.PNG")).toBe("image/png");
  });

  it("never guesses HTML for an unknown extension", () => {
    // An unknown file typed as HTML is a script-execution path; octet-stream downloads it.
    expect(mimeTypeFor("/uploads/payload.bin")).toBe("application/octet-stream");
    expect(mimeTypeFor("/Makefile")).toBe("application/octet-stream");
  });

  it("treats a dotfile as having no extension", () => {
    expect(mimeTypeFor("/.env")).toBe("application/octet-stream");
    expect(mimeTypeFor("/.gitignore")).toBe("application/octet-stream");
  });
});

describe("isSourceMap", () => {
  it("recognises a map by suffix, not by directory", () => {
    expect(isSourceMap("/assets/app.js.map")).toBe(true);
    expect(isSourceMap("/assets/APP.JS.MAP")).toBe(true);
    expect(isSourceMap("/assets/app.js")).toBe(false);
  });
});

describe("isImmutableAsset", () => {
  it("recognises hashed build output", () => {
    expect(isImmutableAsset("/assets/index-abc12345.js")).toBe(true);
    expect(isImmutableAsset("/assets/index-ABC12345.css")).toBe(true);
  });

  it("does not treat an unhashed name as immutable", () => {
    expect(isImmutableAsset("/assets/app.js")).toBe(false);
    expect(isImmutableAsset("/index.html")).toBe(false);
  });

  it("does not treat a hashed HTML file as immutable", () => {
    // HTML is the one file that changes between builds; caching it hard shows a stale page.
    expect(isImmutableAsset("/about-abc12345.html")).toBe(false);
  });
});

describe("cacheControlFor", () => {
  it("caches hashed assets for a year", () => {
    expect(cacheControlFor("/assets/index-abc12345.js")).toBe("public, max-age=31536000, immutable");
  });

  it("never stores HTML, so a new build is visible on reload", () => {
    expect(cacheControlFor("/index.html")).toBe("no-store");
    expect(cacheControlFor("/")).toBe("no-store");
  });

  it("never stores source maps, which must match the bytes on screen", () => {
    expect(cacheControlFor("/assets/app.js.map")).toBe("no-store");
  });

  it("revalidates everything else", () => {
    expect(cacheControlFor("/assets/app.js")).toBe("no-cache");
  });
});

describe("previewHeaders", () => {
  it("sends the type, the cache policy, nosniff and the build id together", () => {
    expect(previewHeaders({ path: "/assets/app.js", buildId: "b-7", length: 42 })).toEqual({
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
      "x-larpable-build": "b-7",
      "content-length": "42",
    });
  });

  it("omits content-length when the length is unknown", () => {
    expect(previewHeaders({ path: "/a.css", buildId: "b-1" })).not.toHaveProperty("content-length");
  });
});

describe("document headers", () => {
  // Measured in Chromium 159 against this app: a same-origin frame served without its own
  // COOP is refused with ERR_BLOCKED_BY_RESPONSE on a cross-origin isolated page, and a
  // frame without `allow-same-origin` is not a service-worker client at all. Either way the
  // preview is blank. So the document headers are not decoration; they are the difference
  // between a rendered site and an empty pane.
  it("gives an HTML document its own COOP and a framable CORP", () => {
    const headers = previewHeaders({ path: "/index.html", buildId: "b-1" });
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("treats every HTML entry point as a document, not just index.html", () => {
    for (const path of ["/index.html", "/about.html", "/docs/index.html"]) {
      expect(isPreviewDocument(path)).toBe(true);
      expect(previewHeaders({ path, buildId: "b-1" })["cross-origin-opener-policy"]).toBe(
        "same-origin",
      );
    }
  });

  it("does not impose isolation headers on assets", () => {
    // A stylesheet or a module is not a document; COOP on it would mean nothing, and the
    // assertion is here so a future "add it everywhere" change has to think about it.
    for (const path of ["/assets/app.js", "/assets/app.css", "/logo.svg"]) {
      expect(isPreviewDocument(path)).toBe(false);
      expect(previewHeaders({ path, buildId: "b-1" })).not.toHaveProperty(
        "cross-origin-opener-policy",
      );
    }
  });

  it("gives failure bodies the same headers, because a 503 in a frame is a document", () => {
    const headers = previewErrorHeaders({ "x-larpable-build": "b-1" });
    expect(headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(headers["x-larpable-build"]).toBe("b-1");
  });
});

describe("previewFailure", () => {
  it("says the preview is not built yet, not that the file is missing", () => {
    const failure = previewFailure({ reason: "no-build", path: "/" });
    expect(failure.status).toBe(503);
    expect(failure.message).toMatch(/no preview build/i);
  });

  it("names both builds when the page belongs to an old one", () => {
    const failure = previewFailure({
      reason: "stale",
      path: "/index.html",
      buildId: "b-16",
      currentBuildId: "b-17",
    });
    expect(failure.status).toBe(409);
    expect(failure.message).toContain("b-16");
    expect(failure.message).toContain("b-17");
  });

  it("says no fallback is configured rather than pretending the route exists", () => {
    const failure = previewFailure({ reason: "missing", path: "/nope" });
    expect(failure.status).toBe(404);
    expect(failure.message).toContain("/nope");
    expect(failure.message).toMatch(/no single-page fallback/i);
  });

  it("reports the guest server's own failure as a gateway error", () => {
    const failure = previewFailure({ reason: "server", path: "/index.html", detail: "ECONNREFUSED" });
    expect(failure.status).toBe(502);
    expect(failure.message).toContain("ECONNREFUSED");
  });

  it("produces plain text for every reason, never a document that can run script", () => {
    for (const reason of ["no-build", "stale", "missing", "server"] as const) {
      const failure = previewFailure({ reason, path: "/index.html" });
      expect(failure.message).not.toContain("<");
    }
  });
});
