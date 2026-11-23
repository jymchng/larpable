# The settings popover

Provider, model and API key used to sit in a band above the conversation, toggled by the cog in
the Agent pane's heading row. It is now a popover anchored to that cog: same three fields, one
provider choice, but a surface that appears over the conversation instead of pushing the prompt
box down — which mattered most on a phone, where the band was the most expensive vertical space
in the app.

**One provider choice.** The row offers **Default** and nothing else: it reaches OpenRouter's free
models through this app's own `/api/openrouter`, which adds the deployment's key server-side, so it
needs no account and no key. `demo`, `openai` and `anthropic` are still implemented
(`src/llm/settings.ts`) and a browser that already stored one keeps it — a stored OpenAI key must
not silently become a request to somebody else's API — but nothing offers them, and the panel
paints the choice *in force* even when it no longer offers it rather than hiding the state. The
browser acceptance run seeds the demo provider into `localStorage` for a deterministic
conversation (`scripts/ui-acceptance.ts`).

The surface now holds the two settings that are not about the provider as well: the address the
guest's servers listen on (`http://localhost:` + an editable port, default **5173**) and the
**build directory** a static build is read from (default **dist**). The host is painted and
read-only — the preview reaches the guest through the kernel's own loopback, so `localhost` is the
only host that can answer — and both fields are explained by the sentence under them, which
quotes the settings actually in force rather than the half-typed draft. `src/ui/preview-settings.ts`
holds the rules (a port must be 1–65535, a directory must stay inside the workspace) and
`src/ui/use-preview-settings.ts` persists the pair in `localStorage` beside the provider choice.

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
| The provider fields (one Default button, model, key, reset) | `src/ui/settings-panel.tsx`, `PROVIDER_OPTIONS` in `src/llm/settings.ts` | `tests/settings-panel.test.tsx`, `tests/openrouter-default.test.ts` |
| A read-only `http://localhost` beside an editable port, and a build directory field | `src/ui/settings-panel.tsx` + `src/ui/preview-settings.ts` | `tests/settings-panel.test.tsx`, `tests/preview-settings.test.ts`, Chromium run below |
| One port for both previews; the app's start script is *told* it (`PORT`) | `src/ui/App.tsx`, `src/preview/app-server.ts` | `tests/preview-app-server.test.ts`, `tests/preview-app-preview.test.ts` |

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
PASS shows a read-only localhost with an editable port and build directory — host=http://localhost (readOnly=true), port=5173, directory=dist, note="Both previews start their server inside the guest, on http://localhost:5173, and a static build is read from dist."
PASS a typed port changes the address the panel says the guest serves on — note="Both previews start their server inside the guest, on http://localhost:8080, and a static build is read from dist."
PASS fits the 390 px viewport — rect 32..384 x 45.6..461.6 in 390×844, document overflow 0 px
PASS anchored to the cog — dialog right 384 vs trigger right 384, dialog top 45.6 vs trigger bottom 41.6
PASS closes on Escape and returns focus to the trigger — aria-expanded=false, data-state=closed, activeElement=settings-toggle
PASS closes on a press outside — reopened data-state=open → after press data-state=closed, display=none
PASS closes on the close button and returns focus to the trigger — data-state=closed, display=none, activeElement=settings-toggle
PASS the cog toggles rather than closes-then-reopens — after two presses: aria-expanded=false, data-state=closed
[popover] 11/11 checks passed at 390×844 against http://127.0.0.1:5173
```

The surface is **352 px wide** inside a 390 px viewport (384 − 32), its right edge is exactly the
cog's right edge, and the document's `scrollWidth - clientWidth` is **0**: the popover does not
create a horizontal scrollbar at phone width — the preview row's two fields wrap inside it rather
than widening it.

**One deliberate deviation.** Focus returns to the cog on Escape and on the close button, but not
when the popover is dismissed by a press elsewhere on the page. The press has already moved focus
to whatever was pressed; pulling it back to the cog would undo the user's click. That is the same
rule the WAI-ARIA practices apply to a non-modal popup, and it is stated in the component's
docstring rather than left implicit.

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
