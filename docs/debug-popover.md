# The debug popover

The facts about the machine — Linux, runtime, project, build, Netlify, preview, and later the
terminal — used to be a status bar pinned under the header, the browser report was a sheet that
pushed the panes down, and the environment sentence, the app version, a "Kernel can boot" badge
and the green requirements dot were always-visible chrome. All of it is now one popover behind
the `d` beside the wordmark.

Three user requests built it, in order:

1. *"Put all the above in the debug popover, change the debug information into a popover, make it
   more concise."* "The above" was the six facts they quoted:

   ```
   Linux    Ready
   Runtime  node (guest shim)
   Project  /workspace
   Build    build-mwt4z3b1-1
   Netlify  not validated
   Preview  build-mwt4z3b1-1
   ```

2. *"Linux: Ready | Distro: debian | Runtime: node (guest shim) | CPUs: 2 | Memory: 1024 MiB /
   Kernel can boot -> put all these into the debug popover"* — the footer band and the header
   badge.
3. *"put the version v0.1.0 in the debug popover"* and *"put the green dot status in the debug
   popover"* — the last two pieces of always-visible chrome.

Everything below is measured. The run that produced the numbers is `bun run acceptance:debug`
(`scripts/debug-popover-acceptance.ts`); its transcript is
`docs/evidence/debug-popover-acceptance.txt`.

## What changed, and why each piece is where it is

