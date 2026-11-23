/**
 * A bubble pinned to the control that needs it, painted while the pointer is over that control.
 *
 * Why this exists instead of the `title` attribute every `IconButton` still carries: the
 * browser's own tooltip is unstylable, arrives after about a second, cannot wrap to a readable
 * width, is painted in the OS font (so `390 × 844` is not monospaced and its digits shuffle
 * between presets), and leaves on its own schedule. The device toolbar is the one place where a
 * number *is* the claim being made, so the number has to be legible — see
 * `PreviewDeviceToolbar` in `preview-chrome.tsx`, which is this component's only caller today.
 *
 * The contract, in the order a user meets it:
 *
 * 1. **The caller anchors it.** A tooltip is nested inside the trigger's wrapper, which must
 *    carry `TOOLTIP_ANCHOR` (`group/tip relative inline-flex`). The wrapper is what the pointer
 *    hovers and what the bubble is positioned against; the bubble itself is `absolute`, so a
 *    row of controls pays nothing for the tooltips it owns.
 * 2. **It is always in the DOM, hidden by opacity.** `display: none` would take it out of the
 *    accessibility tree, and this bubble is the trigger's *description* — the sentence a screen
 *    reader reads. Painting it and hiding it are therefore two separate mechanisms: opacity and
 *    a 4 % scale for the eye, `pointer-events-none` so it can never eat the press that follows
 *    a hover, and nothing at all for assistive technology.
 * 3. **Hover is not the only way in.** `group-has-[:focus-visible]/tip:` reveals it for a
 *    keyboard user. `focus-visible` rather than `focus-within` because a *mouse* press also
 *    focuses a button, and a bubble that stayed up after every click would be furniture.
 *    `hover:` is likewise gated by Tailwind v4 behind `@media (hover: hover)`, so a phone that
 *    taps the trigger never gets a bubble stuck on top of the frame.
 * 4. **It is the trigger's description, not its name.** The trigger points at it with
 *    `aria-describedby`, so the sentence is announced rather than only painted — and for the
 *    same reason the trigger must drop its native `title` (`hint={null}` on `IconButton`): two
 *    tooltips over one control is one too many.
 *
 * There is no JavaScript state here on purpose. A hover is a CSS pseudo-class, and modelling it
 * in `useState` would add a re-render per pointer move, a hydration mismatch on the first paint,
 * and a component that renders nothing under `renderToStaticMarkup` — which is how this file's
 * tests can prove the bubble exists at all.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type TooltipSide = "top" | "bottom";
export type TooltipAlign = "start" | "center" | "end";

/**
 * The wrapper a `Tooltip` must be nested inside.
 *
 * Exported as one string rather than spelled at each call site, for the same reason
 * `TOUCH_TARGET_BLOCK` is: the two halves of this contract (a `group/tip` ancestor and a bubble
 * that asks for `group-hover/tip`) have to agree exactly, and a typo in either half fails
 * silently — an invisible bubble, or worse, one that never goes away.
 */
export const TOOLTIP_ANCHOR = "group/tip relative inline-flex";

/** Where the bubble sits relative to its anchor. `bottom` is the default: it clears a header. */
const SIDE: Record<TooltipSide, { bubble: string; arrow: string; origin: string }> = {
  bottom: { bubble: "top-full mt-2", arrow: "-top-1 border-l border-t", origin: "origin-top" },
  top: { bubble: "bottom-full mb-2", arrow: "-bottom-1 border-r border-b", origin: "origin-bottom" },
};

/**
 * Which edge of the anchor the bubble lines up with.
 *
 * `start` is the default because it is the only alignment that is safe at both ends of a
 * toolbar: a bubble centred on the left-most button hangs off the left edge of a 390 px pane,
 * and this app's `<body>` is `overflow: hidden`, so the half that hung off would simply not
 * exist. Growing rightwards from the trigger's left edge costs nothing and always fits.
 */
const ALIGN: Record<TooltipAlign, { bubble: string; arrow: string }> = {
  start: { bubble: "left-0", arrow: "left-3" },
  center: { bubble: "left-1/2 -translate-x-1/2", arrow: "left-1/2 -translate-x-1/2" },
  end: { bubble: "right-0", arrow: "right-3" },
};

export interface TooltipProps {
  /** The id the trigger's `aria-describedby` names. */
  id: string;
  side?: TooltipSide;
  align?: TooltipAlign;
  /** A test hook. Defaults to `id`, which is already unique per trigger. */
  testId?: string;
  /** Extra classes for the bubble — a width floor for long sentences, usually. */
  className?: string;
  children: ReactNode;
}

export function Tooltip({
  id,
  side = "bottom",
  align = "start",
  testId,
  className,
  children,
}: TooltipProps): ReactNode {
  const placement = SIDE[side];
  const alignment = ALIGN[align];

  return (
    <div
      id={id}
      role="tooltip"
      data-testid={testId ?? id}
      data-side={side}
      data-align={align}
      className={cn(
        // Position and stacking: above the frame (z-50, the same layer the popovers use),
        // out of the flow, and never in the way of a press.
        "pointer-events-none absolute z-50",
        placement.bubble,
        alignment.bubble,
        // The bubble: the popover surface, so a theme change moves it with every other
        // floating thing; text-left because it is anchored to the *left* of a control but
        // reads as a paragraph.
        "bg-popover text-popover-foreground w-max max-w-[min(17rem,calc(100vw-1.5rem))]",
        "rounded-lg border px-2.5 py-1.5 text-left shadow-lg",
        // The reveal. `scale` and `translate` are separate CSS properties in Tailwind v4, so a
        // centred bubble's `-translate-x-1/2` and this `scale-95` do not overwrite each other.
        "transition-[opacity,scale] duration-150 ease-out will-change-[opacity,scale]",
        placement.origin,
        "scale-95 opacity-0",
        "group-hover/tip:scale-100 group-hover/tip:opacity-100",
        "group-has-[:focus-visible]/tip:scale-100 group-has-[:focus-visible]/tip:opacity-100",
        className,
      )}
    >
      {children}
      {/* The caret: a rotated square sharing the bubble's own border and background, so it is
          invisible against it and reads as the bubble's own point. */}
      <span
        aria-hidden="true"
        className={cn("bg-popover absolute size-2 rotate-45", placement.arrow, alignment.arrow)}
      />
    </div>
  );
}
