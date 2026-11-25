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
│  dist/ on port)  │  TCP │ every header       │      │ allow-same-origin    │
└──────────────────┘      │            │       │      └──────────────────────┘
                          │            ▼       │
                          │   preview-sw.js    │
                          │  (holds a snapshot)│
                          └────────────────────┘
```

- **`src/preview/guest-server.ts`** writes a Node script into the guest
  (`.larpable/preview-server.mjs`), starts it on the port the user chose in Settings
  (`5173` by default; `DEFAULT_PREVIEW_PORT` is `8123` when no setting is given) and waits for
  its `LARPABLE-PREVIEW-LISTENING` line. The image has no `python3`, `busybox`, `php` or `ruby`
  (measured — see the comment at the top of that file), so Node is the only runtime
  available, and `RuntimeBootstrap` has already warmed it. The same setting fields the build
  directory the server is rooted at, so a project that emits `build/` does not have to lie
  about `dist/`.
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
sandbox = "allow-scripts allow-forms allow-same-origin";
```

`allow-same-origin` is in that list because of a measurement, not a preference. Chromium does
not hand a sandboxed frame's requests to a service worker unless the frame has an origin that
matches the worker's scope. With `allow-scripts` alone the frame is opaque: the worker
registers and activates, `clients.matchAll()` never lists the frame, and
`/__preview__/<buildId>/` is answered by the dev server — or by Netlify's `/*` redirect in
production — with the app's own `index.html`, which then throws on `indexedDB` in an opaque
origin. The pane went blank. That measurement is why this attribute is here.

Sharing the app's origin has a second consequence. This app is cross-origin isolated, and an
embedded same-origin document without its own `Cross-Origin-Opener-Policy` is refused with
`net::ERR_BLOCKED_BY_RESPONSE`. So a previewed document is served with
`cross-origin-opener-policy: same-origin` **and** `cross-origin-embedder-policy: require-corp`
(COOP alone still failed) plus `cross-origin-resource-policy: cross-origin`.
`PREVIEW_DOCUMENT_HEADERS` in `src/preview/routing.ts` is that decision; it goes out on the
build's HTML and on the plain-text error bodies, which an iframe may equally be showing.

The cost, stated plainly: a previewed site shares this app's origin, so it can read and write
the app's `localStorage` and `indexedDB` (the project list, the conversations), and it can
remove its own `sandbox` attribute. What keeps that from being worse than it sounds: the build
is the user's own project — code their own agent wrote, in a VM that already runs its
`postinstall` scripts — and this app keeps no provider key, token or secret in origin
storage, so a preview has nothing worth taking that the user cannot already see. The genuinely
isolated answer is a separate origin for previews; that is its own piece of work, and stating
the trade is better than hiding it.

Deliberately still absent: `allow-top-navigation`, `allow-popups`, `allow-modals`,
`allow-downloads` — a preview must not be able to leave the app, open a window, freeze it with
`alert()`, or drop a file on the user's disk.

## Documented limits: what a previewed site cannot do

These are consequences of the sandbox and of the origin it shares, not bugs. They are
listed so a user who sees one knows where to look.

| A previewed site cannot… | Why | What the user sees |
| --- | --- | --- |
| load a font, image, stylesheet or frame from a CDN that sends no `Cross-Origin-Resource-Policy` | the preview is cross-origin isolated (`require-corp`) | the asset is blocked in the preview but loads on the deployed site; self-host it or send CORP/CORS from the CDN |
| rely on storage being its *own* | the frame shares the app's origin | a project that writes `localStorage` writes the app's: it survives a reload, but it is not per-project |
| register a service worker outside `/__preview__/` | the preview worker owns that scope | a PWA's offline mode registers, but never controls the app |
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

Storage in a preview is the app's storage, not the site's. Anything a site must keep — a
login, a cart, a draft — belongs on the deployed site, where the origin is its own.

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
| the project's `dev`/`start` facts, and running one | `tests/preview-app-server.test.ts` |
| the hook's ownership of a server it started | `tests/use-preview.test.tsx`, `tests/preview-dev-refresh.test.tsx` |
| a real guest serving a real build | `LARPABLE_GUEST_TESTS=1 bun run test:guest` |

## The pane looks like a browser, and never fakes it

The pane is wrapped in the chrome of a browser — a tab strip, back/forward, a read-only address
bar, a reload, and a device toolbar — because a bare iframe cannot answer "where am I, and can I
go back". A previewed site that routed to `/about` looked identical to its home page, and its
URL was unobtainable.

The imitation is governed by three rules, and each is a test rather than a promise:

- **Nothing is invented.** The address bar shows the path the frame is *actually* on
  (`/__preview__/<buildId>/<path>`), read from `contentWindow.location` and stripped of the
  build prefix by `pathFromFrameUrl()`; a URL that does not belong to this build returns `null`
  and is not written down. Back and forward are `disabled` whenever the pane's own history has
  nowhere to go, which at the start of every build is both of them.
