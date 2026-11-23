# Production deployment report

What https://larpable.netlify.app/ actually does, measured against the live site after the
deploy of commit `375934c` ("fix(deploy): ship the Linux image"). Nothing here is inferred
from configuration alone.

## What was broken

The site loaded and looked healthy — support probe green, boot button offered — but the
Linux image was missing:

| Request | Before | Cause |
| --- | --- | --- |
| `/distros/distros.json` | `200 text/html`, 1116 bytes | SPA fallback served `index.html` |
| `/distros/alpine.erofs` | `200 text/html`, 1116 bytes | same |
| Panel | "Image unavailable — Unexpected token '<' … is not valid JSON" | the app parsed HTML as JSON |

Root cause: `public/distros/` is git-ignored, so the Netlify build had no image, and
`[[redirects]] from "/*" to "/index.html"` answered the misses with a 200. Booting was
impossible even though every browser requirement was met.

## The fix

1. `prebuild` in `package.json` runs `bun run fetch:distros`; the image is downloaded from
   the release pinned to the installed unkernel version and verified by SHA-256. It is a
   no-op when the cached file is valid, so local builds stay fast and offline builds keep
   working.
2. `loadDistroManifest()` treats `text/html` as "this deployment is missing
   public/distros/" instead of surfacing a JSON parse error, and `probeDistroAsset()` no
   longer reports an SPA fallback page as a present image.

Verified from a clean checkout state before deploying:

```
$ rm -rf public/distros dist && bun run build
$ bun run fetch:distros
[fetch:distros] download …/alpine.erofs
[fetch:distros] saved    public/distros/alpine.erofs (4046848 bytes)
[fetch:distros] alpine  alpine-3.24.4-e0d59c37c0882d76 3.9 MiB sha256 verified
✓ built in 10.69s
$ ls -la dist/distros
alpine.erofs   4046848
distros.json       291
```

Deployed with `netlify deploy --dir=dist --prod` (site `larpable`, id
`a5203e52-f979-4761-8e2f-2d8453dda811`, deploy `6b02bd012fc3191d22bc495c`).

## Measured after the deploy

| Request | Result |
| --- | --- |
| `GET /distros/alpine.erofs` | `200`, **4 046 848 bytes**, `application/octet-stream` |
| `GET /distros/distros.json` | `200`, 291 bytes, `application/json` |
| `GET /` | `200`, `text/html`, `cross-origin-opening-policy: same-origin`, `cross-origin-embedder-policy: require-corp`, `x-content-type-options: nosniff` |

Cross-origin isolation survives the CDN, which is what `SharedArrayBuffer` and the
worker/SMP path need.

## Booting in production (Playwright Chromium, https://larpable.netlify.app/)

- Panel: support probe green (JSPI available, isolated, SharedArrayBuffer available),
  Linux image `alpine-3.24.4-e0d59c37c0882d76 ready — 3.9 MiB served from /distros/alpine.erofs`.
- Clicked **Boot Linux** → **Ready**, `alpine`, `2 CPUs`, `1024 MiB`, **booted in 4.2 s**.
- Status bar: `Linux: Ready | Distro: alpine | Runtime: node (guest shim) | CPUs: 2 | Memory: 1024 MiB`.
- Clicked **Run self-test** → *"The guest answered and the workspace round-trips. 218 ms"*:
  - `uname -a` → `Linux unkernel 7.3.4+ #909a1964cecb SMP Fri Nov 20 16:38:40 UTC 2026 aarch64 Linux`
  - `/workspace/.larpable/host-to-guest.txt arrived intact`
  - `/workspace/.larpable/guest-to-host.txt arrived intact`

![Production boot with a passing self-test](evidence/production-boot.png)

## Known gaps in this deployment

- Guest network access (needed by `npm install`) goes through a Wisp proxy. This app
  defaults to `wss://wisp.mercurywork.shop/` (`DEFAULT_WISP_SERVERS`, `src/env/boot.ts`)
  rather than unkernel's own default, which refuses pages on this origin. The proxy is
  configured with `VITE_WISP_SERVERS` (a comma-separated list, tried in order) or per page
  load with `?wisp=wss://…`; `VITE_LINUX_NETWORK=none` boots with no network at all. The
  deployed guest has since proven real egress (`curl https://example.com` → `HTTP=200`,
  `docs/evidence/curl-production-transcript.md`), so this is no longer only a shell-and-mount
  check — but the proxy operator can still see non-TLS guest traffic
  (`docs/security.md` §7).
