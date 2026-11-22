import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const root = process.cwd();
const srcDir = resolve(root, "src");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
};

/**
 * unkernel needs cross-origin isolation for its worker/SMP paths (SharedArrayBuffer
 * and `WebAssembly.Suspending` scheduling). The same headers must be sent by every
 * host that serves the app, so they are configured here for `dev`/`preview`, in
 * `netlify.toml` for production, and asserted by the browser support check in
 * `src/env/support.ts`.
 */
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
} as const;

/**
 * Dev/preview access from anywhere (another machine on the LAN, a phone, a tunnel
 * such as `cloudflared` or `ngrok`).
 *
 * - `LARPABLE_DEV_HOST` (default `0.0.0.0`): the interface the server binds to.
 * - `LARPABLE_DEV_CORS_ORIGIN`: a single allowed origin. Unset means "reflect the
 *   requesting origin", which is what makes LAN and tunnel URLs work without
 *   editing config per device. Dev only — never affects the production build.
 * - `LARPABLE_DEV_RESTRICT_HOSTS=1`: restore Vite's DNS-rebinding guard and accept
 *   only `localhost`/`127.0.0.1`. By default any `Host` is accepted, because
 *   tunnels and phones reach the server by hostnames that cannot be known ahead of
 *   time. That default is a dev-only convenience, not something to ship.
 * - `LARPABLE_DEV_HMR_PROTOCOL` / `LARPABLE_DEV_HMR_PORT`: for tunnels that expose
 *   the page over HTTPS on a different port, so the HMR websocket can connect.
 *
 * The guest's own internet access is a separate matter: it goes through a Wisp
 * proxy whose allow-list decides whether `bun install` inside Linux can reach a
 * registry. Allowing browsers to reach this dev server does not grant the guest
 * network access.
 */
function devOrigin(): true | string {
  const origin = process.env.LARPABLE_DEV_CORS_ORIGIN?.trim();
  return origin && origin.length > 0 ? origin : true;
}

function devAccess() {
  const hmrProtocol = process.env.LARPABLE_DEV_HMR_PROTOCOL?.trim();
  const hmrPort = process.env.LARPABLE_DEV_HMR_PORT?.trim();

  return {
    host: process.env.LARPABLE_DEV_HOST?.trim() || "0.0.0.0",
    port: 5173,
    strictPort: false,
    cors: { origin: devOrigin() },
    allowedHosts:
      process.env.LARPABLE_DEV_RESTRICT_HOSTS === "1"
        ? ["localhost", "127.0.0.1"]
        : (true as const),
    headers: crossOriginIsolationHeaders,
    ...(hmrProtocol || hmrPort
      ? {
          hmr: {
            ...(hmrProtocol ? { protocol: hmrProtocol } : {}),
            ...(hmrPort ? { clientPort: Number(hmrPort) } : {}),
          },
        }
      : {}),
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: devAccess(),
  preview: {
    ...devAccess(),
    port: 4173,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  test: {
    // Node-flavoured tests run by default; component tests that need a DOM opt in
    // with a `// @vitest-environment jsdom` docblock once the UI lands.
    environment: "node",
    // Vitest resolves aliases through its own resolver, so `@/` is declared here
    // as well as in `resolve.alias` (which serves the app and the production build).
    alias: {
      "@": srcDir,
    },
    include: ["tests/**/*.test.{ts,tsx}"],
    passWithNoTests: false,
    testTimeout: 20_000,
  },
});
