import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

import { resolveDevAccess } from "./src/lib/dev-server";

const root = process.cwd();
const srcDir = resolve(root, "src");

const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  version: string;
};

/**
 * Dev/preview access. The rules, the defaults and the incident that set them live in
 * `src/lib/dev-server.ts`, which is plain TypeScript so a unit test can assert the resolved
 * configuration without booting a server:
 *
 * - the bind address is `127.0.0.1` unless `LARPABLE_DEV_HOST` widens it;
 * - accepting any `Host` header, and reflecting any CORS origin, happens only when it has
 *   been widened — an exposed Vite dev server can execute code, which is exactly what a
 *   remote request attempted against this one;
 * - `LARPABLE_DEV_RESTRICT_HOSTS=1` keeps Vite's DNS-rebinding guard even then.
 *
 * The cross-origin isolation headers are still applied on every bind: unkernel needs them for
 * `SharedArrayBuffer` and `WebAssembly.Suspending`, and `netlify.toml` sends the same ones in
 * production.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": srcDir,
    },
  },
  optimizeDeps: {
    /**
     * unkernel must not be pre-bundled: it locates its kernel with
     * `new URL("./unkernel.wasm", import.meta.url)`, and esbuild's dependency
     * optimisation rewrites `import.meta.url` to a blob-relative path that cannot
     * resolve the wasm. Serving `node_modules/unkernel/dist/` untouched in dev keeps
     * the URL real; the production build emits the wasm as an asset (Vite understands
     * that pattern), which `bun run build` + a preview run verify.
     */
    exclude: ["unkernel"],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: resolveDevAccess(process.env, 5173),
  preview: resolveDevAccess(process.env, 4173),
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
