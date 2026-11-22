import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

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

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    headers: crossOriginIsolationHeaders,
    port: 5173,
  },
  preview: {
    headers: crossOriginIsolationHeaders,
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
    include: ["tests/**/*.test.{ts,tsx}"],
    passWithNoTests: false,
    testTimeout: 20_000,
  },
});
