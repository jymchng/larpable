/**
 * The toasts themselves: a stack of tinted pills at the bottom of the window.
 *
 * Why the design is what it is:
 *
 * - **Bottom centre, over everything.** A notification is about something that just happened, not
 *   about a corner of the layout, so it sits where the eye lands last and where a thumb can reach
 *   it. `fixed` + `z-60` puts it above the panes and above the popovers (which are `z-50`), and
 *   `bottom-[max(...)]` clears the home indicator on a phone.
 * - **The colour is the meaning, and the pictogram repeats it.** Four tones, each with its own
 *   tint, border and glyph: `info` is blue (work in progress), `success` green (it worked),
 *   `warning` amber (read this before it bites), `danger` red (it failed). Nothing is *only* a
 *   colour, which is the same rule the status dots and badges follow.
 * - **The tint, not a solid block.** The app's status surfaces (`badge.tsx`, the environment
 *   panel's warning, the chat's own warning strip) are `bg-tone/15` with `text-tone`, and a toast
 *   that ignored that would look pasted on. A 20 % wash with a 40 % border and full-strength text
 *   reads as the colour in both themes and stays legible over a dark or light pane behind it.
 * - **It is a live region that exists before the news.** The stack container is always mounted and
 *   carries `aria-live="polite"`, because a live region added *together with* its content is
 *   usually not announced at all. The container is `pointer-events-none` so the row cannot eat a
 *   press intended for the pane behind it; each pill turns pointer events back on for its own
 *   close button.
 * - **Every toast is dismissible.** The close control is an `IconButton` — a real button, with an
 *   accessible name ("Dismiss this message"), the 32 px/44 px hit floor from `touch.ts` and the
 *   shell's focus ring — so a user who has read it does not have to wait out the timer, and a
 *   keyboard user can reach it (`pointer-events-auto` on the pill is what makes that possible
 *   inside a `pointer-events-none` stack).
 */

import { CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "@/ui/components/icon-button";
import { type Toast, type ToastTone } from "@/ui/toast";
import { cn } from "@/lib/utils";

/** One tone's paint and pictogram. Two tables rather than one map of objects: they read better. */
const TONE_SURFACE: Record<ToastTone, string> = {
  // Blue: something is happening. The install notice the toasts were built for is this one.
  info: "border-info/40 bg-info/20 text-info",
  success: "border-success/40 bg-success/20 text-success",
  warning: "border-warning/40 bg-warning/20 text-warning",
  danger: "border-destructive/40 bg-destructive/20 text-destructive",
};

const TONE_ICON: Record<ToastTone, ReactNode> = {
  info: <Info aria-hidden="true" className="size-3.5 shrink-0" />,
  success: <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" />,
  warning: <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />,
  danger: <TriangleAlert aria-hidden="true" className="size-3.5 shrink-0" />,
};

export interface ToastHostProps {
  /** Oldest first; the newest is painted closest to the bottom edge. */
  toasts: readonly Toast[];
  onDismiss: (id: string) => void;
}

export function ToastHost({ toasts, onDismiss }: ToastHostProps): ReactNode {
  return (
    <div
      data-testid="toast-host"
      // Always mounted, so the region exists before the first message (see the header).
      aria-live="polite"
      aria-atomic="false"
      aria-label="Notifications"
      className={cn(
        "pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-1.5 px-2",
        "bottom-[max(0.5rem,calc(var(--safe-bottom)+0.5rem))]",
      )}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid={`toast-${toast.id}`}
          data-toast-id={toast.id}
          data-tone={toast.tone}
          className={cn(
            "pointer-events-auto flex max-w-[min(30rem,calc(100vw-1rem))] items-center gap-1.5",
            "rounded-lg border py-0.5 pr-0.5 pl-2 shadow-lg backdrop-blur-md",
            // `tw-animate-css` is imported by `globals.css`; the exit is instantaneous on purpose —
            // a message that lingers to animate itself out is a message that outlives its welcome.
            "animate-in fade-in-0 slide-in-from-bottom-1 duration-150",
            TONE_SURFACE[toast.tone],
          )}
        >
          {TONE_ICON[toast.tone]}
          <p className="min-w-0 flex-1 py-0.5 text-[12px] leading-snug font-medium">
            {toast.message}
          </p>
          <IconButton
            testId={`toast-dismiss-${toast.id}`}
            label="Dismiss this message"
            hint="Close this notification"
            tone="muted"
            onClick={() => {
              onDismiss(toast.id);
            }}
            // Sized on the shell's 32 px floor (`size-8`, from `IconButton`) rather than shrunk to
            // the toast's height: the hit target is what a thumb needs, not what the pill needs.
            // The wash is `foreground/10` because `accent` is grey and would read as a second,
            // grey message inside a coloured one.
            className="hover:bg-foreground/10 shrink-0"
          >
            <X aria-hidden="true" className="size-3.5" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
