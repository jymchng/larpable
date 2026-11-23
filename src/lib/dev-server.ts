/**
 * Who can reach the dev server, decided in one testable place.
 *
 * This exists because of a measured incident (2026-11-23). `LARPABLE_DEV_HOST` used to default
 * to `0.0.0.0` with `allowedHosts: true`, which on an internet-facing machine published a
 * Vite dev server to the whole internet. It did not go unnoticed: a request arrived whose
 * module id carried
 *
 *   import.meta.glob("/*",{[{toString:Function`return Function(Buffer.from("…","base64url")
 *     .toString())()`}]:1})
 *
 * and Vite's glob plugin stringifies that options object, so the payload **ran inside the dev
 * server process** (its own environment probe answered "BAD", which is the payload failing,
 * not the execution stopping). Its `vite:error` broadcast then covered every connected page in
 * a `vite-error-overlay`.
 *
 * So the defaults are now the safe ones, and reaching the server from anywhere else is an
 * explicit choice the operator makes:
 *
 * - the bind address is `127.0.0.1` unless `LARPABLE_DEV_HOST` says otherwise;
 * - a non-loopback bind is what turns on the permissive `Host` handling and CORS reflection,
 *   because that is the only case that needs them (a phone or a tunnel cannot know the
 *   hostname ahead of time);
 * - `LARPABLE_DEV_RESTRICT_HOSTS=1` still exists to keep Vite's DNS-rebinding guard even when
 *   the bind is widened.
 *
 * The guest's own internet access is a separate matter: it goes through a Wisp proxy whose
 * allow-list decides what Linux can reach. Widening this setting grants a *browser* access to
 * a *dev server* that can execute code — nothing about the guest.
 */

/** The environment variables this module reads. Kept structural so a test can pass its own. */
export interface DevAccessEnv {
  LARPABLE_DEV_HOST?: string | undefined;
  LARPABLE_DEV_CORS_ORIGIN?: string | undefined;
  LARPABLE_DEV_RESTRICT_HOSTS?: string | undefined;
  LARPABLE_DEV_HMR_PROTOCOL?: string | undefined;
  LARPABLE_DEV_HMR_PORT?: string | undefined;
}

export interface DevAccess {
  host: string;
  port: number;
  strictPort: boolean;
  cors: { origin: string | string[] } | false;
  allowedHosts: string[] | true;
  headers: Record<string, string>;
  hmr?: { protocol?: string; clientPort?: number };
}

/**
 * The cross-origin isolation headers, which unkernel needs for `SharedArrayBuffer` and
 * `WebAssembly.Suspending`. Every host that serves the app must send them: here for
 * dev/preview, `netlify.toml` for production, and `src/env/support.ts` checks them at runtime.
 */
export const CROSS_ORIGIN_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** Hostnames that only ever mean "this machine". */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"] as const;

/** True when binding to `host` exposes the server to more than this machine. */
export function isExposedHost(host: string): boolean {
  const normalised = host.trim().toLowerCase();
  return normalised.length > 0 && !LOOPBACK_HOSTS.some((loopback) => loopback === normalised);
}

/**
 * The resolved `server` (and `preview`) configuration.
 *
 * `port` is a parameter rather than a constant because the preview server uses 4173 and the
 * rule must not depend on which one it is.
 */
export function resolveDevAccess(env: DevAccessEnv, port: number): DevAccess {
  const requestedHost = env.LARPABLE_DEV_HOST?.trim() ?? "";
  const host = requestedHost.length > 0 ? requestedHost : "127.0.0.1";
  const exposed = isExposedHost(host);

  // A widened bind is the operator saying "other devices should reach this". That is the only
  // case in which any `Host` header and any `Origin` are accepted; the loopback default keeps
  // Vite's DNS-rebinding protection and asks for no CORS at all.
  const restrictHosts = env.LARPABLE_DEV_RESTRICT_HOSTS === "1";
  const allowedHosts: string[] | true = exposed && !restrictHosts ? true : [...LOOPBACK_HOSTS];

  const explicitOrigin = env.LARPABLE_DEV_CORS_ORIGIN?.trim() ?? "";
  const cors: DevAccess["cors"] =
    explicitOrigin.length > 0
      ? { origin: explicitOrigin }
      : exposed
        ? // Reflect whatever origin asks: LAN addresses and tunnel hostnames cannot be listed
          // ahead of time, which is the documented cost of an intentionally exposed server.
          { origin: true as unknown as string }
        : false;

  const hmrProtocol = env.LARPABLE_DEV_HMR_PROTOCOL?.trim() ?? "";
  const hmrPort = env.LARPABLE_DEV_HMR_PORT?.trim() ?? "";
  const hmr =
    hmrProtocol.length > 0 || hmrPort.length > 0
      ? {
          ...(hmrProtocol.length > 0 ? { protocol: hmrProtocol } : {}),
          ...(hmrPort.length > 0 ? { clientPort: Number(hmrPort) } : {}),
        }
      : undefined;

  return {
    host,
    port,
    strictPort: false,
    cors,
    allowedHosts,
    headers: { ...CROSS_ORIGIN_ISOLATION_HEADERS },
    ...(hmr === undefined ? {} : { hmr }),
  };
}
