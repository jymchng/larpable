# The machine starts itself

The app used to open on `Linux: Not started` and wait for a press on **Boot Linux** inside the
environment card — which, since that card moved behind the `d` glyph, meant opening a popover to
find the thing the page should have been doing already. Now the kernel boots on mount, and the
header says so while it happens.

Everything below is measured, not claimed. The run that produced these numbers is
`bun run acceptance:autoboot` (`scripts/autoboot-acceptance.ts`); its transcript is
`docs/evidence/autoboot-acceptance.txt`.

## What was built

| Piece | File | Why it is a separate thing |
| --- | --- | --- |
| The decision and the latch | `src/ui/autoboot.ts` | Pure functions: `planAutoBoot`, `createAutoBoot`, `bootIndicator`. A Node test can assert every reason to *not* boot without a DOM. |
| The effect | `src/ui/use-autoboot.ts` | Lifetime only: one `attempt()` on mount, status read through a ref at attempt time. |
| The indicator | `src/ui/boot-indicator.tsx` | Draws `bootIndicator()`'s verdict: spinner, error + retry, or nothing. Owns no timer. |
| The wiring | `src/ui/App.tsx`, `src/ui/dashboard.tsx` | `App` calls `useAutoBoot` with `support.ok` and `environment.boot`; the dashboard renders the indicator beside the wordmark from `environment.status`. |
| The retry fix | `src/ui/use-environment.ts` | A boot that threw *after* the adapter existed left it in the ref, so `boot()` returned early and the retry button was a no-op. The failed machine is now torn down (`shutdown()`) before the error is published. |

Three rules, each of which is a bug if it flips:

1. **Once per mount.** Not once per status, and not twice under React 18 `StrictMode` — two
   kernels would race for the same IndexedDB data disk.
2. **Never on a browser that cannot boot.** `support.ok` false ⇒ no attempt, no spinner.
3. **No spinner over a failure.** `ready` means nothing left to wait for; `error` becomes the
   machine's own message plus a retry; `stopped` stays stopped until a person says otherwise.

## The measurements

Chromium, 390 × 844, `http://127.0.0.1:5173` started by the script itself and bound to loopback.
**No click of any kind** is issued after `page.goto`.

```
PASS the spinner appears without a click — aria-label="Starting Linux"
PASS the spinner is named for a screen reader — role="status", aria-label="Starting Linux"
PASS the spinner actually animates — animation-name=spin
PASS the footer says the machine is starting — Linux: Not started
PASS the header does not overflow at 390 px while starting — scrollWidth - clientWidth = 0 px
PASS the machine reaches Ready with no click — 15218 ms from navigation
PASS the spinner is gone once the machine is ready — present=false
PASS the app's own boot duration is published — booted in 9.8 s
PASS one image was read, in ranges with no offset requested twice (no second kernel) — 9 request(s), duplicates: none
PASS an unsupported browser shows no spinner and no boot — spinner=false, footer="Linux: Not started"
PASS an unsupported browser still explains itself — This browser cannot boot Linux / lacks WebAssembly JSPI …
[autoboot] 11/11 checks passed against http://127.0.0.1:5173
```

- **15.2 s** from navigation to `Ready`; the app's own figure (click-to-ready equivalent, from
  `boot()` to the adapter's `ready`) is **9.8 s**. The difference is page load, the 72 MB image
  being streamed in ranges, and the runtime probe — not a second boot.
- **9 requests for `/distros/debian.erofs`** in that run: one plain request plus eight `Range`
  reads. The first version of this check failed on the raw count (`9 !== 1`), which is what led
  to measuring the headers:

  ```
  REQ (none)              RES 200 (no content-range)
  REQ bytes=0-262143      RES 206 bytes 0-262143/72593408
  REQ bytes=262144-4194303 … bytes=25165824-28311551
  ```

  The image is read lazily and in chunks, so the honest probe for "did a second kernel start?" is
  a repeated offset, not the request count. No offset repeats.
- `scrollWidth - clientWidth = 0` at 390 px: the extra header chrome does not create a sideways
  scrollbar.

### On a browser that cannot boot

`/?simulateSupport=no-jspi` (dev only) after three seconds: **no spinner, no boot**, footer
`Linux: Not started`, and the support explanation still lists the missing requirement
("This browser lacks WebAssembly JSPI (WebAssembly.Suspending) …"). The auto-boot does not start
a machine the support probe already knows would fail.

## Screenshots

| File | State |
| --- | --- |
| `docs/evidence/autoboot-spinner-390.png` | the page just after load: spinner beside the wordmark, footer `Linux: Not started` |
| `docs/evidence/autoboot-ready-390.png` | the same page at `Ready`, no spinner |
| `docs/evidence/autoboot-unsupported-390.png` | `?simulateSupport=no-jspi`: no spinner, the requirement problems |

## What this does not claim

- **Every page load now downloads the image.** That is what "start the kernel when the web app
  opens" means; the guest's data disk persists, but the boot itself does not. A reload while the
  machine is ready starts it again. There is no `?autoboot=no` opt-out: an unsupported browser is
  the only case the app refuses, and a shut-down machine stays down until the page is reloaded.
- **The other acceptance scripts still press Boot.** `scripts/browser-acceptance.ts`,
  `scripts/ui-acceptance.ts`, `scripts/mobile-acceptance.ts` and
  `scripts/preview-browser-acceptance.ts` click `[data-testid=boot-button]`, which now lives
  inside the closed diagnostics popover *and* is disabled because the machine is already booting.
  They predate both changes and have not been re-run here; repairing them is tracked separately
  rather than quietly re-baselined.
- **The jsdom hook test is not a browser.** It proves the effect fires once against
  `FakeEnvironment`; the Chromium run above is what proves a real kernel starts once.

## Reproducing

```sh
bun run acceptance:autoboot          # starts its own loopback dev server, 390 × 844
bun run acceptance:autoboot          # against a deployed page:
LARPABLE_ACCEPTANCE_URL=https://larpable.netlify.app bun run acceptance:autoboot
```

Unit-level evidence:

```sh
./node_modules/.bin/vitest run tests/autoboot.test.ts tests/autoboot-hook.test.tsx
```

`tests/autoboot.test.ts` asserts every branch of `planAutoBoot`/`bootIndicator` and that the
component owns no `setTimeout`/`setInterval`; `tests/autoboot-hook.test.tsx` mounts the real
`useEnvironmentBoot` + `useAutoBoot` under `StrictMode` in jsdom (7 tests), including the
failed-boot retry.
