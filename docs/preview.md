# The preview

The preview shows the site the guest actually built. Not a mock, not a sandboxed copy of
the source: the bytes under the project's publish directory, served over HTTP, rendered in
an iframe at real URLs.

This page explains how that works, why the pieces are split the way they are, and what a
previewed site cannot do.

## The three places a preview runs

```
  guest                          page                         iframe
┌──────────────────┐      ┌────────────────────┐      ┌──────────────────────┐
│ preview-server   │ HTTP │ proxy.ts           │      │ sandbox="allow-      │
│ (Node, serves    │◄────►│ routing.ts decides │─────►│ scripts allow-forms" │
│  dist/ on 8123)  │  TCP │ every header       │      │ no allow-same-origin │
└──────────────────┘      │            │       │      └──────────────────────┘
                          │            ▼       │
                          │   preview-sw.js    │
                          │  (holds a snapshot)│
                          └────────────────────┘
```

- **`src/preview/guest-server.ts`** writes a Node script into the guest
  (`.larpable/preview-server.mjs`), starts it on port 8123 and waits for its
  `LARPABLE-PREVIEW-LISTENING` line. The image has no `python3`, `busybox`, `php` or `ruby`
  (measured — see the comment at the top of that file), so Node is the only runtime
  available, and `RuntimeBootstrap` has already warmed it.
- **`src/preview/routing.ts`** decides everything that depends only on a path: what a
  preview URL means, which file answers it, the `Content-Type`, the cache policy, whether
  an SPA deep link is rewritten, and whether the build is stale. It has no browser and no
  guest dependency, so it is unit-tested directly.
- **`src/preview/transport.ts`** is the only place that knows how to reach the guest:
  `kernel.fetch()` over the guest's loopback. On the host that is unkernel's HTTP/1.1
  client; in a test it is a table.
- **`src/preview/proxy.ts`** composes the two: it answers a preview URL from the guest
  using routing's decisions, and it collects a whole build into a snapshot (every file
  fetched, every header decided once) that the service worker can hold.
- **`public/preview-sw.js`** answers `fetch` events on `/__preview__/<buildId>/…` out of
  that snapshot, so a previewed page's own `import()` and `<link rel=stylesheet>` never
  make a round trip into the guest.
- **`src/ui/preview-frame.tsx`** renders the iframe and the states around it.

## Why a service worker, and not a blob URL

A Vite build emits `<script type="module" src="/assets/index-abc123.js">`, CSS that
references `/assets/font-def.woff2`, dynamic `import()` calls, and — if the project has a
router — code that reads `location.pathname`.

A `blob:` URL satisfies the first of those and breaks on all the others, because every
relative URL resolves against the blob, not the site. A service worker at
`/__preview__/<buildId>/` gets them right for the same reason Netlify does: the browser
resolves those URLs normally, and something is listening.

The worker is registered as a **module** worker (`type: "module"`), with scope
`/__preview__/`. That scope is below the script's own directory (`/`), so it needs no
`Service-Worker-Allowed` header.

## Staleness: a preview never serves the previous build

Every build gets a new id. Three things enforce it:

1. the URL contains the id (`/__preview__/b-17/…`), so a page is pinned to a build;
2. the worker refuses a request whose id is not the current one with **409** and a message
   naming both builds — it does not fall back to the current bytes;
3. the proxy does the same, and checks before it fetches anything, so a stale request
   never reaches the guest.

The point is that "the preview is showing the old version" is the failure mode users
cannot diagnose. A 409 says it.

## The sandbox, and what it costs

```tsx
sandbox = "allow-scripts allow-forms";
```

No `allow-same-origin`. Preview URLs are on the app's own origin, so a same-origin document
could read the app's `localStorage` — projects, conversations, provider settings — with one
`localStorage.getItem`. Without `allow-same-origin` the document gets an opaque origin:
scripts run, storage and cookies do not exist, and the parent app is out of reach.

No `allow-top-navigation`, no `allow-popups`, no `allow-modals`, no `allow-downloads`: a
preview must not be able to leave the app, open a window, freeze it with `alert()`, or drop
a file on the user's disk.

## Documented limits: what a previewed site cannot do

These are consequences of the sandbox, not bugs. They are listed so a user who sees them
knows where to look.

| A previewed site cannot… | Why | What the user sees |
| --- | --- | --- |
| use `localStorage`, `sessionStorage`, `indexedDB` | opaque origin | a theme toggle resets on every reload; some apps throw `SecurityError` |
| read or write cookies, or call an authenticated API | opaque origin, no credentials | the site's own login flow fails inside the preview |
| register its own service worker | opaque origin | a PWA's offline mode does not activate |
| `alert()` / `confirm()` / `prompt()` | no `allow-modals` | the call returns without showing anything |
| open a popup, or navigate the top window | no `allow-popups` / `allow-top-navigation` | `window.open` is a no-op; a `target=_top` link does nothing |
| use WebAssembly modules over 4 KB without CORS headers | the worker is the server | fine for a normal build — the worker sends `access-control-allow-origin: *` |

**Assets that are not HTTP-servable at all.** Two cases exist and both are handled by
refusing rather than guessing:

- **A build that produced no HTML entry point** cannot be previewed. There is nothing to
  render, so the preview reports the empty/publish-directory problem from
  `collectPreviewSnapshot` instead of showing a blank frame. A publish directory that
  contains only assets (a library build) is not a site.
- **A file whose bytes are not a document** — a `.wasm`, a font, an image — is served with
  its real type and `x-content-type-options: nosniff`, and is only ever fetched by the
  page, never opened as the preview itself.

If a site needs storage, the honest answer is to deploy it: a preview is for looking at the
site, and Netlify is where it becomes real.

## The message protocol

| Direction | Message | Meaning |
| --- | --- | --- |
| page → worker | `larpable:preview:publish` | here is a whole build: `{ buildId, fallbackPath, files }` |
| worker → page | `larpable:preview:published` | `{ buildId, files }` — how many files were accepted |
| page → worker | `larpable:preview:clear` | forget the build |

Publishing **waits for the confirmation**. `postMessage` succeeds whether or not anything
is listening, so without a reply a failed publish looks exactly like a successful one — and
the iframe would show the previous build while the UI claimed a new one. If the reply does
not arrive in time, the publish is reported as a failure.

## Testing the preview

| What | Where |
| --- | --- |
| URL parsing, MIME, cache policy, fallback, staleness | `tests/preview-routing.test.ts` |
| worker answers, and agrees with routing | `tests/preview-service-worker.test.ts` |
| proxy decisions and snapshot collection | `tests/preview-proxy.test.ts` |
| registration, publish protocol, timeouts | `tests/preview-client.test.ts` |
| sandbox policy and pane states | `tests/preview-frame.test.tsx` |
| the guest server itself | `tests/preview-guest-server.test.ts` |
| a real guest serving a real build | `LARPABLE_GUEST_TESTS=1 bun run test:guest` |
