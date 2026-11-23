/**
 * The browser chrome as markup: what the user (and the acceptance run) actually sees.
 *
 * `tests/preview-browser.test.ts` proves the decisions — when Back is dead, what reload
 * reloads, what a device preset does to the frame. This file proves the other half of the
 * goal's acceptance criterion: that those decisions are *rendered*, with a tab naming the
 * build, an address bar whose value is the preview URL, two disabled arrows at the start, a
 * reload control, and a device toolbar that shows the size it is claiming.
 *
 * Rendered with `renderToStaticMarkup`, like the rest of the UI tests. The two attributes that
 * matter most here — `disabled` and `value` — are attributes, so a static render proves them.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PREVIEW_PREFIX } from "../src/preview/routing";
import type { PreviewPhase } from "../src/preview/controller";
import { PreviewFrame } from "../src/ui/preview-frame";
import {
  PreviewBrowserBar,
  PreviewDeviceToolbar,
  PreviewTabStrip,
} from "../src/ui/preview-chrome";
import { PreviewPane, PreviewToolbar } from "../src/ui/preview-pane";
import { deviceFor, beginBrowser } from "../src/ui/preview-browser";
import { viewportFor } from "../src/ui/viewport";

const BUILD = "build-mf3k2-1";

const ready: PreviewPhase = {
  kind: "ready",
  buildId: BUILD,
  url: `${PREVIEW_PREFIX}/${BUILD}/`,
  files: 14,
  served: "worker",
  note: null,
};

function renderPane(phase: PreviewPhase, initialViewport?: "desktop" | "tablet" | "mobile"): string {
  return renderToStaticMarkup(
    <PreviewPane
      phase={phase}
      onRefresh={() => undefined}
      available
      {...(initialViewport !== undefined ? { initialViewport } : {})}
    />,
  );
}

describe("PreviewTabStrip", () => {
  it("names the document and the build in one tab, because two builds are two documents", () => {
    const html = renderToStaticMarkup(<PreviewTabStrip title="Website preview" buildId={BUILD} />);

    expect(html).toContain('data-testid="preview-tab-strip"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('data-testid="preview-tab"');
    expect(html).toContain(`data-build-id="${BUILD}"`);
    expect(html).toContain("Website preview");
    expect(html).toContain(`title="Build ${BUILD}"`);
  });

  it("carries no build id before anything is loaded, rather than an empty one", () => {
    const html = renderToStaticMarkup(<PreviewTabStrip title="Preview" buildId={null} />);

    expect(html).toContain('data-loaded="false"');
    expect(html).not.toContain('data-testid="preview-tab-build"');
  });
});

describe("PreviewBrowserBar", () => {
  function bar(overrides: Partial<Parameters<typeof PreviewBrowserBar>[0]> = {}): string {
    return renderToStaticMarkup(
      <PreviewBrowserBar
        address={`${PREVIEW_PREFIX}/${BUILD}/`}
        canGoBack={false}
        canGoForward={false}
        onBack={() => undefined}
        onForward={() => undefined}
        onReload={() => undefined}
        {...overrides}
      />,
    );
  }

  it("shows the preview URL in a read-only address bar", () => {
    const html = bar();

    expect(html).toContain('data-testid="preview-address"');
    expect(html).toContain(`value="${PREVIEW_PREFIX}/${BUILD}/"`);
    // Read-only, and an input rather than a div: the URL is derived from the build and the
    // frame's own path, never typed, but it must be selectable and copyable like a real one.
    expect(html).toMatch(/data-testid="preview-address"[^>]*readonly/);
  });

  it("ends the address with the frame's current path, so a deep link is visible", () => {
    expect(bar({ address: `${PREVIEW_PREFIX}/${BUILD}/app/editor` })).toContain(
      `value="${PREVIEW_PREFIX}/${BUILD}/app/editor"`,
    );
  });

  it("says nothing rather than something wrong when no document is loaded", () => {
    const html = bar({ address: "" });

    expect(html).toContain('data-testid="preview-address"');
    expect(html).toContain("Nothing loaded yet");
  });

  it("disables back and forward when the pane has no history to move through", () => {
    const html = bar();

    expect(html).toMatch(/data-testid="preview-back"[^>]*disabled=""/);
    expect(html).toMatch(/data-testid="preview-forward"[^>]*disabled=""/);
    // The arrows are real buttons, not links: a link would navigate the *app's* window.
    expect(html).toContain('aria-label="Back"');
    expect(html).toContain('aria-label="Forward"');
  });

  it("enables an arrow only when there is somewhere to go", () => {
    const html = bar({ canGoBack: true });

    expect(html).not.toMatch(/data-testid="preview-back"[^>]*disabled=""/);
    expect(html).toMatch(/data-testid="preview-forward"[^>]*disabled=""/);
  });

  it("offers reload, disabled only when there is no document to re-navigate", () => {
    expect(bar()).toContain('data-testid="preview-reload"');
    expect(bar()).not.toMatch(/data-testid="preview-reload"[^>]*disabled=""/);
    expect(bar({ reloadDisabled: true })).toMatch(/data-testid="preview-reload"[^>]*disabled=""/);
  });

  it("shows the origin when the caller knows it, and only the path when it does not", () => {
    expect(bar({ origin: "127.0.0.1:5173" })).toContain('data-testid="preview-address-origin"');
    expect(bar()).not.toContain('data-testid="preview-address-origin"');
  });
});

describe("PreviewDeviceToolbar", () => {
  it("lists the three presets, marks the current one, and states its size", () => {
    const desktop = renderToStaticMarkup(
      <PreviewDeviceToolbar viewport={viewportFor("desktop")} />,
    );

    for (const name of ["desktop", "tablet", "mobile"]) {
      expect(desktop).toContain(`data-testid="preview-viewport-${name}"`);
    }
    expect(desktop).toMatch(/data-testid="preview-viewport-desktop"[^>]*aria-pressed="true"/);
    expect(desktop).toMatch(/data-testid="preview-viewport-mobile"[^>]*aria-pressed="false"/);
    // Desktop is not a size: it follows the pane, and the readout says exactly that.
    expect(desktop).toContain("full width");
  });

  it("prints the exact size it is claiming, and the limit of that claim", () => {
    const mobile = renderToStaticMarkup(<PreviewDeviceToolbar viewport={viewportFor("mobile")} />);

    expect(mobile).toContain("390 × 844");
    expect(mobile).toMatch(/data-testid="preview-viewport-mobile"[^>]*aria-pressed="true"/);
    // The honesty note travels with the control: sizes the frame only, no touch, no DPR.
    expect(mobile).toContain("no touch events or device pixel ratio");
    expect(mobile).toContain('data-testid="preview-viewport-status"');
  });
});

describe("PreviewPane as a browser", () => {
  it("wraps the frame in a tab strip, a navigation bar and a device toolbar", () => {
    const html = renderPane(ready);

    expect(html).toContain('data-testid="preview-tab"');
    expect(html).toContain('data-testid="preview-browser-bar"');
    expect(html).toContain('data-testid="preview-device-toolbar"');
    expect(html).toContain('data-testid="preview-iframe"');
    // The chrome is above the document it wraps, in that order.
    expect(html.indexOf('data-testid="preview-tab"')).toBeLessThan(
      html.indexOf('data-testid="preview-browser-bar"'),
    );
    expect(html.indexOf('data-testid="preview-browser-bar"')).toBeLessThan(
      html.indexOf('data-testid="preview-device-toolbar"'),
    );
    expect(html.indexOf('data-testid="preview-device-toolbar"')).toBeLessThan(
      html.indexOf('data-testid="preview-iframe"'),
    );
  });

  it("puts the preview URL in the address bar and the build in the tab", () => {
    const html = renderPane(ready);

    expect(html).toContain(`value="${PREVIEW_PREFIX}/${BUILD}/"`);
    expect(html).toContain(`data-build-id="${BUILD}"`);
    // The frame's own src and the address bar agree: two spellings of one URL would be a lie
    // about where the document came from.
    expect(html).toContain(`src="${PREVIEW_PREFIX}/${BUILD}/"`);
  });

  it("starts a build with both arrows disabled and reload available", () => {
    const html = renderPane(ready);

    expect(html).toMatch(/data-testid="preview-back"[^>]*disabled=""/);
    expect(html).toMatch(/data-testid="preview-forward"[^>]*disabled=""/);
    expect(html).not.toMatch(/data-testid="preview-reload"[^>]*disabled=""/);
  });

  it("has no reload and no address before a build is published", () => {
    const html = renderPane({ kind: "idle" });

    expect(html).toMatch(/data-testid="preview-reload"[^>]*disabled=""/);
    expect(html).toContain("Nothing loaded yet");
    expect(html).toContain('data-loaded="false"');
  });

  it("opens at the preset the caller asked for, so a test can render the phone frame", () => {
    const html = renderPane(ready, "mobile");

    expect(html).toMatch(/data-testid="preview-viewport-mobile"[^>]*aria-pressed="true"/);
    // The frame itself carries the size: `100vw` inside the document is 390 px.
    expect(html).toMatch(/width:390px/);
    expect(html).toMatch(/height:844px/);
  });

  it("keeps the pane's own controls and the served-by badge under the chrome", () => {
    const html = renderPane(ready);

    expect(html).toContain('data-testid="preview-toolbar"');
    expect(html).toContain('data-testid="preview-served-by"');
    expect(html).toContain('data-testid="preview-status"');
    // …and inside the browser window, not floating over the document.
    expect(html.indexOf('data-testid="preview-toolbar"')).toBeLessThan(
      html.indexOf('data-testid="preview-iframe"'),
    );
  });

  it("keeps the error surface, chrome and all", () => {
    const html = renderPane({ kind: "failed", message: "There is no build to preview: dist/ is empty." });

    expect(html).toContain("The preview could not load.");
    expect(html).toContain("dist/ is empty");
    expect(html).not.toContain('data-testid="preview-iframe"');
    // A browser with no page still has a tab and an address bar.
    expect(html).toContain('data-testid="preview-tab"');
    expect(html).toContain('data-testid="preview-browser-bar"');
  });
});

describe("the frame under the chrome", () => {
  it("loads the path it is told to load, which is not necessarily the one on screen", () => {
    const html = renderToStaticMarkup(
      <PreviewFrame buildId={BUILD} path="/app/editor" reloadKey={3} />,
    );

    expect(html).toContain(`src="${PREVIEW_PREFIX}/${BUILD}/app/editor"`);
    expect(html).toContain('data-path="/app/editor"');
    // The build and the reload nonce are what React keys on, so a reload is a fresh document.
    expect(html).toContain('data-build-id="build-mf3k2-1"');
  });
});

describe("the toolbar without the device control", () => {
  it("no longer renders a viewport control, because the device toolbar owns it", () => {
    const html = renderToStaticMarkup(
      <PreviewToolbar phase={ready} onRefresh={() => undefined} available />,
    );

    expect(html).not.toContain('data-testid="preview-viewport-mobile"');
    expect(html).toContain('data-testid="preview-build"');
    expect(html).toContain('data-testid="preview-served-by"');
  });
});

describe("deviceFor", () => {
  it("reads the preset out of the browser state", () => {
    expect(deviceFor(beginBrowser("tablet")).width).toBe(834);
    expect(deviceFor(beginBrowser()).height).toBeNull();
  });
});
