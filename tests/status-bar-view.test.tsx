/**
 * The six facts as the browser receives them.
 *
 * The derivation is tested in `status-bar.test.ts`; this file asserts the part a screenshot
 * shows: six named rows in a label/value list, a dot and a word for each, and the full sentence
 * in the accessible name and the tooltip so a colour-blind or screen-reader user gets the same
 * information as a sighted one.
 *
 * It used to assert a horizontal bar. It is a list inside the debug popover now (user request:
 * "Put all the above in the debug popover … make it more concise"), so the assertions moved to
 * the shape that change introduced — a `<dl>` whose terms are the labels — rather than being
 * deleted with the bar.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { INITIAL_ENVIRONMENT } from "../src/env/status";
import type { StatusInput } from "../src/ui/status-bar";
import { StatusFacts } from "../src/ui/status-bar-view";
import { NO_TERMINAL } from "../src/ui/terminal-connection";

function render(input: StatusInput): string {
  return renderToStaticMarkup(<StatusFacts input={input} />);
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
  terminal: NO_TERMINAL,
};

describe("StatusFacts", () => {
  it("renders all seven facts as named rows", () => {
    const html = render(ready);
    for (const key of ["linux", "runtime", "project", "build", "netlify", "preview", "terminal"]) {
      expect(html).toContain(`data-testid="status-${key}"`);
    }
  });

  it("is a definition list, so each fact is a term and a value rather than loose words", () => {
    const html = render(ready);
    expect(html).toContain('data-testid="status-facts"');
    expect(html).toContain("<dl");
    expect(html).toContain("</dl>");
    // Seven terms and seven values, one pair per fact.
    expect(html.match(/<dt /g)).toHaveLength(7);
    expect(html.match(/<dd /g)).toHaveLength(7);
    // The label is the term, so the row reads "Linux | Ready" to a screen reader as one pair.
    expect(html).toContain(">Linux</dt>");
    expect(html).toContain(">Ready</dd>");
  });

  it("paints the tone its source decided, not a default", () => {
    const html = render(ready);
    expect(html).toContain('data-testid="status-linux" data-key="linux" data-tone="green"');
    // A failed build stays red in a list whose other facts are green.
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
      terminal: NO_TERMINAL,
    });
    expect(html.match(/data-testid="status-[a-z]+" data-key="[a-z]+" data-tone="grey"/g)).toHaveLength(7);
  });

  it("gives the whole list one accessible name made of its seven values", () => {
    const html = render(ready);
    expect(html).toContain(
      'aria-label="Linux: Ready · Runtime: node 22.9.0 · Project: my-site · Build: failed · Netlify: valid · Preview: build-mf3k2-1 · Terminal: no shell"',
    );
  });

  it("gives every row a dot labelled with the full sentence", () => {
    const html = render(ready);
    expect(html).toContain('data-testid="status-dot-linux"');
    expect(html).toContain("Build failed: TS2307: cannot find module");
  });

  it("truncates a long value instead of widening the popover", () => {
    // At 390 px a long build id must not push the surface past the viewport; the full sentence
    // is still in the row's title and the dot's accessible label.
    const html = render({
      ...ready,
      build: { kind: "ok", id: "build-" + "m".repeat(80), durationMs: 1200 },
    });
    expect(html).toContain("truncate");
    expect(html).toContain("title=");
  });
});
