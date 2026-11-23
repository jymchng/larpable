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
| the app's state machine, phases and wording | `tests/preview-controller.test.ts` |
| the build id and the publish-directory listing | `tests/preview-build-id.test.ts` |
| the pane's phase → state mapping and controls | `tests/preview-pane.test.tsx` |
| the guest server itself | `tests/preview-guest-server.test.ts` |
| a real guest serving a real build | `LARPABLE_GUEST_TESTS=1 bun run test:guest` |

## How the app drives it

The modules above are each honest about one step. The order they run in, and what the pane
says while they do, lives in two files:

| File | Job |
| --- | --- |
| `src/preview/controller.ts` | The state machine: booted machine → listed `dist/` → build id → published snapshot. Plain TypeScript, so `scripts/` can drive the same object the app does. |
| `src/ui/use-preview.ts` | The React binding: owns the controller's lifetime and turns phases into renders. |
| `src/ui/preview-pane.tsx` | Maps a phase onto the sandboxed frame and says how the bytes are arriving. |
| `src/preview/build-id.ts` | The id in the URL, and the recursive listing it is derived from. |

The phases are the user's experience, not the implementation's:

| Phase | The pane shows |
| --- | --- |
| `idle` | "No preview published yet." with a **Preview build** control |
| `starting` | `Starting the guest's server for dist/…` — this is a real `node` start, seconds to a minute |
| `publishing` | `Reading N files out of the guest…` |
| `ready` | the iframe, plus whether a **worker** or the **guest** is serving |
| `failed` | the reason in full, e.g. `There is no build to preview: dist/ is empty or missing in the guest.` |

Three decisions in that mapping are worth knowing:

- **A preview is asked for, never automatic.** Starting the guest's server costs a process
  launch and the snapshot costs one pass over `dist/`; doing that on page load would spend a
  user's battery on a preview of an empty directory.
- **A failed publish keeps the server.** Only a *start* failure drops the session, so a
  retry after a transient publish error does not pay the cold-start cost again — and the
  previous build stays published, so the pane keeps working instead of going blank.
- **The build id prefers the build manager's.** `BuildResult.id` names the build that
  produced the files; when the caller has none (a preview of "whatever is in `dist` right
  now"), `deriveBuildId()` fingerprints the recursive listing — paths and sizes, sorted.
  Content-hashing every file would double the cost of publishing for a distinction a real
  build rarely needs: Vite renames every asset whose bytes changed, so the listing changes
  too. The consequence is the property the whole design exists for: a new build means a new
  URL, so a page pinned to the old one gets a `409` instead of old bytes.

```ts
const preview = usePreview({ environment, http: environment.guestHttp });
// …in the pane:
<PreviewPane phase={preview.phase} onRefresh={() => preview.refresh()} available={preview.available} />
```

A caller that already knows the build id passes it through — this is what the agent flow
will do once `BuildManager.onBuilt` is wired to the pane:

```ts
preview.refresh(build.id); // `/__preview__/build-mf3k2-1/…`
```
