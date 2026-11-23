/**
 * The preview pane's two promises: a restrictive sandbox, and no blank frame.
 *
 * Rendered with `renderToStaticMarkup`, like the rest of the UI tests, because what matters
 * here is the markup the browser receives — the `sandbox` token list and the URL are
 * attributes, not behaviour. A test that asserted "the iframe mounted" would pass with
 * `allow-same-origin` in the policy, which is the one mistake that matters: guest code
 * would then read the app's `localStorage`.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PREVIEW_PREFIX } from "../src/preview/routing";
import {
  PREVIEW_IFRAME_SANDBOX,
  PreviewFrame,
  PreviewPanel,
  previewUrlFor,
  type PreviewState,
} from "../src/ui/preview-frame";

function render(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe("previewUrlFor", () => {
  it("names the build and always ends in a slash", () => {
    expect(previewUrlFor("b-17")).toBe(`${PREVIEW_PREFIX}/b-17/`);
  });

  it("serves a deep link inside the build", () => {
    expect(previewUrlFor("b-17", "/app/editor")).toBe(`${PREVIEW_PREFIX}/b-17/app/editor`);
    expect(previewUrlFor("b-17", "app/editor")).toBe(`${PREVIEW_PREFIX}/b-17/app/editor`);
  });

  it("encodes a build id that is not URL-safe", () => {
    expect(previewUrlFor("build/17")).toBe(`${PREVIEW_PREFIX}/build%2F17/`);
  });
});

describe("PreviewFrame", () => {
  it("runs scripts, and keeps the origin the worker needs to serve them", () => {
    // `allow-same-origin` is deliberate and measured. A sandboxed frame without it is an
    // opaque origin, which Chromium refuses to hand to a service worker: the frame's
    // `/__preview__/<id>/` request goes to the dev server (and to Netlify's SPA redirect in
    // production) and the app's own HTML is loaded into the frame, which then dies on
    // `indexedDB` — the blank pane users reported. The cost, stated in `sandbox.ts`: the
    // previewed build shares this app's origin.
    expect(PREVIEW_IFRAME_SANDBOX.split(" ")).toContain("allow-scripts");
    expect(PREVIEW_IFRAME_SANDBOX.split(" ")).toContain("allow-same-origin");
    expect(PREVIEW_IFRAME_SANDBOX.split(" ")).toContain("allow-forms");
  });

  it("grants nothing that lets guest code leave the pane", () => {
    for (const token of [
      "allow-top-navigation",
      "allow-top-navigation-by-user-activation",
      "allow-popups",
      "allow-modals",
      "allow-downloads",
      "allow-pointer-lock",
    ]) {
      expect(PREVIEW_IFRAME_SANDBOX).not.toContain(token);
    }
  });

  it("points at the build's URL with the sandbox policy attached", () => {
    const html = render(<PreviewFrame buildId="b-17" />);
    expect(html).toContain(`src="${PREVIEW_PREFIX}/b-17/"`);
    expect(html).toContain(`sandbox="${PREVIEW_IFRAME_SANDBOX}"`);
    expect(html).toContain('data-build-id="b-17"');
  });

  it("sends no referrer to guest code", () => {
    // The preview URL is on the app's origin; a referrer would leak the route the user is on.
    // React serialises `referrerPolicy` in camel case; HTML attributes are case-insensitive.
    expect(render(<PreviewFrame buildId="b-17" />)).toMatch(/referrerpolicy="no-referrer"/i);
  });

  it("is a labelled frame, not an anonymous box", () => {
    expect(render(<PreviewFrame buildId="b-17" title="Landing page" />)).toContain(
      'title="Landing page"',
    );
  });
});

describe("PreviewPanel", () => {
  const cases: { state: PreviewState; text: string }[] = [
    { state: { kind: "building", buildId: "b-17" }, text: "Building the site…" },
  ];

  for (const { state, text } of cases) {
    it(`says "${text}" instead of rendering an empty frame`, () => {
      const html = render(<PreviewPanel state={state} />);
      expect(html).toContain(text);
      expect(html).not.toContain("<iframe");
    });
  }

  it("renders no placeholder at all before the first build", () => {
    // "No production build yet." and the copy under it were removed on request: an idle pane is
    // the browser chrome and nothing else, so there is no div to leave behind either.
    const html = render(<PreviewPanel state={{ kind: "idle" }} />);

    expect(html).not.toContain("No production build yet.");
    expect(html).not.toContain("never a mock page");
    expect(html).not.toContain('data-testid="preview-placeholder"');
    expect(html).not.toContain("<iframe");
  });

  it("renders the frame and a reload control once a build is ready", () => {
    const html = render(<PreviewPanel state={{ kind: "ready", buildId: "b-17" }} />);
    expect(html).toContain("<iframe");
    expect(html).toContain('data-testid="preview-reload"');
  });

  it("shows the routing module's failure message rather than a blank pane", () => {
    // These are the bodies `routing.ts` writes: 503 before a build, 409 for a stale build.
    const html = render(
      <PreviewPanel
        state={{
          kind: "error",
          status: 409,
          message: "This page belongs to build b-16, but the current build is b-17.",
        }}
      />,
    );
    expect(html).toContain("409");
    expect(html).toContain("belongs to build b-16");
    expect(html).not.toContain("<iframe");
  });

  it("keeps the toolbar above the frame", () => {
    const html = render(
      <PreviewPanel
        state={{ kind: "ready", buildId: "b-1" }}
        toolbar={<span data-testid="toolbar">desktop</span>}
      />,
    );
    expect(html.indexOf('data-testid="toolbar"')).toBeLessThan(html.indexOf("<iframe"));
  });

  /**
   * The pane is a browser window now, and these two assertions are the contract that made it
   * one: the chrome is *above* the document (a tab strip, a navigation bar, a device toolbar),
   * and the frame's URL is not the address bar's value when the site routed itself — otherwise
   * watching the address would reload the page the user is reading.
   */
  it("puts a tab strip, a navigation bar and a device toolbar above the frame", () => {
    const html = render(<PreviewPanel state={{ kind: "ready", buildId: "b-17" }} />);

    expect(html).toContain('data-testid="preview-tab-strip"');
    expect(html).toContain('data-testid="preview-browser-bar"');
    expect(html).toContain('data-testid="preview-device-toolbar"');
    expect(html.indexOf('data-testid="preview-browser-bar"')).toBeLessThan(
      html.indexOf("<iframe"),
    );
  });

  it("loads the path it was told to load while the address shows where the frame is", () => {
    const html = render(
      <PreviewPanel state={{ kind: "ready", buildId: "b-17" }} path="/about" framePath="/" />,
    );

    // The address follows the frame…
    expect(html).toContain(`value="${PREVIEW_PREFIX}/b-17/about"`);
    // …and the frame is not re-pointed at it, which would reload the user's page.
    expect(html).toContain(`src="${PREVIEW_PREFIX}/b-17/"`);
  });
});
