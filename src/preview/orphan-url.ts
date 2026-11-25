/**
 * What to show when someone opens a preview URL on its own.
 *
 * A preview's address is `/__preview__/<session>/…`, and it is answered by the service worker
 * that the *running app* registered, using a snapshot or a forwarder that lives in that app's
 * page. Two consequences follow, and both used to be invisible:
 *
 * - **The address is not a page.** Open it in a new tab, or paste it to someone else, and no
 *   worker controls that navigation — so the host's SPA fallback answers with the app's own
 *   `index.html`. What the visitor saw was Larpable itself, booting a Linux machine, on a URL
 *   that promised a preview. On a static host this is doubly confusing: the deployed bundle
 *   re-registers a worker, and the *frame* could boot a second machine inside itself.
 * - **The id is a counter.** `dev-6` means the sixth attach since the page loaded; a reload
 *   makes it `dev-7`. A copied URL is stale the moment it is copied.
 *
 * So this module answers one question — "is this a preview address with nobody behind it?" —
 * and paints a short page when it is. It deliberately does *not* try to serve a preview: there
 * is no session to serve, and pretending otherwise is how a user ends up debugging a machine
 * boot that was never going to help.
 */

import { PREVIEW_PREFIX } from "./routing";

/**
 * True when this document is a preview URL that nothing is answering.
 *
 * `controlled` is `navigator.serviceWorker.controller !== null`. Inside the pane's iframe the
 * worker *does* control the document, so the preview renders as normal; a cold navigation has
 * no controller, which is exactly the case this page exists for.
 */
export function isOrphanPreviewVisit(pathname: string, controlled: boolean): boolean {
  return controlled === false && pathname.startsWith(`${PREVIEW_PREFIX}/`);
}

/** The sentence a visitor needs: what this address is, why it is empty, and where to go. */
export function orphanPreviewMessage(pathname: string): string {
  return `The preview you asked for is not a page of its own. ${describeSession(pathname)} Open Larpable and press the pane's reload arrow there.`;
}

/** The session id, in the words the pane uses, or a neutral phrase if the path has none. */
function describeSession(pathname: string): string {
  const [raw = ""] = pathname.slice(PREVIEW_PREFIX.length + 1).split("/");
  const session = decodeURIComponent(raw);
  return session.length === 0
    ? "Its id changes every time the pane reloads."
    : `${session} was the id of one pane in a session that has ended, and the id changes every time the pane reloads.`;
}

/**
 * Paint the page: a heading, the sentence, and one way out.
 *
 * Built with DOM calls rather than an HTML string so the pathname cannot inject markup, and
 * styled inline so this page works before any stylesheet has loaded (it is shown precisely
 * when the app's own assets are not the thing being asked for).
 */
export function renderOrphanPreviewVisit(root: HTMLElement, pathname: string): void {
  root.replaceChildren();

  const wrapper = document.createElement("main");
  wrapper.setAttribute("data-testid", "preview-orphan");
  wrapper.style.cssText = [
    "font-family: ui-sans-serif, system-ui, sans-serif",
    "max-width: 34rem",
    "margin: 12vh auto",
    "padding: 0 1.25rem",
    "line-height: 1.6",
  ].join(";");

  const heading = document.createElement("h1");
  heading.textContent = "This preview lives inside Larpable";
  heading.style.cssText = "font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75rem;";

  const body = document.createElement("p");
  body.textContent = orphanPreviewMessage(pathname);
  body.style.cssText = "margin: 0 0 1.25rem;";

  const link = document.createElement("a");
  link.href = "/";
  link.textContent = "Open Larpable";
  link.style.cssText = [
    "display: inline-block",
    "padding: 0.5rem 0.9rem",
    "border-radius: 0.5rem",
    "border: 1px solid currentColor",
    "font-weight: 600",
    "text-decoration: none",
  ].join(";");

  wrapper.append(heading, body, link);
  root.append(wrapper);
}
