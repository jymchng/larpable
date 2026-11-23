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
 * The path inside a build for a URL the frame is showing, or null when the URL is not this
 * build's.
 *
 * Null is the honest answer for a frame showing something else \u2014 which is exactly the failure
 * users reported as a blank pane: the frame's `/__preview__/<id>/` request was answered by the
 * dev server, so the document inside the frame was the app's own page at `/`. Recording that as
 * the address would print a URL for a document no preview ever served.
 */
export function pathFromFrameUrl(url: string | null, buildId: string): string | null {
  if (url === null || url.length === 0) return null;
  let pathname: string;
  try {
    // A relative base only needs to exist: every value read here is a path, never an origin.
    pathname = new URL(url, "http://preview.invalid").pathname;
  } catch {
    return null;
  }

  const prefix = `${PREVIEW_PREFIX}/${encodeURIComponent(buildId)}`;
  if (pathname === prefix) return "/";
  if (!pathname.startsWith(`${prefix}/`)) return null;

  const rest = pathname.slice(prefix.length + 1);
  try {
    return normalisePath(decodeURIComponent(rest));
  } catch {
    // A malformed escape is still a path; showing it verbatim beats hiding the page.
    return normalisePath(rest);
  }
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
