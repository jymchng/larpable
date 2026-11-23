/**
 * One pictogram, one action, and a colour that says what kind of action it is.
 *
 * Why this exists instead of `<Button size="sm">Hammer Install & build</Button>`:
 *
 * - These rows (the build strip, the preview toolbar, the terminal's actions, the chat box)
 *   are dense and repeated. A worded button there is read once and then becomes noise; a
 *   hammer in green is recognised without reading, and the row stops re-flowing every time a
 *   label changes from "Install & build" to "Rebuild".
 * - The words are not lost, they are *unpainted*: `aria-label` is the accessible name (a screen
 *   reader announces "Install & build") and `title` is the tooltip a mouse user gets. That is
 *   the same trade the status dots in `status-dot.tsx` make, and for the same reason.
 *
 * Rules this component enforces so a caller cannot get them wrong:
 *
 * - `label` is required and non-optional in the type, so an icon button without a name does
 *   not compile. A dot can be decoration; a *button* cannot be, because it must be focusable
 *   and announced.
 * - The hit target is 32 px on a laptop (`size-8`), which is what a pointer needs in a row of
 *   dense controls, and 44 px below the laptop breakpoint (`max-lg:size-11`), which is what a
 *   thumb needs. Both numbers come from `src/ui/touch.ts`, so a change is one edit and the
 *   browser audit in `scripts/mobile-acceptance.ts` (`bun run acceptance:mobile`) re-measures the rendered rectangles.
 * - The colour is never the only channel: the tone class is decoration over an accessible
 *   name that already carries the meaning, so a colour-blind user loses nothing.
 *
 * Tones are semantic, not literal, so a theme change moves them together:
 * green = run/primary, red = stop/destructive, grey = secondary or reversible, and
 * `nav` = a control that moves the user (browser arrows, tabs, disclosure).
 */

import type { ComponentProps, ReactNode } from "react";

import { Button } from "@/ui/components/button";
import { TOUCH_TARGET_ICON } from "@/ui/touch";
import { cn } from "@/lib/utils";

export type ActionTone = "run" | "stop" | "muted" | "nav";

/** The colour classes, in one place, so two callers cannot drift apart. */
const TONE_CLASS: Record<ActionTone, string> = {
  // A run is the thing the user came for: the green of "go", which the status dots already use
  // for good. In a ghost button the colour is the icon's, with a wash on hover.
  run: "text-success hover:bg-success/10 hover:text-success",
  // Destructive and stop controls are red because they end something. They are never the only
  // way out of a state (cancel is followed by a usable control), so the alarm is proportionate.
  stop: "text-destructive hover:bg-destructive/10 hover:text-destructive",
  // Secondary and reversible: copy, paste, fullscreen, new tab, reset.
  muted: "text-muted-foreground hover:bg-accent hover:text-foreground",
  // Movement, not mutation: browser arrows, tab switching.
  nav: "text-foreground/80 hover:bg-accent hover:text-foreground",
};

export interface IconButtonProps
  extends Omit<ComponentProps<"button">, "aria-label" | "title" | "children"> {
  /** The accessible name and the default tooltip. Required: see the note at the top. */
  label: string;
  /** A longer tooltip, when the label alone would be a riddle. */
  hint?: string;
  tone?: ActionTone;
  /** A test hook, because the label is not stable ("Install & build" becomes "Rebuild"). */
  testId?: string;
  /** The icon. Sized by the button's `[&_svg]:size-4` unless it needs to be smaller. */
  children: ReactNode;
}

export function IconButton({
  label,
  hint,
  tone = "muted",
  testId,
  children,
  className,
  ...props
}: IconButtonProps) {
  return (
    <Button
      // A control inside a form must not submit it unless it is the submit button; the callers
      // that do submit (the chat's send) pass `type` explicitly.
      type="button"
      size="icon"
      variant="ghost"
      aria-label={label}
      title={hint ?? label}
      {...(testId === undefined ? {} : { "data-testid": testId })}
      data-tone={tone}
      className={cn("size-8 shrink-0", TOUCH_TARGET_ICON, TONE_CLASS[tone], className)}
      {...props}
    >
      {children}
    </Button>
  );
}
