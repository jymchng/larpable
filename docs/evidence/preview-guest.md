# Evidence: the preview against a real guest

Measured on 2026-11-23, on the Debian image in `public/distros/debian.erofs`, with
`LARPABLE_GUEST_TESTS=1` under the repo-managed Node (`.tooling/node/bin/node`, the only
Node with JSPI on this host).

```sh
LARPABLE_GUEST_TESTS=1 ./.tooling/node/bin/node ./node_modules/vitest/vitest.mjs \
  run tests/guest/preview.guest.test.ts
```

```
 ✓ tests/guest/preview.guest.test.ts (1 test) 50349ms
   ✓ the preview against the real guest > serves a build over HTTP through the kernel,
     with the headers the preview decided 50346ms

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  52.27s
```

## What that test proves

A Vite-shaped fixture build (`index.html`, a hashed module, a stylesheet, a source map, a
nested `docs/index.html`, a PNG) is written into `/workspace/dist` inside the guest. Then,
in one run:

| Step | Assertion |
| --- | --- |
| the guest's server starts | `LARPABLE-PREVIEW-LISTENING` on port 8123, root `/workspace/dist` |
| the manifest lists the build | six files, exact paths, read over the guest's HTTP |
| bytes arrive through the kernel | `kernelPreviewTransport(...).fetch("/index.html")` → 200, body contains `id="root"` |
| a whole build is published | `collectPreviewSnapshot` → snapshot with six files |
| the entry point | `/` → 200 `text/html; charset=utf-8`, `cache-control: no-store` |
| an SPA deep link | `/app/editor/settings` → 200, the entry document |
| a module | `text/javascript; charset=utf-8`, `cache-control: …immutable`, body contains `answer = 42` |
| a source map | `application/json; charset=utf-8`, `cache-control: no-store` |
| a stylesheet | `text/css; charset=utf-8` |
| a binary asset | the PNG's 72 bytes come back equal, `image/png`, correct `content-length` |
| a nested directory | `/docs` → its `index.html`, not the SPA fallback |
| a stale build id | `/__preview__/b-guest-0/…` → 409, and no guest request is made |
| a missing file with no fallback | 404, not the home page |

So the transport (`kernel.fetch` over the guest's loopback), the guest server, the routing
decisions and build-id staleness are proven against a real kernel rather than a table.

## What it does not prove

The iframe does not appear in this run, and neither does the service worker. Both are unit
tested — `tests/preview-frame.test.tsx` asserts the sandbox policy and the URL,
`tests/preview-service-worker.test.ts` asserts the answers — but the browser path (register
the worker, publish the snapshot, point the iframe at `/__preview__/<buildId>/`, see the CSS
and the module load, follow an SPA deep link) has not been run in Chromium against a real
guest build. That is queued as its own goal, and until it runs this file makes no claim
about it.

The fixture is Vite-shaped rather than produced by `vite build` in the same run; the real
build is proven separately by `tests/guest/build.guest.test.ts` (scaffold → `npm install` →
`vite build` → `dist/index.html` with hashed assets), and the preview consumes exactly that
shape.