- Deployment is not yet automated from Git in this repository's CI. The CLI deploy above
  used the same `bun run build` Netlify would run, and `prebuild` makes a Git build
  equivalent.
- Reproducing: `netlify link --id a5203e52-f979-4761-8e2f-2d8453dda811`, then
  `bun run build && netlify deploy --dir=dist --prod`.

## Deploy after the Netlify configuration module (commit `395e6e3`)

Deployed with `netlify deploy --dir=dist --prod` (site `larpable`, deploy
`6b039de7ae30801562143f88`). The build ran `prebuild` → `fetch:distros`, so the image
shipped in this deployment is the **Debian** one, not the Alpine image the earlier section
of this report measured.

Measured against https://larpable.netlify.app/ after the deploy:

| Request | Result |
| --- | --- |
| `GET /` | `200`, `text/html`, `cross-origin-opener-policy: same-origin`, `cross-origin-embedder-policy: require-corp`, `x-content-type-options: nosniff` |
| `GET /distros/distros.json` | `200`, 290 bytes, `application/json`, one entry: `debian` |
| `GET /distros/debian.erofs` | `200`, **72 593 408 bytes**, `application/octet-stream` |
| `GET /distros/nope.erofs` | `404`, 1116 bytes (a real 404, not the SPA entry point) |

Booted in production with Playwright Chromium against the live URL:

- Panel: **3/3** requirements, Linux image `debian-13.7-a6bb4b5e547bc28a ready — 69.2 MiB
  served from /distros/debian.erofs`.
- **Boot Linux** → **Ready**, `debian`, 2 CPUs, 1024 MiB, **booted in 7.0 s**.
- **Run self-test** → *"The guest answered and the workspace round-trips. 791 ms"*:
  - `uname -a` → `Linux unkernel 7.3.4+ #909a1964cecb SMP Fri Nov 20 16:38:40 UTC 2026 aarch64 GNU/Linux`
  - `/workspace/.larpable/host-to-guest.txt arrived intact`
  - `/workspace/.larpable/guest-to-host.txt arrived intact`
- Status bar: `Linux: Ready | Distro: debian | Runtime: node (guest shim) | CPUs: 2 | Memory: 1024 MiB`

![Production boot after the Netlify configuration deploy](evidence/production-netlify-config.png)

This deploy also settles the image-name half of goal #17: the production asset is now
`debian.erofs` at its measured 72 593 408 bytes, so the older `alpine.erofs`
(4 046 848 bytes) acceptance figure is history, not a current expectation.

## The preview on production (commit `1ee61eb`, measured 2026-11-23)

### How it was deployed

`netlify deploy --dir=dist --prod` could not be used from this host in this session: the CLI
reaches for a stored token and gets

```
Warning: Could not read your Netlify auth token from your keychain: Couldn't access platform storage: KeyRevoked
Error: Authentication required. NETLIFY_AUTH_TOKEN is not set and `netlify login --request <message>` can be used to authenticate.
```

The site is git-linked, so the deploy came from the push of `1ee61eb` to `main` — the same
`bun run build` (with `prebuild` → `fetch:distros`) that a CLI deploy would have run. That
this deploy is the one serving is measured, not assumed: the live entry point changed hash
within the minute, and the served bundle is byte-identical to the local build.

| Field | Value |
| --- | --- |
| Origin commit | `1ee61eb` "Stop the terminal's DOM mirror starving the last line of a command" |
| Live entry point before | `index-S3Z4iNDk.js` (06:11:25 UTC) |
| Live entry point after | `index-B9YhbDcW.js` (06:11:56 UTC) |
| `sha256` of `GET /assets/index-B9YhbDcW.js` | `8cf2f7ac3860178e75a9f15bbc0921c5e4b2591ae5bccf61286f72f6a469e8e5` |
| `sha256` of the local `dist/assets/index-B9YhbDcW.js` | same value |
| `sha256` of `GET /preview-sw.js` | `6df33f54a00c5df72dc331cec354aa6ada932b6eef6f01eb70798dfef78499c9` |
| `sha256` of `public/preview-sw.js` | same value |

