/**
 * The preview pane's browser chrome, as data.
 *
 * The pane used to be an iframe with a floating "Reload" button and three device buttons in a
 * toolbar. What it has to be is a *browser*: a tab that names what is loaded, back/forward that
 * are only enabled when there is somewhere to go, an address bar that shows the URL actually
 * loaded, and a reload that means "load this URL again". None of that is decoration, and none
 * of it may be faked: a back button that is always clickable but does nothing is worse than no
 * button at all, because it tells the user their navigation did something when it did not.
 *
 * So the whole thing is a reducer over three values \u2014 what the frame has visited, what we last
 * asked it to load, and which device preset sizes it \u2014 and this module has no React in it. That
 * matters for two reasons:
 *
 * 1. the behaviours the goal names (back disabled at start, forward disabled at start, a reload
 *    that really re-navigates, a device toolbar that really resizes) are *decisions*, and a
 *    decision can be tested without a DOM. The unit tests in `tests/preview-browser.test.ts`
 *    drive this reducer directly, so "no fake navigation" is asserted rather than assumed;
 * 2. the frame must not be reloaded by accident. The address bar follows an SPA's own
 *    `pushState` navigation \u2014 which means the observed path changes without anyone asking the
 *    frame to do anything. If the frame's `src` were derived from the observed path, React would
 *    write the new attribute 500 ms later and the browser would reload the document the user is
 *    happily using, throwing away their client-side state. So the frame's URL comes only from
 *    `navigation`, which changes on an explicit back/forward/reload/new-build, and never from an
 *    observation.
 *
 * The history is therefore honest in the only way this pane can be honest about it: it is the
 * list of paths the frame *actually visited* in this build, not a copy of the browser's own
 * session history (a sandboxed same-origin frame's history is the parent's, and pushing entries
 * into it would break the app's own Back button). A fresh build starts with one entry, so both
 * arrows are disabled \u2014 which is what a browser with one page in it shows, too.
 */

import { PREVIEW_PREFIX } from "@/preview/routing";
import { viewportFor, type ViewportName } from "@/ui/viewport";

/** The URL a build is previewed at. Always trailing-slashed: the worker's scope needs it. */
export function previewUrlFor(buildId: string, path = ""): string {
  const suffix = path.replace(/^\/+/, "");
  return `${PREVIEW_PREFIX}/${encodeURIComponent(buildId)}/${suffix}`;
}

/** The address bar's text for a build and a path inside it. Same function: one URL, one form. */
export function addressFor(buildId: string, path: string): string {
  return previewUrlFor(buildId, path);
}

/**
 * A path inside a build, normalised to what a browser's location would show.
 *
 * `""`, `"/"`, `"app/editor/"` and `"/app/editor"` are one path each: the address bar must not
 * flicker between spellings of the same page, and the history must not grow an entry every time
 * a link is followed to the page it is already on.
 */
export function normalisePath(path: string): string {
  const trimmed = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : `/${trimmed}`;
}

/**
 * The URL the frame is on, as a URL object, or null when it is not a page at all.
 *
 * `about:blank` \u2014 which is what a frame holds before its document arrives \u2014 parses with an
 * `about:` protocol and a pathname of `blank`; reading that as a path would print a URL for a
 * page no preview ever served. Only HTTP(S) documents are pages of a build.
 */