| Piece | File | Why |
| --- | --- | --- |
| The surface | `src/ui/components/popover.tsx` | Already existed for the provider settings: Escape, a press outside, focus in on open, focus back to the trigger. The debug report uses it instead of a second, hand-rolled sheet. |
| The facts | `src/ui/status-bar-view.tsx` | Was a `StatusBar` — a horizontal band of six cells. Is `StatusFacts`: a `<dl>` of label/value rows (seven since the terminal's connection state joined), rendered inside the popover. The derivation (`deriveStatusSegments`) did not change. |
| The sentence and the verdict | `src/ui/dashboard.tsx` (`EnvironmentVerdict`) | The footer band printed `describeEnvironment(environment)` and the header carried a `Kernel can boot` badge. Both are now two labelled `<dt>`/`<dd>` rows — `Environment` and `Support` — at the top of the Status section, in the same shape as the facts list below them. |
| The version | `src/ui/dashboard.tsx` | Moved out of the header into the surface's own footer (`data-testid="app-version"`, e.g. `v0.1.0`), right-aligned above a hairline. |
| The dot | `src/ui/components/status-dot.tsx` | The same component, tone rule and accessible name; it now sits beside `3/3 met` inside the Requirements section instead of beside the `d`. |
| The live region | `src/ui/dashboard.tsx` | One `<span data-testid="environment-summary" aria-live="polite" class="sr-only">` carries the same sentence for a screen reader without occupying layout. It is the only copy of the sentence outside the popover, and the stable selector the acceptance scripts read. |
| The body | `src/ui/dashboard.tsx` | `#diagnostics-body` (a `role="region"` band under the header) is gone. The popover holds Status, Requirements, Linux image and Machine. |
| The boot card | `src/ui/environment-panel.tsx` | Gains `compact`, used only here: no card border, no "Linux environment" title, no paragraph about Debian. The Boot / self-test / Shut down controls, the status badges, the stage, the error and the self-test report are unchanged. |

Three things stay true, and each of them is a test that fails if it flips:

1. **The facts exist once.** `tests/debug-popover.test.tsx` asserts one `status-facts` list, inside
   the dialog, before `</header>` — and that no `status-bar` band is left. In Chromium the same
   check reads `status-facts lists on the page: 1`.
2. **The popover is closed by default and named.** `data-state="closed"` and the `hidden` class
   keep it out of the layout *and* the tab order, while `aria-controls` still resolves because the
   surface is never unmounted. Its name comes from its own visible title (`Debug`), through
   `aria-labelledby`.
3. **The controls are still reachable.** Boot, self-test and Shut down were inside the sheet
   behind the `d`; they are inside the popover behind the same `d`. The acceptance run finds all
   three by `data-testid` *inside* the surface, not anywhere on the page.

## The body, as concisely as it could be said

- **Status** — two rows first, then the facts list:
  - `Environment` — the sentence `describeEnvironment` has always produced, wrapped rather than
    truncated: `Linux: Ready | Distro: debian | Runtime: node (guest shim) | CPUs: 2 |
    Memory: 1024 MiB`. This is the sentence the user asked to move, quoted verbatim from the run.
  - `Support` — the old header badge in words, `Kernel can boot` or `this browser cannot boot the
    kernel`, with the tone as `data-ok="true|false"`. Kept verbatim so a person who learned the
    old wording still gets the same answer to the same question.
  - Then the seven facts, one per line, `label = value`, with the dot's colour as the third
    channel and the full sentence in the row's `title`. The terminal's row says how many shells are
    open and whether the active one is attached; it is the last of the seven because it is about a
    pane, not about the machine's readiness.
- **Requirements** — one line: dot + `3/3 met`, plus the problems (with the support probe's own
  browser-version advice) *only when there are any*. It used to be three tick rows with a
  `supported`/`unsupported` fragment each; the per-check answers are still there, in the line's
  tooltip and the dot's accessible name. The dot beside the count is the one that used to sit in
  the header.
- **Linux image** — one line: the image badge and what the downloader knows about it.
- **Machine** — the compact boot card: status badges, the three controls, the stage, the error,
  the self-test report.
- **The surface's footer** — `v0.1.0`, the version the header used to carry.

## The measurements

Chromium, `http://127.0.0.1:5173` started by the script itself and bound to loopback. The run boots
the machine first (so the facts have real values), then opens the popover the way a person would.

```
PASS the popover is closed on arrival, and hidden rather than unpainted — data-state=closed, display:none=true, facts in DOM=7
PASS the trigger is named, collapsed, and points at the surface — aria-label="Debug: this browser", aria-expanded="false", aria-controls="diagnostics-popover"
PASS the machine reached Ready, so the facts have real values — 4879 ms from navigation
PASS a press on the `d` opens the popover — data-state=open, display:none=false
PASS the surface is a labelled dialog, not an unlabelled box — role="dialog", aria-labelledby="diagnostics-popover-heading", heading="Debug"
PASS focus moves into the surface on open — document.activeElement is the surface: true
PASS every status fact is visible inside the popover — Linux=Ready | Runtime=node (guest shim) | Project=/workspace | Build=none | Netlify=not validated | Preview=none | Terminal=no shell
PASS the facts live only in the popover: no status band is left in the layout — status-facts lists on the page: 1
PASS the Linux fact says what the user saw — Linux=Ready
PASS the Boot, self-test and Shut down controls are inside it — boot=true, self-test=true, shutdown=true
PASS the environment sentence the user quoted is a row inside it — "Linux: Ready | Distro: debian | Runtime: node (guest shim) | CPUs: 2 | Memory: 1024 MiB"
PASS the support verdict is the row below it, with its tone as data — support="Kernel can boot", data-ok="true"
PASS the version and the requirements dot are in the same surface — version="v0.1.0", requirements dot inside=true
PASS no visible footer band is left anywhere in the layout — a <footer> element is on the page: false
PASS the sr-only live region still carries the same sentence for a screen reader — environment-summary="Linux: Ready | Distro: debian | Runtime: node (guest shim) | CPUs: 2 | Memory: 1024 MiB", aria-live="polite", sr-only=true
PASS the popover fits the 390 px viewport with no sideways overflow — scrollWidth - clientWidth = 0 px, rect 38..390 (352 px wide)
PASS the page behind it does not overflow either — scrollWidth - clientWidth = 0 px
PASS Escape closes it and focus returns to the `d` — open=false, focused="diagnostics-toggle"
PASS a press outside closes it — open=false after a press at (200, 700)
PASS at 1440 px the same surface opens with the same facts and no overflow — facts=7, page overflow=0 px, rect 1088..1440

[debug] 20/20 checks passed against http://127.0.0.1:5173
```

Numbers worth keeping:

- **352 px wide at 390 px**, occupying `38..390`: the width is `min(22rem, 100vw - 1rem)` and the
  surface hangs off the *header* (`right-0`), not off the `d` — anchored to the button it would
  have been pushed ~200 px off the left edge.
- **0 px** of sideways overflow, for the popover and for the page, at both 390 px and 1440 px.
- **4.9 s** from navigation to `Ready` in this run (the machine boots itself; see
  `docs/autoboot.md`), which is why the facts read `Ready` rather than `Not started`.
- The sentence in this run: `Linux: Ready | Distro: debian | Runtime: node (guest shim) |
  CPUs: 2 | Memory: 1024 MiB` — byte-for-byte the same string as the `sr-only` live region, which
  is what the check compares. The user's session had a build and a published preview; those values
  come from the same `deriveStatusSegments`, so the rows read `build-mwt4z3b1-1` there. Nothing
  about the shape depends on which build is loaded.

## Screenshots

| File | State |
| --- | --- |
| `docs/evidence/debug-popover-390.png` | 390 × 844, popover open, the Environment/Support rows, seven facts, the boot controls, `v0.1.0` |
| `docs/evidence/debug-popover-desktop.png` | 1440 × 900, the same surface |

## What this does not claim

- **The status facts no longer exist outside the popover.** A person who wants to know whether the
  build passed has to open the `d`; the only always-visible signal is the requirements dot in the
  header, and the header spinner while the machine starts. That is the trade the request asked
  for, and it is why the dot stays.
- **No new build/netlify/preview behaviour.** The popover renders what
  `deriveStatusSegments` already derived; `tests/status-bar.test.ts` is unchanged.
- **`docs/mobile.md`'s 158 px landscape figure predates this change.** It was measured when the
  status bar was still a row under the header; that row is gone, so the panes are taller than the
  figure describes. The scroll rules it justifies are still in force.
- **The debug acceptance is not a screen-reader run.** It reads the same attributes a screen
  reader consumes (`role`, `aria-labelledby`, the rows' text) but no assistive technology was
  driven.

## Reproducing

```sh
bun run acceptance:debug                 # starts its own loopback dev server, 390 × 844
LARPABLE_ACCEPTANCE_URL=https://larpable.netlify.app bun run acceptance:debug
```

Unit-level evidence:

```sh
./node_modules/.bin/vitest run tests/debug-popover.test.tsx tests/status-bar-view.test.tsx
```

`tests/debug-popover.test.tsx` (7 tests) asserts the surface is closed and named, the facts are
inside it and nowhere else, the Boot / self-test / Shut down controls are inside it, and the
requirements line is one line whose detail still names all three checks.
`tests/status-bar-view.test.tsx` (7 tests) asserts the list shape: seven `<dt>`/`<dd>` pairs, the
tones from the source, one accessible name, and truncation instead of widening.
