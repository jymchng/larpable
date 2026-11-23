/**
 * The rules a popover obeys, as plain functions.
 *
 * They live here rather than inside `components/popover.tsx` for the reason every other pure
 * helper in `src/ui/` does: the test suite has no DOM (`every UI test renders with
 * renderToStaticMarkup`, see `tests/mobile-layout.test.tsx`), so the decision has to be
 * separable from the event plumbing to be assertable at all. The component is then a thin
 * adapter — it reads the DOM, calls one of these, and closes — and the *behaviour* the user
 * feels (open on click, Escape, click-outside, focus return) is measured in Chromium by
 * `scripts/popover-acceptance.ts` (`bun run acceptance:popover`).
 *
 * Keeping them exported also means there is one answer to each question. "Does this press
 * dismiss?" is asked in exactly one place, so the anchor case below cannot be fixed in the
 * component and forgotten in a second copy.
 */

/** What the surface's `data-state` says and whether `hidden` takes it out of the layout. */
export interface PopoverSurface {
  state: "open" | "closed";
  /** Closed popovers are hidden by a class, not omitted from the DOM: `aria-controls` must
   *  always name an element that exists, and the fields keep their state across a close. */
  hidden: boolean;
}

export function popoverSurface(open: boolean): PopoverSurface {
  return open ? { state: "open", hidden: false } : { state: "closed", hidden: true };
}

/**
 * Whether a key dismisses an open popover.
 *
 * `Escape` is the standard spelling; `Esc` is what old WebKit and a few IMEs still report, and
 * a keydown that closes everything else but not this one is the sort of bug nobody reports
 * because the user simply presses the button instead.
 */
export function isPopoverDismissKey(key: string): boolean {
  return key === "Escape" || key === "Esc";
}

/** Where a pointerdown landed, relative to the popover and to the control it hangs off. */
export interface PointerDownTargets {
  panel: boolean;
  anchor: boolean;
}

/**
 * Whether a pointerdown dismisses the open popover: anything outside both the panel and its
 * anchor.
 *
 * The anchor is excluded on purpose. The trigger's own `click` toggles the popover, so if the
 * press on it also counted as a dismissal the sequence would be *pointerdown closes* →
 * *click reopens*, and the button would appear dead. Presses on the panel are excluded for the
 * obvious reason: a click inside a form is not a request to leave it.
 */
export function pointerDownDismisses(inside: PointerDownTargets): boolean {
  return !inside.panel && !inside.anchor;
}
