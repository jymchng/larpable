# On a phone

What changes below the laptop breakpoint, what the browser measures, and what is still
unknown. The measured half lives in [`mobile-report.md`](mobile-report.md); this page is the
part a number cannot state.

## One pane at a time

A phone is not a narrow laptop. Two 400-px-tall panes stacked in an 844-px window give the
transcript four lines and the preview a crop of a website, and a user who scrolls to the
preview loses the prompt box. So below Tailwind's `lg` — 1024 px, `STAGE_BREAKPOINT_PX` in
`src/ui/stage.ts` — the app shows **one pane** and puts a two-button switcher above it.

The hiding is one media query in `src/ui/globals.css`, keyed on `data-stage` on `<main>`:

```css
@media (max-width: 1023.98px) {
  [data-stage="agent"] > [data-pane]:not([data-pane="agent"]),
  [data-stage="preview"] > [data-pane]:not([data-pane="preview"]) {
    display: none;
  }
}
```

Three consequences worth knowing:

- **Both panes stay mounted.** The hidden one is `display: none`, not unmounted, so a reply
  keeps streaming while the user reads the preview, and the terminal keeps its shells.
- **It applies before hydration.** The rule is the browser's, so the first frame is already
  correct and the layout cannot disagree with a React render.
- **It degrades.** A browser that ignores the query sees the stacked layout the markup
  describes — usable, not blank.

`?pane=preview` selects the stage a link is about (`stageFromSearch`), which is how a report
or a bug ticket can point at the half it means.

### Landscape: a 196 px pane

At 844 × 390 the header, the switcher and the status bar took 158 of the 390 px, so the panes
were 196 px tall. (That figure was measured when the status bar was still a row under the header;
it is inside the debug popover now — `docs/debug-popover.md` — so the panes have that row back.
The numbers below are still the ones that motivated the scroll rules, because the preview chrome
they describe did not shrink.) — and the preview's chrome (tab strip 29, browser bar 53, device toolbar 55,
publish row 61, build strip 57) came to 255 px before any content. Because `body` is
`overflow: hidden`, that did not scroll: the document grew to 574 px and the frame and its
empty state were clipped below the fold, unreachable.

Two rules fix it, both in the `max-height: 500px` block in `globals.css`: the preview pane
becomes the scroll container (with `min-height: 11rem` under the frame so it is never crushed
to a sliver), and the tab strip steps aside because it only repeats the build name the address
bar already shows. Nothing functional is hidden — publish, install & build, reload, the address
and the device presets are all still there; you scroll the pane instead of losing it.

That is why the acceptance run asserts **both** directions: `scrollWidth <= clientWidth` (a
`min-w` that loses) *and* `scrollHeight <= clientHeight` (a pane that grows the document where
nothing can scroll). The second check is what would have caught the 574 px document.

## The thumb, not the pointer

A 32 px button is comfortable under a mouse and an error under a thumb; WCAG 2.5.5 asks for
44 px. The rule is responsive rather than global: **32 px from `lg` up, 44 px below it**, in
exactly one place — `src/ui/touch.ts`:

| Constant | Class | Used for |
| --- | --- | --- |
| `TOUCH_TARGET_ICON` | `max-lg:size-11` | square controls: icon buttons, terminal keycaps, the new-shell `+` |
| `TOUCH_TARGET_BLOCK` | `max-lg:min-h-11` | controls with words in them: shell tabs, disclosure headers |

The one documented exception is a control that sits *inside a line of text* — the `×` that
closes a shell tab, which would break the tab's 24 px row if it grew — marked `data-inline`
and held to WCAG 2.5.8's 24 px instead. The browser audit enforces both floors by measuring
`getBoundingClientRect()`, not by reading the class names.

## The keyboard, and the visible area

`100dvh` fixed the URL bar and did not fix the keyboard: on iOS the visual viewport shrinks
while `dvh` keeps its height, so the composer ends up under the keyboard exactly when it is
being typed into. `src/ui/use-app-height.ts` reads `window.visualViewport.height` and the
shell sets its height from it — clamped to the layout viewport, and `null` (leave `100dvh`
alone) when there is nothing trustworthy to read. `html` also sets `text-size-adjust: 100%`
so landscape does not inflate the 11 px readouts, and the page sets `overscroll-behavior:
none` so rubber-banding cannot look like a broken guest.