function parseFrameUrl(url: string | null): URL | null {
  if (url === null || url.length === 0) return null;
  let parsed: URL;
  try {
    // A relative base only needs to exist: every value read here is a path, never an origin.
    parsed = new URL(url, "http://preview.invalid");
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed : null;
}

/** A percent-encoded path as the path itself: what a browser's address bar would show. */
function decodePath(encoded: string): string {
  try {
    return normalisePath(decodeURIComponent(encoded));
  } catch {
    // A malformed escape is still a path; showing it verbatim beats hiding the page.
    return normalisePath(encoded);
  }
}

/** The query and the fragment, verbatim: a browser keeps them, so this pane keeps them too. */
function suffixOf(parsed: URL): string {
  return `${parsed.search}${parsed.hash}`;
}

/**
 * The path inside a build for a URL the frame is showing, or null when the URL is not a page.
 *
 * Two spellings of the same build's page exist, and both are followed:
 *
 * - **The build's own URLs** \u2014 `/__preview__/<buildId>/<path>` \u2014 which a rebased link, a
 *   back/forward or a reload put in the frame. The prefix is stripped, and what is left is the
 *   path (`pathFromFrameUrl` has always done this part).
 * - **The site's own root-absolute paths** \u2014 `/blogs` \u2014 which a client-side router wrote with
 *   `history.pushState`. The document in the frame is still this build's document; only the
 *   path stopped carrying the prefix, because an SPA routes against its own root and cannot
 *   know it is being previewed under one. Returning null here (what this function used to do)
 *   is precisely the bug users report as "the address bar does not follow the nav": the site
 *   moves to `/blogs`, the frame keeps rendering it, and the omnibox sits on the build root
 *   for ever. So the path is *rebased* into the build's space \u2014 `.../__preview__/<buildId>/blogs`
 *   \u2014 which is the URL the same page is shown at everywhere else in this pane, and the URL the
 *   build really answers that path with (the SPA fallback).
 *
 * Still null, because it is the honest answer: a *different* build's document
 * (`/__preview__/other-build/\u2026`) is a page this build never served, a non-HTTP document is not a
 * page, and an empty URL is nothing at all.
 *
 * The limit of the rebase is stated rather than hidden: a previewed document served by the dev
 * server or by the host's SPA redirect (the blank-pane failure) is the *app's* page, and its
 * path would be rebased too. That is a preview that is not rendering at all \u2014 the frame shows
 * the app inside itself \u2014 and no address bar can make it honest; the pane's own tab, which
 * names the build, is the part that stays true.
 */
export function pathFromFrameUrl(url: string | null, buildId: string): string | null {
  const parsed = parseFrameUrl(url);
  if (parsed === null) return null;
  const { pathname } = parsed;
  const suffix = suffixOf(parsed);

  const prefix = `${PREVIEW_PREFIX}/${encodeURIComponent(buildId)}`;
  if (pathname === prefix) return `/${suffix}`;
  if (pathname.startsWith(`${prefix}/`)) {
    return `${decodePath(pathname.slice(prefix.length + 1))}${suffix}`;
  }

  // Another build's preview is a different document: `/__preview__/<other>/...` is not this
  // build's page, and reading a path out of it would claim it for this one.
  if (pathname === PREVIEW_PREFIX || pathname.startsWith(`${PREVIEW_PREFIX}/`)) return null;

  // Anything else on this origin is this build's document routing itself (see above).
  return `${decodePath(pathname)}${suffix}`;
}

/**
 * The frame's current URL, or null when it cannot be read.
 *
 * The read throws for a cross-origin document, and throws again while about:blank is still the
 * frame's document. Neither is an error worth showing: both mean "no observation this tick".
 */
export function readFrameUrl(frame: HTMLIFrameElement | null): string | null {
  if (frame === null) return null;
  try {
    const href: unknown = frame.contentWindow?.location.href;
    return typeof href === "string" && href.length > 0 ? href : null;
  } catch {
    return null;
  }
}

/** The paths a frame has visited in one build, and where in them it is. */
export interface PreviewHistory {
  readonly entries: readonly string[];
  readonly index: number;
}

export function beginHistory(path = "/"): PreviewHistory {
  return { entries: [normalisePath(path)], index: 0 };
}

export function currentPath(history: PreviewHistory): string {
  return history.entries[history.index] ?? "/";
}

export function canGoBack(history: PreviewHistory): boolean {
  return history.index > 0;
}

export function canGoForward(history: PreviewHistory): boolean {
  return history.index < history.entries.length - 1;
}

/**
 * Record that the frame is showing `path`.
 *
 * Following a link discards the forward entries, exactly as a browser does; re-visiting the
 * path already shown returns the *same object*, so a 500 ms observation of a frame that has not
 * moved cannot cause a render.
 */
export function visit(history: PreviewHistory, path: string): PreviewHistory {
  const target = normalisePath(path);
  if (target === currentPath(history)) return history;
  const entries = [...history.entries.slice(0, history.index + 1), target];
  return { entries, index: entries.length - 1 };
}

/** What we last asked the frame to load. `nonce` is what makes a reload a reload. */
export interface PreviewNavigation {
  readonly path: string;
  readonly nonce: number;
}

export interface PreviewBrowserState {
  /** What the frame has visited: drives the address bar and the two arrows. */
  readonly history: PreviewHistory;
  /** What the frame was told to load: drives the iframe's `src` and its key. */
  readonly navigation: PreviewNavigation;
  /** The device preset that sizes the frame. */
  readonly viewport: ViewportName;
}

export type PreviewBrowserAction =
  /** The frame navigated itself (a link, a router push, a `load`). Address bar only. */
  | { type: "visit"; path: string }
  /** The user typed an address: record it *and* load it. */
  | { type: "navigate"; path: string }
  | { type: "back" }
  | { type: "forward" }
  /** Re-navigate to the path on screen: the browser's own arrow, not a re-publish alone. */
  | { type: "reload" }
  | { type: "viewport"; name: ViewportName }
  /** A different build: a new document at its root, and a new history. */
  | { type: "reset" };

export function beginBrowser(viewport: ViewportName = "desktop"): PreviewBrowserState {
  return {
    history: beginHistory(),
    navigation: { path: "/", nonce: 0 },
    viewport,
  };
}

export function previewBrowserReducer(
  state: PreviewBrowserState,
  action: PreviewBrowserAction,
): PreviewBrowserState {
  switch (action.type) {
    case "visit": {
      // `visit` returns the same object when the path has not moved, so observing a frame
      // that is already on this path is a no-op rather than a render every 500 ms.
      const history = visit(state.history, action.path);
      return history === state.history ? state : { ...state, history };
    }

    case "navigate": {
      // A typed address is an explicit navigation, which is the one thing `visit` is not: the
      // frame is told to load the path as well as the history recording it. Typing the address
      // already on screen therefore reloads it, which is what a browser does.
      const target = normalisePath(action.path);
      return {
        ...state,
        history: visit(state.history, target),
        navigation: { path: target, nonce: state.navigation.nonce + 1 },
      };
    }

    case "back": {
      if (!canGoBack(state.history)) return state;
      const history: PreviewHistory = { entries: state.history.entries, index: state.history.index - 1 };
      return { ...state, history, navigation: { path: currentPath(history), nonce: state.navigation.nonce + 1 } };
    }

    case "forward": {
      if (!canGoForward(state.history)) return state;
      const history: PreviewHistory = { entries: state.history.entries, index: state.history.index + 1 };
      return { ...state, history, navigation: { path: currentPath(history), nonce: state.navigation.nonce + 1 } };
    }

    case "reload":
      // The path on screen, not the build's root: a browser's reload keeps the URL.
      return {
        ...state,
        navigation: { path: currentPath(state.history), nonce: state.navigation.nonce + 1 },
      };

    case "viewport":
      return state.viewport === action.name ? state : { ...state, viewport: action.name };

    case "reset":
      return {
        history: beginHistory(),
        navigation: { path: "/", nonce: state.navigation.nonce + 1 },
        viewport: state.viewport,
      };
  }
}

/** The device preset the state names. */
export function deviceFor(state: PreviewBrowserState) {
  return viewportFor(state.viewport);
}
