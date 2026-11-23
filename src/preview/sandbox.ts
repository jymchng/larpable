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
 * `allow-scripts` is the point of a preview; `allow-forms` covers the contact form every
 * landing page has. Deliberately absent: `allow-same-origin` (storage, cookies, the parent
 * app's DOM), `allow-top-navigation` (leaving the app), `allow-popups` (a `window.open` in
 * guest code must not escape), `allow-modals` (`alert()` would freeze the editor) and
 * `allow-downloads`.
 *
 * The cost is real and documented rather than hidden: a previewed site cannot use
 * `localStorage`, `sessionStorage`, `indexedDB` or cookies, so a site that persists a theme
 * choice will look reset on every reload.
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-forms";
