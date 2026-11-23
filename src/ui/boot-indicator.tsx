/**
 * The boot indicator beside the wordmark: a spinner while the machine starts, a retry when it
 * failed, and nothing at all when there is nothing to say.
 *
 * It draws `bootIndicator()`'s verdict and nothing else, so the words, the reason and the
 * "is this spinner allowed to turn?" rule live in `src/ui/autoboot.ts` where a Node test can
 * assert them (`tests/autoboot.test.ts`) — the markup is checked separately by
 * `tests/app.test.tsx` and the real animation by `bun run acceptance:autoboot`.
 *
 * Why the failure state is not just a red spinner: a spinner communicates "wait", and a boot
 * that threw is never going to finish waiting. The user gets the machine's own error text and
 * a retry that calls the same `boot()` the environment card's button calls.
 *
 * Size: this sits in the header at 360 px, so the text is `hidden sm:inline` while the icon
 * (and the accessible name, and the full error in `title` and in an `sr-only` span) is
 * always present. The retry control is an `IconButton`, so it keeps the 32 px / 44 px hit
 * targets from `src/ui/touch.ts`.
 */

import { Loader2, RotateCcw, TriangleAlert } from "lucide-react";

import { bootIndicator, type BootIndicatorInput } from "@/ui/autoboot";
import { IconButton } from "@/ui/components/icon-button";

export interface BootIndicatorProps extends BootIndicatorInput {
  /** Retry the boot after a failure. The same action the environment card offers. */
  onRetry: () => void;
}

export function BootIndicator({ onRetry, ...input }: BootIndicatorProps) {
  const state = bootIndicator(input);

  // `none` is ready/stopped/idle, `blocked` is an unsupported browser. In both cases the
  // answer already has an owner elsewhere in the header and footer (the requirements dot, the
  // kernel badge in the footer, the diagnostics sheet), and a fourth signal would be noise.
  if (state.kind === "none" || state.kind === "blocked") return null;

  if (state.kind === "starting") {
    return (
      <span
        // `role="status"` is a polite live region: a screen reader hears the boot start
        // without losing whatever it was reading.
        role="status"
        data-testid="boot-spinner"
        data-state="starting"
        aria-label={state.label}
        title={state.detail}
        className="text-warning inline-flex shrink-0 items-center gap-1.5"
      >
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" data-testid="boot-spinner-icon" />
        <span aria-hidden="true" className="hidden text-[11px] font-medium sm:inline">
          Starting Linux…
        </span>
      </span>
    );
  }

  return (
    <span
      // An error is worth interrupting for: `alert` is assertive, and it is the same promise
      // the environment card's `boot-error` line makes.
      role="alert"
      data-testid="boot-failed"
      data-state="failed"
      className="text-destructive inline-flex min-w-0 shrink-0 items-center gap-1"
    >
      <TriangleAlert aria-hidden="true" className="size-3.5" />
      <span className="hidden text-[11px] font-medium sm:inline">{state.label}</span>
      <span className="sr-only">
        {state.label}: {state.detail}
      </span>
      <span
        className="text-muted-foreground hidden max-w-[14rem] truncate font-mono text-[11px] md:inline"
        title={state.detail}
      >
        {state.detail}
      </span>
      <IconButton
        testId="boot-retry"
        label="Retry starting Linux"
        hint={`Retry starting Linux — ${state.detail}`}
        tone="run"
        onClick={onRetry}
      >
        <RotateCcw aria-hidden="true" />
      </IconButton>
    </span>
  );
}
