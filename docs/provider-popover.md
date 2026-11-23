# The provider popover

Provider, model and API key used to sit in a band above the conversation, toggled by the cog in
the Agent pane's heading row. It is now a popover anchored to that cog: same three fields, same
provider choices, but a surface that appears over the conversation instead of pushing the prompt
box down — which mattered most on a phone, where the band was the most expensive vertical space
in the app.

## What it does, and where each part lives

| Behaviour | Where it is implemented | Where it is proven |
| --- | --- | --- |
| Closed by default; the surface stays in the DOM but is hidden (so `aria-controls` resolves) | `src/ui/popover.ts` → `popoverSurface`, used by `src/ui/components/popover.tsx` | `tests/popover.test.ts`, `tests/app.test.tsx` |
| A labelled dialog (`role="dialog"`, `aria-labelledby` → its own visible title) | `src/ui/components/popover.tsx` | `tests/app.test.tsx` |
| The cog opens it; `aria-expanded` carries the state; the name never changes | `src/ui/dashboard.tsx` | `tests/app.test.tsx` |
| Escape closes it and focus returns to the cog | `src/ui/components/popover.tsx` (document `keydown`) | `tests/popover.test.ts` (rule) + Chromium run below |
| A press outside closes it, a press inside or on the cog does not | `src/ui/popover.ts` → `pointerDownDismisses` | `tests/popover.test.ts` + Chromium run below |
| Focus moves into the surface on open | `src/ui/components/popover.tsx` | Chromium run below (`document.activeElement`) |
| Fits a 390 px screen and hangs off the cog | `w-[min(22rem,calc(100vw-1rem))] max-h-[min(70dvh,26rem)]`, `top-full right-0` | Chromium run below (rectangles) |
| The fields are unchanged (provider buttons, model, key, reset) | `src/ui/settings-panel.tsx` | `tests/settings-panel.test.tsx` |

The unit suite has no DOM (every UI test renders with `renderToStaticMarkup`), so the *rules* are
pure functions in `src/ui/popover.ts` and the *event wiring* is a guard test over the component's
source. What no test file can honestly assert is that a real keypress closes a real surface in a
real browser, so that is measured.

## The measurement

`bun run acceptance:popover` — `scripts/popover-acceptance.ts` — opens the app in Chromium at
**390 × 844**, does not boot Linux (the popover is app chrome), and asks the browser for the
answers. Last run, against the loopback dev server (`http://127.0.0.1:5173`):

```
PASS closed by default — aria-expanded=false, data-state=closed, display=none
PASS opens on the trigger, with focus inside — aria-expanded=true, data-state=open, display=block, activeElement=#settings-region
PASS carries the provider, model, key fields and a named close button — provider=true, model=true, key=true, close=true
PASS fits the 390 px viewport — rect 30..382 x 220..561 in 390×844, document overflow 0 px
PASS anchored to the cog — dialog right 382 vs trigger right 382, dialog top 220 vs trigger bottom 216
PASS closes on Escape and returns focus to the trigger — aria-expanded=false, data-state=closed, activeElement=settings-toggle
PASS closes on a press outside — reopened data-state=open → after press data-state=closed, display=none
PASS the cog toggles rather than closes-then-reopens — after two presses: aria-expanded=false, data-state=closed
[popover] 8/8 checks passed at 390×844 against http://127.0.0.1:5173
```

The surface is **352 px wide** inside a 390 px viewport (382 − 30), its right edge is exactly the
cog's right edge, and the document's `scrollWidth - clientWidth` is **0**: the popover does not
create a horizontal scrollbar at phone width.

Screenshot: `docs/evidence/provider-popover-390.png` (taken with the surface open).

## Reproducing

```bash
bun run dev &                 # binds 127.0.0.1 by default (see src/lib/dev-server.ts)
bun run acceptance:popover    # exits non-zero if any check fails
```

Against a deployment instead of the dev server:

```bash
LARPABLE_ACCEPTANCE_URL=https://larpable.netlify.app bun run acceptance:popover
```
