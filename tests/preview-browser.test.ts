/**
 * The preview pane's browser chrome, as decisions.
 *
 * The goal this file exists for is "no fake navigation", and that is a claim about behaviour,
 * not about markup: an arrow that is drawn but does nothing (or worse, that moves the *app's*
 * window history) would pass any screenshot. So the whole chrome is a reducer
 * (`src/ui/preview-browser.ts`) and these tests drive it directly:
 *
 * - a fresh build has one path in its history, so both arrows are dead;
 * - a path the frame visited is recorded, and only then does Back come alive — and going back
 *   asks the frame to load *that* path;
 * - reload re-navigates the URL on screen, not the build's root;
 * - and an observation (the frame routing itself) must never change what the frame is told to
 *   load, because that would reload the user's page 500 ms after they clicked a link.
 */

import { describe, expect, it } from "vitest";

import { PREVIEW_PREFIX } from "../src/preview/routing";
import {
  addressFor,
  beginBrowser,
  beginHistory,
  canGoBack,
  canGoForward,
  currentPath,
  normalisePath,
  pathFromFrameUrl,
  previewBrowserReducer,
  previewUrlFor,
  visit,
  type PreviewBrowserState,
  type PreviewBrowserAction,
} from "../src/ui/preview-browser";

const BUILD = "build-mf3k2-1";

function run(
  actions: readonly PreviewBrowserAction[],
  from: PreviewBrowserState = beginBrowser(),
): PreviewBrowserState {
  return actions.reduce(previewBrowserReducer, from);
}

describe("previewUrlFor", () => {
  it("names the build and always ends in a slash", () => {
    expect(previewUrlFor(BUILD)).toBe(`${PREVIEW_PREFIX}/${BUILD}/`);
    expect(addressFor(BUILD, "/")).toBe(`${PREVIEW_PREFIX}/${BUILD}/`);
  });

  it("serves a deep link inside the build", () => {
    expect(previewUrlFor(BUILD, "/app/editor")).toBe(`${PREVIEW_PREFIX}/${BUILD}/app/editor`);
    expect(previewUrlFor(BUILD, "app/editor")).toBe(`${PREVIEW_PREFIX}/${BUILD}/app/editor`);
  });

  it("encodes a build id that is not URL-safe", () => {
    expect(previewUrlFor("build/17")).toBe(`${PREVIEW_PREFIX}/build%2F17/`);
  });
});

describe("normalisePath", () => {
  it("gives one spelling per page, so the history cannot grow on a re-visit", () => {
    for (const spelling of ["", "/", "//", "app/editor", "/app/editor", "/app/editor/"]) {
      const expected = spelling.includes("editor") ? "/app/editor" : "/";
      expect(normalisePath(spelling)).toBe(expected);
    }
  });
});

describe("pathFromFrameUrl", () => {
  it("reads the path inside the build from a full URL or a pathname", () => {
    expect(pathFromFrameUrl(`http://127.0.0.1:5173${PREVIEW_PREFIX}/${BUILD}/`, BUILD)).toBe("/");
    expect(pathFromFrameUrl(`${PREVIEW_PREFIX}/${BUILD}/app/editor`, BUILD)).toBe("/app/editor");
    expect(pathFromFrameUrl(`http://host${PREVIEW_PREFIX}/${BUILD}/app/editor?x=1#h`, BUILD)).toBe(
      "/app/editor",
    );
  });

  it("decodes an escaped path, so the address bar shows what a browser would", () => {
    expect(pathFromFrameUrl(`${PREVIEW_PREFIX}/${BUILD}/a%20b`, BUILD)).toBe("/a b");
  });

  it("returns null for a document this build never served", () => {
    // The measured blank-pane failure: the frame's request was answered by the dev server with
    // the app's own HTML at `/`. Recording that as the address would print a URL for a page no
    // preview served.
    expect(pathFromFrameUrl("http://host/", BUILD)).toBeNull();
    expect(pathFromFrameUrl(`http://host${PREVIEW_PREFIX}/other-build/`, BUILD)).toBeNull();
    expect(pathFromFrameUrl("about:blank", BUILD)).toBeNull();
    expect(pathFromFrameUrl(null, BUILD)).toBeNull();
  });
});

