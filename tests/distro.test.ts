import { describe, expect, it, vi } from "vitest";

import {
  DISTRO_MANIFEST_URL,
  DistroError,
  loadDistroManifest,
  probeDistroAsset,
  summarizeDistro,
  type DistroEntry,
  type DistroManifest,
} from "../src/env/distro";

const entry: DistroEntry = {
  name: "alpine",
  file: "alpine.erofs",
  size: 4_046_848,
  sha256: "02460df31c14772659bb347a651693ac9aaa7a8c2477f05e4e5e4d5c756dd567",
  image: "alpine-3.24.4-e0d59c37c0882d76",
};

const manifest: DistroManifest = {
  abi: 3,
  base: "base-eaa33cc640286a2e",
  distros: [entry],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("loadDistroManifest", () => {
  it("returns the manifest the fetch script wrote", async () => {
    const fetched = vi.fn(async () => jsonResponse(manifest));
    await expect(loadDistroManifest(fetched)).resolves.toEqual(manifest);
    expect(fetched).toHaveBeenCalledWith(DISTRO_MANIFEST_URL, {
      headers: { accept: "application/json" },
    });
  });

  it("explains how to fix a missing manifest", async () => {
    const fetched = vi.fn(async () => new Response("not found", { status: 404 }));

    await expect(loadDistroManifest(fetched)).rejects.toThrow(DistroError);
    await expect(loadDistroManifest(fetched)).rejects.toThrow(/bun run fetch:distros/);
  });

  it("rejects a manifest whose entries are incomplete instead of trusting it", async () => {
    const fetched = vi.fn(async () =>
      jsonResponse({ abi: 3, base: "x", distros: [{ name: "alpine" }] }),
    );

    await expect(loadDistroManifest(fetched)).rejects.toThrow(/not a distro manifest/);
  });

  it("names the deployment cause when the host answers with its SPA fallback", async () => {
    // Netlify (and any SPA host) serves index.html with a 200 for a file it does not
    // have. The browser's own parse error says nothing about what to fix.
    const fetched = vi.fn(
      async () =>
        new Response("<!doctype html><title>Larpable</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8" },
        }),
    );

    await expect(loadDistroManifest(fetched)).rejects.toThrow(/returned an HTML page/);
    await expect(loadDistroManifest(fetched)).rejects.toThrow(/public\/distros\//);
    await expect(loadDistroManifest(fetched)).rejects.toThrow(/fetch:distros/);
  });

  it("rejects a network failure with an actionable message", async () => {
    const fetched = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(loadDistroManifest(fetched)).rejects.toThrow(/Could not read/);
  });
});

describe("probeDistroAsset", () => {
  it("uses HEAD so opening the app never downloads the image", async () => {
    const fetched = vi.fn(
      async () => new Response(null, { status: 200, headers: { "content-length": "4046848" } }),
    );

    const status = await probeDistroAsset(entry, fetched);

    expect(fetched).toHaveBeenCalledWith("/distros/alpine.erofs", { method: "HEAD" });
    expect(status).toMatchObject({ present: true, bytes: 4_046_848 });
  });

  it("treats 404 as 'not fetched yet' rather than an error", async () => {
    const fetched = vi.fn(async () => new Response(null, { status: 404 }));
    await expect(probeDistroAsset(entry, fetched)).resolves.toMatchObject({ present: false });
  });

  it("reports bytes as null when the server omits the length", async () => {
    const fetched = vi.fn(async () => new Response(null, { status: 200 }));
    const status = await probeDistroAsset(entry, fetched);
    expect(status.bytes).toBeNull();
  });

  it("does not call an SPA fallback page a present image", async () => {
    const fetched = vi.fn(
      async () =>
        new Response("<!doctype html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=UTF-8", "content-length": "1116" },
        }),
    );

    await expect(probeDistroAsset(entry, fetched)).resolves.toMatchObject({
      present: false,
      bytes: null,
    });
  });

  it("fails loudly on a server error instead of pretending the image is fine", async () => {
    const fetched = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(probeDistroAsset(entry, fetched)).rejects.toThrow(/HTTP 500/);
  });
});

describe("summarizeDistro", () => {
  it("is loading until the probe answers", () => {
    expect(summarizeDistro(null, null).state).toBe("loading");
  });

  it("prefers the error over stale asset data", () => {
    const summary = summarizeDistro([{ entry, url: entry.file, present: true, bytes: 1 }], "nope");
    expect(summary.state).toBe("error");
    expect(summary.detail).toBe("nope");
  });

  it("reports a missing image with the command that fixes it", () => {
    const summary = summarizeDistro([{ entry, url: entry.file, present: false, bytes: null }], null);
    expect(summary.state).toBe("missing");
    expect(summary.detail).toMatch(/fetch:distros/);
  });

  it("reports the served image, its size and its URL", () => {
    const summary = summarizeDistro(
      [{ entry, url: "/distros/alpine.erofs", present: true, bytes: 4_046_848 }],
      null,
    );
    expect(summary.head).toBe("alpine-3.24.4-e0d59c37c0882d76 ready");
    expect(summary.detail).toContain("3.9 MiB");
    expect(summary.detail).toContain("/distros/alpine.erofs");
  });

  it("flags a manifest that lost its alpine entry", () => {
    expect(summarizeDistro([], null).state).toBe("error");
  });
});
