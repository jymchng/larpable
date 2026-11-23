/**
 * The bar as the browser receives it.
 *
 * The derivation is tested in `status-bar.test.ts`; this file asserts the part a screenshot
 * shows: six named cells, a dot and a word for each, and the full sentence in the accessible
 * name and the tooltip so a colour-blind or screen-reader user gets the same information as a
 * sighted one.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { INITIAL_ENVIRONMENT } from "../src/env/status";
import type { StatusInput } from "../src/ui/status-bar";
import { StatusBar } from "../src/ui/status-bar-view";

function render(input: StatusInput): string {
  return renderToStaticMarkup(<StatusBar input={input} />);
}

const ready: StatusInput = {
  environment: {
    status: "ready",
    runtime: "node 22.9.0",
    distro: "debian",
    cpus: 4,
    memoryMiB: 2048,
    error: null,
  },
  project: { name: "my-site", root: "/workspace" },
  build: { kind: "failed", summary: "TS2307: cannot find module" },
  netlify: { kind: "ok" },
  preview: {
    kind: "ready",
    buildId: "build-mf3k2-1",
    url: "/__preview__/build-mf3k2-1/",
    files: 14,
    served: "worker",
    note: null,
  },
};

describe("StatusBar", () => {
  it("renders all six facts as named cells", () => {
    const html = render(ready);
    for (const key of ["linux", "runtime", "project", "build", "netlify", "preview"]) {
      expect(html).toContain(`data-testid="status-${key}"`);
    }
  });

  it("paints the tone its source decided, not a default", () => {
    const html = render(ready);
    expect(html).toContain('data-testid="status-linux" data-key="linux" data-tone="green"');
    // A failed build stays red on a bar whose other segments are green.
    expect(html).toContain('data-testid="status-build" data-key="build" data-tone="red"');
    expect(html).toContain('data-value="failed"');
  });

  it("is grey on an idle machine, so nothing looks ready before it is", () => {
    const html = render({
      environment: INITIAL_ENVIRONMENT,
      project: null,
      build: { kind: "none" },
      netlify: { kind: "unknown" },
      preview: { kind: "idle" },
    });
    expect(html.match(/data-testid="status-[a-z]+" data-key="[a-z]+" data-tone="grey"/g)).toHaveLength(6);
  });

  it("gives the whole bar one accessible name made of its six values", () => {
    const html = render(ready);
    expect(html).toContain(
      'aria-label="Linux: Ready · Runtime: node 22.9.0 · Project: my-site · Build: failed · Netlify: valid · Preview: build-mf3k2-1"',
    );
  });

  it("gives every cell a dot labelled with the full sentence", () => {
    const html = render(ready);
    expect(html).toContain('data-testid="status-dot-linux"');
    expect(html).toContain("Build failed: TS2307: cannot find module");
  });
});