## Booting Linux on a handset

The kernel's requirements do not change with the device; the failure does. `src/ui/mobile.ts`
turns the support report into sentences, and it says different things on purpose:

- **No WebAssembly JSPI.** The requirement itself is `WebAssembly.Suspending`, and the
  desktop wording lives in `src/env/support.ts`: *"use Chrome/Edge 137+,
  Firefox 153+, or Safari 27+"*. On iOS that sentence is wrong advice — every browser there
  is Safari underneath, so Chrome and Firefox on an iPhone are the same engine that just
  failed, and "install Chrome" sends the user to the App Store for it. The `ios` sentence in
  `JSPI_ON_PHONE` says updating iOS is the only fix on that device. On Android, current
  Chrome and Edge (137+) do have JSPI and work; a browser built into another app — a social
  app, a shopping app — usually does not, so the `android` sentence names that case and says
  opening the page in Chrome itself is often the whole fix.
- **About 4 GB of memory or less.** The guest needs most of a gigabyte before it runs
  anything and an `npm install` needs more, so a build can fail out of memory even though the
  kernel booted. The note is printed only when the browser reports a small number; iOS
  reports nothing, and nothing is not "0 GB".
- **A backgrounded tab is suspended.** A suspended guest looks exactly like a hung one, so
  the note asks the user to keep the tab in front — the one habit that keeps a mobile boot
  alive.

### What those notes promise, and what they do not

They are sentences, not switches. `handsetNotes` returns `MobileNote[]`
(`src/ui/mobile.ts`), `src/ui/environment-panel.tsx` renders them in the browser report, and
nothing in the app changes what it does because of them — the boot still runs on the real
`SupportReport` from `src/env/support.ts`.

- **The facts are the browser's.** `detectHandset` (called once in `src/ui/App.tsx`) reads
  `innerWidth`, `navigator.userAgent`, `navigator.deviceMemory` and `(pointer: coarse)`. A
  narrow desktop window therefore gets no iPhone sentence: `isHandset` needs the coarse
  pointer or a phone user agent as well as a width below `STAGE_BREAKPOINT_PX`, because
  telling a resized laptop to update iOS would be a lie.
- **Silence is not a number.** `deviceMemory` is coarse and absent on iOS; missing or
  nonsense both collapse to `null`, so no note ever claims "0 GB", and a device that reports
  8 GB gets no memory sentence at all.
- **They do not promise a boot or a build.** On a handset that passes the support check the
  memory sentence can still appear, and the guest's own out-of-memory message is what reports
  a failed build — the note says exactly that, and the wording is asserted in
  `tests/mobile-stage.test.ts` rather than trusted.
- **They are where they cannot be missed, and cannot block.** They live inside the
  collapsed browser report next to the boot button, not in a toast over the panes, so reading
  them is optional but reaching them is one press.

The boot card itself is not on the phone's main screen: it is inside the browser report
behind the `d`-in-a-circle control beside the wordmark, collapsed by default. Three
requirement rows and a boot button are not what someone who came to build a website needs to
scroll past, and the sheet is absolutely positioned so opening it cannot reflow the panes.

## What is measured, and what is not

`bun run acceptance:mobile` drives Chromium at 390 × 844 and 844 × 390, on a fresh load and
live after a real boot, and writes [`mobile-report.md`](mobile-report.md) plus the two
screenshots in `docs/evidence/`. The report carries the numbers it judged, not just verdicts:
each pass lists `scrollWidth` against `clientWidth`, `scrollHeight` against `clientHeight`, the
widest element right edge against `innerWidth`, and every visible control's measured rectangle
(narrowest first, with the `data-inline` floor called out where it applies). It exits non-zero
unless every check passes. It is honest about being a Chromium measurement on a loopback dev
server, which leaves three gaps:

- **Not Safari.** iOS is the platform whose WebKit version decides whether the kernel boots,
  and this run cannot open it. The `mobile.ts` sentences are the substitute, and they are
  tested as strings, not as behaviour.
- **No soft keyboard.** The `visualViewport` path is covered by `appHeight`'s unit tests and
  a resized window, not by an iOS keyboard shrinking the page.
- **No thumb.** A 44 px rectangle is measurable; whether a keycap at the edge of the screen
  is comfortably reachable one-handed is not. The terminal key row scrolls horizontally when
  the eight keys do not fit, which is the trade this layout makes.