- **The arrows are the pane's, not the window's.** The history in `src/ui/preview-browser.ts`
  lists the paths the frame *visited*; it is not the browser's session history. Pushing entries
  into the app's own history would break the Back button that gets a user out of the preview,
  and driving back/forward through `history.back()` could leave the app entirely.
- **The address follows the frame; the frame does not follow the address.** The address is
  polled every 500 ms and updated on `load`. If the frame's `src` were derived from that value,
  React would rewrite the attribute half a second after an SPA navigated and the browser would
  reload the document — throwing away client-side state and looking like a crash. So the frame's
  URL comes from `PreviewNavigation` ("what we last asked it to load"), which only an explicit
  back/forward/reload/new-build changes.

Reload is a reload, not a repaint: it re-navigates the frame to the path on screen (not the
build's root) *and* asks the controller to re-publish the build id it is showing, so a reload can
never swap in a different build's bytes. The acceptance run asserts the document is new by
setting a property on the old document's `window` and checking it is gone afterwards.

The device toolbar is a device toolbar, not a phone: desktop fills the pane, tablet is 834 × 1112
CSS px, mobile is 390 × 844, and the size it applies is stated — with its limit, sizing only, no
touch events, no device pixel ratio — in the **tooltip of the button that applies it** rather than
in a readout of its own, so the row stays three pictograms wide. `src/ui/viewport.ts` owns those
numbers; `src/ui/components/tooltip.tsx` paints the bubble (CSS-only hover and `:focus-visible`,
never a native `title` on the same control). `src/ui/preview-pane.tsx` no longer prints the build's
progress or a publish's progress in a row either: that is a toast now (`docs/toast.md`), and the
strip above the frame keeps only a failed build's reason.

| File | Job |
| --- | --- |
| `src/ui/preview-browser.ts` | The URLs, the history and the reducer: what a click *does* |
| `src/ui/preview-chrome.tsx` | The tab strip, the navigation bar and the device toolbar |
| `src/ui/preview-frame.tsx` | The sandboxed iframe, the failure surface, the layout |

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
| `idle` | nothing on the status line, and no publish button of its own: the browser bar's reload arrow publishes |
| `starting` | Prod on: `Starting the guest's server for dist/…`. Prod off: `Nothing answers on guest port 5173 yet, so the preview is starting the project's server…`, then the command itself, e.g. `Starting bun run dev in the guest, on port 5173…`. Either way this is a real `node` start, seconds to a minute |
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

## Prod off: the arrow runs the project's own server

With **Prod** off the preview builds nothing. It shows what the project serves *itself* —
Vite, Next, Express, whatever `package.json` names — forwarded request by request out of the
guest (`src/preview/attach.ts`). The bytes are the dev server's, HMR and all, so a source
change shows up the way it does in a terminal.

That used to be a control that could not keep its promise. The reload arrow said "attach to
whatever answers on the port", and on a fresh project nothing answered, so the one button that
offers a preview could only report an empty port. The arrow now **starts** the server:

1. **Probe the port first.** One `GET http://127.0.0.1:<port>/` through the same `http()` door
   every forwarded request uses. *Any* HTTP status means something answers — a `404` from an
   unrelated process is still a listening socket, and duplicating or killing it would be worse
   than showing its answer.
2. **Nothing answers, so start the project.** `readStartScript()` in
   `src/preview/app-server.ts` reads `package.json` from the *project* — not from the publish
   directory — and prefers `scripts.dev`, then `scripts.start`, with the package manager taken
   from the lockfile (`bun run dev`, `pnpm start`, …). `startAppServer()` runs it with `PORT`
   set to the Settings port, so the URL in the address bar is the port the app really listens
   on.
3. **Attach to whatever came up.** The forwarder knocks exactly as before; the start's only job
   was to make something answer.

The two stages are on screen while it happens, because a cold start is seconds to a minute and
a silent wait reads as a broken button.

Three consequences are deliberate:

- **A missing script fails in the project's words.** *No `dev` or `start` script in
  package.json, so the project has nothing to run. Add one — `"dev": "vite"`, for example.*
  A blank script counts as absent.
- **A failed start still knocks.** A server started by hand in the terminal, or one that
  claimed its own port, is attached to even when our start reported `EADDRINUSE`; the probe
  decides, and both sentences are shown rather than one being invented.
- **The controller owns only what it started.** `stop()` kills the session the arrow began —
  before starting a new one, and when the controller is rebuilt (Prod switched on, machine
  replaced). A server that answered the first probe was never ours: it is attached to, never
  killed. A stop that lands mid-start also wins, because `attachTo()` re-reads the controller's
  `generation` after the start returns and stops the session a late start produced, so a pane
  that closed cannot leave a listener behind.

A second press, or a press while a start is still running, attaches instead of starting
another process — the probe answers once the first server is up, and an in-flight run is
shared rather than repeated.
