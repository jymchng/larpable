/**
 * The iframe policy, kept away from the component so a browser run can apply exactly the
 * sandbox the product applies.
 *
 * The browser acceptance run builds a real iframe inside a real page to prove that guest
 * bytes render. If it re-typed the attribute, the run would prove the harness's sandbox
 * rather than the product's, so the string lives here and `preview-frame.tsx` imports it.
 */

/**
 * The sandbox policy for a previewed site.
 *
 * `allow-same-origin` is here against the original design, and the reason is measured
 * rather than preferred. A preview is served by a service worker at `/__preview__/<id>/`,
 * and Chromium does not hand a sandboxed iframe's requests to a worker unless that frame has
 * an origin to match the worker's scope: with `sandbox="allow-scripts"` alone the frame is
 * opaque, `clients.matchAll()` does not list it, and `/__preview__/<id>/` is answered by the
 * dev server (or Netlify's SPA redirect) with the *app's* own `index.html` — which then dies
 * on `indexedDB` and shows an empty frame. That was the blank pane users saw.
 *
 * The cost is stated plainly rather than hidden: a previewed site shares this app's origin,
 * so it can read and write the app's `localStorage` and `indexedDB` (project list,
 * conversations), and it can remove its own `sandbox` attribute. Two things keep that from
 * being worse than it sounds: the build being previewed is the user's own project — code
 * their own agent wrote, in a VM that already runs its `postinstall` scripts — and this app
 * keeps no secret, no key and no token in origin storage, so a preview has nothing of value
 * to steal beyond what the user can already see. The genuinely isolated answer is to serve
 * previews from a separate origin; that is tracked as its own piece of work.
 *
 * Deliberately still absent: `allow-top-navigation` (leaving the app), `allow-popups` (a
 * `window.open` in guest code must not escape), `allow-modals` (`alert()` would freeze the
 * editor) and `allow-downloads`.
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-forms allow-same-origin";
