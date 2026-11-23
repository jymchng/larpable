/**
 * The Linux machine must stay off the critical path of the first paint.
 *
 * §17 says "lazy-load the Linux environment". It is not a style preference here: the SDK
 * drags in a 10.2 MB WebAssembly kernel and a ~533 KB loader, both of which are useless to
 * a person who opens the page and never boots anything. The measured split (a production
 * build of this repository, `dist/index.html` referencing only `index-*.js` and
 * `index-*.css`, with `assets/web-*.js` and `assets/unkernel-*.wasm` beside them) is
 * reproduced in `docs/performance.md`.
 *
 * That split exists only because the SDK is reached through `await import(...)`. A single
 * `import { createKernel } from "unkernel/web"` anywhere in `src/` would fold it back into
 * the entry chunk, and nothing in the type system or the unit suite would notice — the app
 * would still work, just slower for everyone who never boots. This test is the guard.
 *
 * `import type` is allowed and expected: types are erased at build time, so they cost the
 * browser nothing and keep unkernel's vocabulary out of the adapter's public shape.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = new URL("../src", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(path);
  }
  return found;
}

/** A value import of the SDK: `import {x} from "unkernel/web"`, `import * as y from …`. */
const STATIC_SDK_IMPORT = /^\s*import\s+(?!type\b)[^;]*?\bfrom\s+["']unkernel\/(?:web|node)["']/m;

describe("the Linux SDK is loaded lazily", () => {
  it("has no static value import of unkernel in src/", () => {
    const offenders = sourceFiles(ROOT).filter((path) =>
      STATIC_SDK_IMPORT.test(readFileSync(path, "utf8")),
    );

    // If this fails, the whole 10 MB kernel is back in the entry bundle: move the import
    // inside the function that boots, as `src/env/unkernel-kernel.ts` does.
    expect(offenders.map((path) => path.slice(ROOT.length + 1))).toEqual([]);
  });

  it("reaches the SDK through a dynamic import, in the one module that boots it", () => {
    const source = readFileSync(join(ROOT, "env/unkernel-kernel.ts"), "utf8");

    expect(source).toContain('await import("unkernel/web")');
  });
});
