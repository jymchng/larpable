/**
 * A dialog surface anchored to the control that opens it.
 *
 * Why this exists: the provider choices used to be an inline band above the conversation,
 * toggled by the cog in the agent pane's heading row. A band is honest but expensive — on a
 * 360 px screen it pushed the prompt box below the fold to configure something that is set
 * once — and a *panel* that appears over the conversation is what every other tool in this
 * app already does (the diagnostics sheet, the terminal tabs, the preview's device menu).
 *
 * The rules, in the order a user meets them:
 *
 * 1. **Closed by default, and never unmounted.** The surface is always in the DOM, hidden by a
 *    class when closed, so the trigger's `aria-controls` names something that exists and the
 *    fields keep their values across a close. `hidden` is what takes it out of the layout *and*
 *    out of the tab order, so a closed popover cannot be tabbed into.
 * 2. **It is a labelled dialog** (`role="dialog"`, `aria-labelledby` → its own visible title),
 *    and the trigger's accessible name is the same words. A name that appears twice in the
 *    same place is a name a screen reader reads twice, so the title is the one source.
 * 3. **Focus moves in on open and comes back on close.** Opening focuses the surface itself
 *    (`tabIndex={-1}`): a screen reader then announces "Provider settings, dialog" instead of
 *    dropping the user at the top of the page, and the first Tab reaches the close button.
 *    Escape and the close button move focus back to the trigger, because a keyboard user who
 *    dismissed the surface should not have to tab from the top of the document to get where
 *    they were. A press *outside* deliberately does not: the press has already focused
 *    whatever was pressed, and pulling focus back to the trigger would fight it.
 * 4. **Escape and a press outside both close.** The listeners are on `document`, because both
 *    events happen outside the surface by definition. `pointerdown` — not `click` — is the
 *    dismissal signal, so the panel is gone before the press lands on whatever is underneath.
 *    A press on the *anchor* (the wrapper holding the trigger and this surface) is not a
 *    dismissal, or the trigger's `click` would reopen what the press just closed.
 *
 * Positioning is the caller's `className`: this component sets the dialog semantics and the
 * dismissal, not where it sits. `top-full right-0` against a `relative` anchor is the pattern
 * the settings popover uses, and `w-[min(22rem,calc(100vw-1rem))]` is what keeps it inside a
 * 390 px viewport (measured; see `docs/provider-popover.md`).
 */

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { X } from "lucide-react";

import { IconButton } from "@/ui/components/icon-button";
import { isPopoverDismissKey, pointerDownDismisses, popoverSurface } from "@/ui/popover";
import { cn } from "@/lib/utils";

export interface PopoverProps {
  /** The id the trigger's `aria-controls` names; the heading and close button derive from it. */
  id: string;
  /** The surface's visible title — and, through `aria-labelledby`, its accessible name. */
  title: string;
  open: boolean;
  onClose: () => void;
  /**
   * The element the surface hangs off: the wrapper that holds the trigger *and* this surface.
   * A press inside it is not a dismissal, and focus returns to the first button in it (the
   * trigger) when the surface closes from the keyboard or the close button.
   */
  anchorRef: RefObject<HTMLElement | null>;
  /** Where it sits. The caller owns the geometry; the semantics live here. */
  className?: string;
  children: ReactNode;
}

export function Popover({
  id,
  title,
  open,
  onClose,
  anchorRef,
  className,
  children,
}: PopoverProps): ReactNode {
  const surface = useRef<HTMLDivElement | null>(null);
  const headingId = `${id}-heading`;
  const visibility = popoverSurface(open);

  // Focus in on open. The surface is focused rather than its first control because that control
  // is the close button: an Enter aimed at the dialog should not dismiss the thing the user
  // just opened.
  useEffect(() => {
    if (!open) return;
    surface.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const restoreFocus = () => {
      anchorRef.current?.querySelector<HTMLElement>("button")?.focus();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPopoverDismissKey(event.key)) return;
      // Focus first, then close: the surface is still painted when `focus()` runs, so the
      // browser does not move focus to <body> on the way out.
      restoreFocus();
      onClose();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const dismisses = pointerDownDismisses({
        panel: surface.current?.contains(target) === true,
        anchor: anchorRef.current?.contains(target) === true,
      });
      if (!dismisses) return;
      // No focus restore here: the press has already chosen where focus goes.
      onClose();
    };

    document.addEventListener("keydown", onKeyDown);
    // Capture, so the dismissal happens on the way down rather than after whatever the press
    // started (a drag, a text selection, a button's own handler).
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onClose, anchorRef]);

  return (
    <div
      ref={surface}
      id={id}
      role="dialog"
      aria-labelledby={headingId}
      // Not modal: the conversation behind it stays readable and usable, and nothing is
      // trapped. Stated rather than implied, because `role="dialog"` defaults to modal in
      // some assistive technology heuristics.
      aria-modal="false"
      tabIndex={-1}
      data-state={visibility.state}
      className={cn(
        "bg-popover text-popover-foreground absolute top-full right-0 z-50 mt-1",
        // Bounded in both axes so a phone shows a scrollable sheet instead of a surface that
        // runs off the bottom of the screen, and never wider than the viewport.
        "max-h-[min(70dvh,26rem)] w-[min(22rem,calc(100vw-1rem))] overflow-y-auto",
        "rounded-lg border p-3 shadow-xl outline-none",
        visibility.hidden ? "hidden" : undefined,
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2 border-b pb-1.5">
        <h2
          id={headingId}
          className="text-muted-foreground text-[11px] font-semibold tracking-[0.1em] uppercase"
        >
          {title}
        </h2>
        <IconButton
          testId={`${id}-close`}
          label={`Close ${title.toLowerCase()}`}
          tone="muted"
          onClick={() => {
            // Same reason as Escape: the pressed control is about to be hidden.
            anchorRef.current?.querySelector<HTMLElement>("button")?.focus();
            onClose();
          }}
        >
          <X aria-hidden="true" />
        </IconButton>
      </div>
      {children}
    </div>
  );
}
