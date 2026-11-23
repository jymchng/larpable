/**
 * A status you read at a glance: one filled circle, no words.
 *
 * Why a dot and not a badge:
 *
 * - The two places this is used (the terminal's connection state and the dashboard's
 *   runtime-requirement count) sit in dense toolbar rows next to icon buttons. A worded
 *   badge there competes with the controls for attention, and its width changes as the
 *   state changes, so the row jumps.
 * - The *word* is still there for anyone who needs it: `aria-label` is the accessible name
 *   (a screen reader announces "Connected"), and `title` is the tooltip a mouse user gets
 *   after a hover. Nothing is lost — it is just not painted.
 *
 * The colour is the only visual channel, so it is never the *only* channel: a dot whose
 * label is "Failed" is also announced as "Failed". Colour-blind users get the same
 * information from the accessible name and the tooltip.
 *
 * Tones are semantic, not literal, so a theme change moves them together:
 * green = good, amber = in progress / partly good, red = failure, grey = neutral (no
 * shell, exited, not started). A caller that only has a boolean picks `toneFor`.
 */

import { cn } from "@/lib/utils";

export type StatusTone = "green" | "amber" | "red" | "grey";

/** The colour classes, in one place, so two callers cannot drift apart. */
const TONE_CLASS: Record<StatusTone, string> = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-destructive",
  grey: "bg-muted-foreground/60",
};

export interface StatusDotProps {
  /** What the colour means. */
  tone: StatusTone;
  /**
   * The words the dot stands for: the accessible name and the tooltip. Required, because a
   * dot with no label is a decoration, and a status no one can read out loud is not a status.
   */
  label: string;
  /** A test hook for the caller's own assertions (`terminal-status`, `requirements-status`). */
  testId?: string;
  className?: string;
}

export function StatusDot({ tone, label, testId, className }: StatusDotProps) {
  return (
    <span
      // `img` rather than `status`: this is a value the user reads, not a live region that
      // should interrupt a screen reader every time a command finishes.
      role="img"
      aria-label={label}
      title={label}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      data-tone={tone}
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full ring-1 ring-black/25 ring-inset",
        TONE_CLASS[tone],
        className,
      )}
    />
  );
}

/** A boolean in, a tone out — for callers whose state is exactly good or not. */
export function toneFor(ok: boolean, otherwise: StatusTone = "red"): StatusTone {
  return ok ? "green" : otherwise;
}
