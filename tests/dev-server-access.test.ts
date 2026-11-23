/**
 * The dev server's exposure, pinned.
 *
 * These tests exist because the old default was measured to be dangerous: binding `0.0.0.0`
 * with `allowedHosts: true` published a Vite dev server that a remote request could make
 * execute code (an `import.meta.glob` options object whose `toString` was a `Function`
 * expression; Vite stringified it and ran it). The payload's own probe said "BAD", which is
 * the payload giving up, not the execution stopping.
 *
 * A default is only a default if something fails when it changes, so every rule below is
 * asserted rather than described.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CROSS_ORIGIN_ISOLATION_HEADERS,
  isExposedHost,
  resolveDevAccess,
} from "../src/lib/dev-server";

describe("the dev server's default exposure", () => {
  it("binds to loopback when nothing is configured", () => {
    expect(resolveDevAccess({}, 5173).host).toBe("127.0.0.1");
  });

  it("treats an empty or whitespace host as unset rather than as a bind", () => {
    expect(resolveDevAccess({ LARPABLE_DEV_HOST: "   " }, 5173).host).toBe("127.0.0.1");
  });

  it("refuses every Host header it was not told to accept", () => {
    // Vite's DNS-rebinding guard, which `allowedHosts: true` used to switch off.
    expect(resolveDevAccess({}, 5173).allowedHosts).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  it("asks for no CORS on a loopback bind, because nothing cross-origin needs it", () => {
    expect(resolveDevAccess({}, 5173).cors).toBe(false);
  });

  it("still sends the cross-origin isolation headers unkernel needs", () => {
    const access = resolveDevAccess({}, 5173);
    expect(access.headers).toEqual(CROSS_ORIGIN_ISOLATION_HEADERS);
    expect(access.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(access.headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
  });
});

describe("widening the bind is an explicit choice", () => {
  it("accepts any Host and reflects any origin only once the bind is widened", () => {
    const access = resolveDevAccess({ LARPABLE_DEV_HOST: "0.0.0.0" }, 5173);
    expect(access.host).toBe("0.0.0.0");
    expect(access.allowedHosts).toBe(true);
    expect(access.cors).toEqual({ origin: true });
  });

  it("keeps Vite's rebinding guard when the operator asks for it", () => {
    const access = resolveDevAccess(
      { LARPABLE_DEV_HOST: "0.0.0.0", LARPABLE_DEV_RESTRICT_HOSTS: "1" },
      5173,
    );
    expect(access.allowedHosts).toEqual(["localhost", "127.0.0.1", "::1"]);
  });

  it("uses a single allowed origin when one is named", () => {
    const access = resolveDevAccess(
      { LARPABLE_DEV_HOST: "0.0.0.0", LARPABLE_DEV_CORS_ORIGIN: "https://phone.example" },
      5173,
    );
    expect(access.cors).toEqual({ origin: "https://phone.example" });
  });

  it("knows which binds are local", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "LOCALHOST"]) {
      expect(isExposedHost(host), host).toBe(false);
    }
    for (const host of ["0.0.0.0", "::", "192.168.1.20", "example.com"]) {
      expect(isExposedHost(host), host).toBe(true);
    }
  });

  it("passes HMR overrides through only when they are set", () => {
    expect(resolveDevAccess({}, 5173).hmr).toBeUndefined();
    expect(
      resolveDevAccess({ LARPABLE_DEV_HMR_PROTOCOL: "wss", LARPABLE_DEV_HMR_PORT: "443" }, 5173)
        .hmr,
    ).toEqual({ protocol: "wss", clientPort: 443 });
  });

  it("resolves the preview port independently of the dev port", () => {
    expect(resolveDevAccess({}, 4173).port).toBe(4173);
  });
});

describe("the acceptance run cannot inherit a public bind", () => {
  const script = readFileSync(
    resolve(import.meta.dirname, "..", "scripts", "preview-browser-acceptance.ts"),
    "utf8",
  );

  it("spawns its own dev server on loopback explicitly", () => {
    // The script starts `bun run dev`; without this the child would inherit whatever
    // LARPABLE_DEV_HOST the operator's shell had, which is how a run ends up depending on a
    // server the internet can reach.
    expect(script).toContain('const ACCEPTANCE_DEV_HOST = "127.0.0.1";');
    expect(script).toMatch(/env:\s*\{\s*\.\.\.process\.env,\s*LARPABLE_DEV_HOST:\s*ACCEPTANCE_DEV_HOST\s*\}/);
  });
});