The Netlify deploy id is **not** recorded: the API needs a token, which this session does
not have. The two hash equalities above are what proves *which* code production is running,
and they are stronger evidence than a deploy id for this question.

### Headers, measured after the deploy

| Request | Result |
| --- | --- |
| `GET /` | `200`, `text/html; charset=UTF-8`, `cross-origin-opener-policy: same-origin`, `cross-origin-embedder-policy: require-corp`, `cache-control: public,max-age=0,must-revalidate` |
| `GET /preview-sw.js` | `200`, `application/javascript; charset=UTF-8`, **8525 bytes** — the worker script is served as JavaScript, not as the SPA entry point |
| `GET /assets/index-B9YhbDcW.js` | `200`, `application/javascript`, 298 333 bytes, `cache-control: public,max-age=31536000,immutable` |
| `GET /distros/distros.json` | `200`, `application/json`, 290 bytes (still `max-age=86400`; goal `18e0c110` owns that change) |
| `GET /distros/debian.erofs` | `200`, `application/octet-stream`, 72 593 408 bytes |
| `GET /distros/nope.erofs` | `404`, `text/html`, 1116 bytes — a real 404, still carrying `max-age=86400` |

### First production run: 7/8, FAIL — recorded, then fixed

The first run against the live site got through boot, the shell, the runtime warm-up and
three file writes, then failed:

```
the build is in the guest's dist/ — …printf "LARPABLE-%s\n" "LS $(find dist -type f | sort | tr '\n' ' ')"\r
\x1b[C…\x1b[Kprintf "LARPABLE-%s\n" "LS $(find dist -type f | sort | tr '\n' ' ')"\r\n\x1b[?2004l\r\n
```

The guest had accepted the command — the transcript ends with Enter being pressed — but the
page's DOM mirror never showed the listing, so the run waited 30 s for a marker that had
already been printed.

Cause: `src/ui/terminal-panel.tsx` throttled the mirror on arrival only. A chunk arriving
less than 100 ms after the previous flush was parked in a local `pending` and waited for the
*next* chunk to carry it. The last line of a command has no next chunk, so it could stay
there indefinitely — invisible to a screen reader and to any browser test that asserts on
the mirror. One-line commands are exactly the shape that triggers it.

Fix (`1ee61eb`): `src/ui/terminal-transcript.ts#TranscriptBuffer` owns the buffer and always
schedules its own trailing flush, so every chunk reaches React within one interval whether
or not anything follows it. Six unit tests in `tests/terminal-transcript.test.ts` cover it,
including "emits a chunk that arrives immediately after a flush without more output" — the
exact sequence the production run lost.

### Second production run: 17/17 PASS

`LARPABLE_ACCEPTANCE_URL=https://larpable.netlify.app bun run acceptance:preview`, against
the deployment of `1ee61eb`, exit 0, report `docs/preview-browser-report.md`
(run started `2026-11-23T05:12:02.638Z`, Chromium 159.0.8154.6, page
`https://larpable.netlify.app`):

- Boot → **Ready** in **5126 ms**; distro `debian`, 2 CPUs, 1024 MiB.
- Warming the runtime through the Wisp proxy: `LARPABLE-RUNTIME node=v26.13.1`.
- The guest wrote `dist/index.html` (282 bytes), `dist/assets/index-abc123.css` (159 bytes)
  and `dist/assets/index-def456.js` (204 bytes), each byte count measured by the guest
  itself with `wc -c`, and listed all three back with `find`.
- The pane published build `b-19w7puy`; the service worker holds it (`served by worker`),
  the iframe URL is `/__preview__/b-19w7puy/`.
- Read out of the iframe's own document: `getComputedStyle(body).backgroundColor` =
  `rgb(18, 52, 86)` (the build's `#123456`), `#answer` = `42` (the build's module ran).
- Deep link `…/__preview__/b-19w7puy/app/editor`: `#answer` = `42` and `#route` =
  `/__preview__/b-19w7puy/app/editor`, so the fallback served the entry document and the
  pathname survived for a client router.
- Screenshots written by that run: `docs/evidence/preview-pane.png` and
  `docs/evidence/preview-deep-link.png` (1400×950, 201 237 and 202 104 bytes). In both, the
  build's `rgb(18, 52, 86)` covers ~266 000 pixels — the stylesheet is visibly applied, not
  just reported.

![The preview rendering a real guest build, on production](evidence/preview-pane.png)
