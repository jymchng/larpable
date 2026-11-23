/**
 * The address bar's grammar.
 *
 * The bar used to be read-only, so there was nothing to decide. It is editable now, and the one
 * thing that must never happen is a guess: a typed `example.com` cannot be opened (the preview
 * reaches the guest's loopback and nothing else), `localhost` with no port would mean port 80, and
 * `https://localhost:1234` is a TLS handshake against a server that speaks plain HTTP. Each of
 * those is a refusal *with a sentence*, and this file asserts the sentences — a refusal that says
 * nothing is how a user concludes the product is broken.
 */

import { describe, expect, it } from "vitest";

import { guestAddressFor, parsePreviewAddress } from "../src/ui/preview-address";

describe("parsePreviewAddress", () => {
  it("opens a guest server named as `host:port`", () => {
    expect(parsePreviewAddress("localhost:1234")).toEqual({
      kind: "guest",
      port: 1234,
      path: "/",
    });
    expect(parsePreviewAddress("  localhost:1234  ")).toEqual({
      kind: "guest",
      port: 1234,
      path: "/",
    });
  });

  it("keeps the path, the query and the fragment of a guest address", () => {
    expect(parsePreviewAddress("localhost:1234/app/editor")).toEqual({
      kind: "guest",
      port: 1234,
      path: "/app/editor",
    });
    expect(parsePreviewAddress("http://localhost:1234/search?q=1#top")).toEqual({
      kind: "guest",
      port: 1234,
      path: "/search?q=1#top",
    });
  });

  it("accepts every spelling of the guest's loopback, and only the loopback", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(parsePreviewAddress(`${host}:3000`)).toEqual({
        kind: "guest",
        port: 3000,
        path: "/",
      });
    }

    const elsewhere = parsePreviewAddress("example.com:3000");
    expect(elsewhere.kind).toBe("refused");
    if (elsewhere.kind !== "refused") throw new Error("expected a refusal");
    // The sentence names the reason and the fix: the preview's only host is the guest's own.
    expect(elsewhere.message).toContain("another host");
    expect(elsewhere.message).toContain("localhost:");
  });

  it("keeps a bare path on the page already on screen", () => {
    expect(parsePreviewAddress("/about")).toEqual({ kind: "path", path: "/about" });
    expect(parsePreviewAddress("about")).toEqual({ kind: "path", path: "/about" });
    expect(parsePreviewAddress("app/editor/")).toEqual({ kind: "path", path: "/app/editor" });
  });

  it("refuses a host with no port rather than guessing port 80", () => {
    const target = parsePreviewAddress("localhost", { currentPort: 1234 });
    expect(target.kind).toBe("refused");
    if (target.kind !== "refused") throw new Error("expected a refusal");
    expect(target.message).toContain("port");
    // The example is the *configured* port, so the sentence is actionable in this pane.
    expect(target.message).toContain("localhost:1234");
  });

  it("refuses https, because the guest's server speaks plain HTTP", () => {
    const target = parsePreviewAddress("https://localhost:1234/");
    expect(target.kind).toBe("refused");
    if (target.kind !== "refused") throw new Error("expected a refusal");
    expect(target.message).toContain("plain HTTP");
    expect(target.message).toContain("http://localhost:5173/");
  });

  it("refuses a scheme that is not HTTP at all", () => {
    const target = parsePreviewAddress("ftp://localhost:1234/");
    expect(target.kind).toBe("refused");
    if (target.kind !== "refused") throw new Error("expected a refusal");
    expect(target.message).toContain("ftp:");
  });

  it("refuses a protocol-relative address, which is another origin wearing a path's clothes", () => {
    expect(parsePreviewAddress("//example.com/x").kind).toBe("refused");
  });

  it("refuses a port that is not a port", () => {
    for (const text of ["localhost:0", "localhost:99999", "localhost:abc", "localhost:"]) {
      const target = parsePreviewAddress(text);
      expect(target.kind).toBe("refused");
    }
  });

  it("asks for an address rather than opening nothing", () => {
    const target = parsePreviewAddress("   ", { currentPort: 3000 });
    expect(target.kind).toBe("refused");
    if (target.kind !== "refused") throw new Error("expected a refusal");
    expect(target.message).toContain("localhost:3000");
  });

  it("treats `host:port` as an address, never as the path `/example.com:1234`", () => {
    // A path would quietly open a page nobody asked for; a refusal says what happened.
    expect(parsePreviewAddress("example.com:1234").kind).toBe("refused");
  });
});

describe("guestAddressFor", () => {
  it("prints the address the user typed, without the preview's own URL space", () => {
    expect(guestAddressFor(1234, "/")).toBe("localhost:1234/");
    expect(guestAddressFor(1234, "/app/editor")).toBe("localhost:1234/app/editor");
    // Normalised like every other path in the pane: `app` and `/app/` are one page.
    expect(guestAddressFor(1234, "app/")).toBe("localhost:1234/app");
  });
});