describe("history", () => {
  it("starts with one entry and no way to move", () => {
    const history = beginHistory();

    expect(history.entries).toEqual(["/"]);
    expect(canGoBack(history)).toBe(false);
    expect(canGoForward(history)).toBe(false);
  });

  it("records a visited path and comes back to it", () => {
    const history = visit(beginHistory(), "/about");

    expect(history.entries).toEqual(["/", "/about"]);
    expect(currentPath(history)).toBe("/about");
    expect(canGoBack(history)).toBe(true);
    expect(canGoForward(history)).toBe(false);
  });

  it("returns the same object when the path has not moved", () => {
    // A 500 ms observation of a frame that is standing still must not cause a render.
    const history = visit(beginHistory(), "/about");
    expect(visit(history, "/about/")).toBe(history);
  });

  it("drops the forward entries when a new path is visited, as a browser does", () => {
    const back = previewBrowserReducer(
      previewBrowserReducer(
        previewBrowserReducer(beginBrowser(), { type: "visit", path: "/about" }),
        { type: "back" },
      ),
      { type: "visit", path: "/docs" },
    );

    expect(back.history.entries).toEqual(["/", "/docs"]);
    expect(canGoForward(back.history)).toBe(false);
  });
});

describe("previewBrowserReducer", () => {
  it("leaves both arrows dead at the start of a build, and says so by not moving", () => {
    const start = beginBrowser();

    expect(run([{ type: "back" }], start)).toBe(start);
    expect(run([{ type: "forward" }], start)).toBe(start);
  });

  it("only animates Back once the frame has actually visited somewhere", () => {
    const visited = run([{ type: "visit", path: "/about" }]);
    expect(canGoBack(visited.history)).toBe(true);

    const back = run([{ type: "back" }], visited);
    expect(currentPath(back.history)).toBe("/");
    // Going back is a real navigation, not just a move of the pointer: the frame is told to
    // load the path, which is what makes reloads and back/forward the same mechanism.
    expect(back.navigation.path).toBe("/");
    expect(back.navigation.nonce).toBeGreaterThan(visited.navigation.nonce);
    expect(run([{ type: "forward" }], back).navigation.path).toBe("/about");
  });

  it("reloads the URL on screen, not the build's root", () => {
    const deep = run([{ type: "visit", path: "/app/editor" }]);
    const reloaded = run([{ type: "reload" }], deep);

    expect(reloaded.navigation.path).toBe("/app/editor");
    expect(reloaded.navigation.nonce).toBe(deep.navigation.nonce + 1);
    // The history is untouched: a reload is not a navigation to somewhere new.
    expect(reloaded.history).toBe(deep.history);
  });

  it("never re-points the frame at a path it routed itself to", () => {
    // The reload-loop guard. An observation moves the address bar; it must not touch
    // `navigation`, or React would rewrite the iframe's src and reload the page the user is on.
    const before = beginBrowser();
    const afterVisit = previewBrowserReducer(before, { type: "visit", path: "/about" });

    expect(afterVisit.navigation).toBe(before.navigation);
    expect(afterVisit.navigation.path).toBe("/");
  });

  it("switches the device preset without touching the document", () => {
    const mobile = previewBrowserReducer(beginBrowser(), { type: "viewport", name: "mobile" });

    expect(mobile.viewport).toBe("mobile");
    expect(mobile.navigation).toEqual({ path: "/", nonce: 0 });
    // Selecting the preset that is already selected is not a render.
    expect(previewBrowserReducer(mobile, { type: "viewport", name: "mobile" })).toBe(mobile);
  });

  it("forgets the previous build's history when a new build arrives", () => {
    const deep = run([
      { type: "visit", path: "/about" },
      { type: "visit", path: "/docs" },
      { type: "reset" },
    ]);

    expect(deep.history.entries).toEqual(["/"]);
    expect(deep.navigation.path).toBe("/");
    // The nonce still advanced, so the frame is a fresh document even at the same URL.
    expect(deep.navigation.nonce).toBeGreaterThan(0);
  });
});
