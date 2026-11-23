/**
 * The pane's job is to be honest about four situations, and this file asserts the words and
 * the markup, not the wiring: a phase in, a control and a state out.
 *
 * Rendered with `renderToStaticMarkup` like the rest of the UI tests, because what matters is
 * what the browser receives — a disabled control, a real sandbox string, a URL with the build
 * in it — rather than an effect having run.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PREVIEW_IFRAME_SANDBOX } from "../src/preview/sandbox";
import { PREVIEW_PREFIX } from "../src/preview/routing";
import type { PreviewPhase } from "../src/preview/controller";
import {
  PreviewPane,
  PreviewToolbar,
  describePreviewPhase,
  toPreviewState,
} from "../src/ui/preview-pane";

function render(phase: PreviewPhase, available = true): string {
  return renderToStaticMarkup(
    <PreviewPane phase={phase} onRefresh={() => undefined} available={available} />,
  );
}

const ready: PreviewPhase = {
  kind: "ready",
  buildId: "build-mf3k2-1",
  url: `${PREVIEW_PREFIX}/build-mf3k2-1/`,
  files: 14,
  served: "worker",
  note: null,
};

describe("toPreviewState", () => {
  it("maps every phase onto a pane state, with no phase left out", () => {
    expect(toPreviewState({ kind: "idle" })).toEqual({ kind: "idle" });
    expect(toPreviewState({ kind: "starting", detail: "…" })).toEqual({
      kind: "building",
      buildId: null,
    });
    expect(toPreviewState({ kind: "publishing", buildId: "b-1", detail: "…" })).toEqual({
      kind: "building",
      buildId: "b-1",
    });
    expect(toPreviewState(ready)).toMatchObject({ kind: "ready", buildId: "build-mf3k2-1" });
    // A failure that never reached HTTP carries no status, rather than a made-up one.
    expect(toPreviewState({ kind: "failed", message: "no build" })).toEqual({
      kind: "error",
      status: null,
      message: "no build",
    });
  });
});

describe("describePreviewPhase", () => {
  it("says which build and how many files, not just \"ready\"", () => {
    expect(describePreviewPhase(ready)).toBe("Serving 14 files from the preview worker.");
  });

  it("names the guest as the server when the worker is not holding the build", () => {
    expect(
      describePreviewPhase({ ...ready, served: "guest", files: 1, note: "no worker" }),
    ).toBe("Serving from the guest on demand: 1 file.");
  });

  it("repeats the controller's own detail while it works", () => {
    expect(describePreviewPhase({ kind: "starting", detail: "Starting the guest's server…" })).toBe(
      "Starting the guest's server…",
    );
  });
});

describe("PreviewPane", () => {
  it("renders the iframe at the published build's URL with the product's sandbox", () => {
    const html = render(ready);

    expect(html).toContain(`src="${PREVIEW_PREFIX}/build-mf3k2-1/"`);
    expect(html).toContain(`sandbox="${PREVIEW_IFRAME_SANDBOX}"`);
    expect(html).toContain('data-build-id="build-mf3k2-1"');
    expect(html).toContain('data-testid="preview-iframe"');
  });

  it("offers a preview control and a status line before anything is published", () => {
    const html = render({ kind: "idle" });

    expect(html).toContain('data-testid="preview-build"');
    expect(html).toContain("Preview build");
    expect(html).toContain('data-testid="preview-status"');
    expect(html).toContain("No preview published yet.");
    // No iframe: there is no URL to point one at, and a blank frame is indistinguishable
    // from a site that renders nothing.
    expect(html).not.toContain("<iframe");
  });

  it("disables the control while there is no machine to ask", () => {
    const html = render({ kind: "idle" }, false);

    expect(html).toMatch(/data-testid="preview-build"[^>]*disabled/);
  });

  it("disables the control while a publish is already running", () => {
    for (const phase of [
      { kind: "starting", detail: "Starting the guest's server…" } as const,
      { kind: "publishing", buildId: "b-1", detail: "Reading 3 files out of the guest…" } as const,
    ]) {
      const html = render(phase);
      expect(html).toMatch(/data-testid="preview-build"[^>]*disabled/);
      expect(html).toContain('data-testid="preview-status"');
    }
  });

  it("shows the failure's own words instead of a blank pane", () => {
    const html = render({
      kind: "failed",
      message: "There is no build to preview: dist/ is empty or missing in the guest.",
    });

    expect(html).toContain("The preview could not load.");
    expect(html).toContain("There is no build to preview");
    // A null status is not printed as a number no server sent.
    expect(html).not.toContain("null —");
  });

  it("states that the guest is serving when the worker could not", () => {
    const html = render({ ...ready, served: "guest", note: "This browser has no worker." });

    expect(html).toContain('data-testid="preview-served-by"');
    expect(html).toContain("guest");
  });
});

describe("PreviewToolbar", () => {
  it("offers a rebuild once a build is published", () => {
    const html = renderToStaticMarkup(
      <PreviewToolbar phase={ready} onRefresh={() => undefined} available />,
    );

    expect(html).toContain("Rebuild preview");
    expect(html).not.toMatch(/data-testid="preview-build"[^>]*disabled/);
  });
});
