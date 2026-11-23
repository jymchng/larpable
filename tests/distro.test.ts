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
  name: "debian",
  file: "debian.erofs",
  size: 72_593_408,
  sha256: "d5894fa27ee868108c56c8a635d122687937c741f26535296e7b61b5e2c2f5e8",
  image: "debian-13.7-a6bb4b5e547bc28a",
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
      async () => new Response(null, { status: 200, headers: { "content-length": "72593408" } }),
    );

    const status = await probeDistroAsset(entry, fetched);

    expect(fetched).toHaveBeenCalledWith("/distros/debian.erofs", { method: "HEAD" });
    expect(status).toMatchObject({ present: true, bytes: 72_593_408 });
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
      [{ entry, url: "/distros/debian.erofs", present: true, bytes: 72_593_408 }],
      null,
    );
    expect(summary.head).toBe("debian-13.7-a6bb4b5e547bc28a ready");
    expect(summary.detail).toContain("69.2 MiB");
    expect(summary.detail).toContain("/distros/debian.erofs");
  });

  it("flags a manifest that lost its entry for the image the app boots", () => {
    expect(summarizeDistro([], null).state).toBe("error");
  });

  it("names the image it wanted and the ones the manifest has, when they differ", () => {
    // The failure this prevents: the app boots `/distros/debian.erofs`, someone ran
    // `LARPABLE_DISTROS=alpine bun run fetch:distros`, and the manifest is complete,
    // server-reachable and useless. "No image" would send the reader looking in the
    // wrong place.
    const alpineOnly = { ...entry, name: "alpine", file: "alpine.erofs" };
    const summary = summarizeDistro(
      [{ entry: alpineOnly, url: "/distros/alpine.erofs", present: true, bytes: 4_046_848 }],
      null,
    );

    expect(summary.state).toBe("error");
    expect(summary.head).toBe("No debian image listed");
    expect(summary.detail).toContain("alpine");
    expect(summary.detail).toContain("LARPABLE_DISTROS=debian");
  });

  it("accepts another distro when the caller asks for it", () => {
    const alpineOnly = { ...entry, name: "alpine", file: "alpine.erofs" };
    const summary = summarizeDistro(
      [{ entry: alpineOnly, url: "/distros/alpine.erofs", present: true, bytes: 4_046_848 }],
      null,
      "alpine",
    );
    expect(summary.state).toBe("ready");
  });
});
