/**
 * A message that speaks for itself and then leaves.
 *
 * Why this exists: everything the app used to *announce* was printed in a pane — a build strip
 * above the frame, a status sentence in the toolbar, a line in the header — and every one of
 * those announcements was in the wrong place. A build's install step takes minutes inside the
 * guest, and its strip lives in the preview pane, which on a phone may not be the pane on
 * screen; a boot failure is printed beside the wordmark, four hundred pixels from the button
 * that retried it. A notification about something that just happened should follow the user, not
 * the layout, so it is a toast: one line, over everything, gone in five seconds, dismissible now
 * (user request: "ALL NOTIFICATIONS SHOULD BE TOASTS IN APPROPRIATE COLORS").
 *
 * The rules, and why each is a rule rather than a preference:
 *
 * - **A toast is data, not a React node.** `Toast` is a plain object with an id, a sentence, a
 *   tone and a lifetime, so the decisions — does this replace that, does it expire, what colour
 *   is a failure — are testable without a DOM (`tests/toast.test.ts`) and the component that
 *   paints it is a pure function of its props (`components/toast.tsx`).
 * - **Identity is the id, not the moment.** Raising an id that is already on screen *refreshes*
 *   it in place instead of stacking a second copy: a status the app re-derives on every render
 *   must not produce one toast per render, and a rebuild that starts while the previous notice
 *   is still up must not produce two identical blue boxes.
 * - **An empty message is not a toast.** `raiseToast` refuses one, because a toast is the only
 *   thing on screen that is not in a pane: an empty one is a floating rectangle with a close
 *   button and no reason to exist.
 * - **The tone decides the colour, and the colour is never the only channel.** Each tone carries
 *   its own pictogram in `components/toast.tsx`, so a colour-blind user loses nothing — the same
 *   rule the status dots and the badges already follow.
 */

/**
 * How long a toast stays on screen, in milliseconds, by tone.
 *
 * Five seconds is the request (and the right answer for "something is happening"); a warning and
 * a failure get longer because they are claims the user has to *read* before they leave, and a
 * sentence that vanishes mid-read is worse than no sentence at all.
 */
export const TOAST_TONE_DURATION_MS: Readonly<Record<ToastTone, number>> = {
  info: 5_000,
  success: 5_000,
  warning: 8_000,
  danger: 8_000,
};

/** What a toast is *for*, which decides its colour and its pictogram. */
export type ToastTone = "info" | "success" | "warning" | "danger";

/**
 * The ceiling on how many toasts may stack.
 *
 * There is one toast per source (`id`), and five sources, so this is a backstop rather than a
 * policy: if it is ever hit, the *oldest* goes, because the newest message is the one about the
 * thing that just happened.
 */
export const MAX_TOASTS = 4;

export interface Toast {
  /** Stable identity. Raising a live id refreshes that toast rather than adding a second. */
  id: string;
  /** The sentence, exactly as it will be read. Empty strings are refused by `raiseToast`. */
  message: string;
  tone: ToastTone;
  /** How long it stays, in milliseconds. */
  durationMs: number;
}

/** What a caller asks for. Everything but the identity and the sentence has a default. */
export interface ToastRequest {
  id: string;
  message: string;
  tone?: ToastTone;
  /** Defaults to this tone's entry in `TOAST_TONE_DURATION_MS`. */
  durationMs?: number;
}

/**
 * Add a toast, or refresh the one with the same id.
 *
 * Refreshing keeps the toast's position in the list: a notice that is re-raised should not jump
 * above or below its neighbours just because it happened to be retired later.
 */
export function raiseToast(toasts: readonly Toast[], request: ToastRequest): readonly Toast[] {
  if (request.message.trim().length === 0) return toasts;

  const tone = request.tone ?? "info";
  const toast: Toast = {
    id: request.id,
    message: request.message,
    tone,
    durationMs: request.durationMs ?? TOAST_TONE_DURATION_MS[tone],
  };

  const at = toasts.findIndex((candidate) => candidate.id === toast.id);
  if (at === -1) {
    const next = [...toasts, toast];
    return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
  }
  const next = [...toasts];
  next[at] = toast;
  return next;
}

/**
 * Remove one toast by id.
 *
 * Idempotent, and *not* an error for an unknown id: the close button and the timer race by
 * design, and whichever arrives second must be a no-op rather than a throw or a resurrected
 * toast.
 */
export function dismissToast(toasts: readonly Toast[], id: string): readonly Toast[] {
  return toasts.filter((toast) => toast.id !== id);
}

/**
 * What changed since the last render, for `use-notifications.ts`.
 *
 * A notification is announced when its *signature* (`tone` + sentence) is new for its id. That
 * is what makes a rebuild announce itself again — the sentence is the same, but the source went
 * quiet in between, and `announced` forgets an id the moment its source has nothing to say. It
 * lives here, as a pure function, so the rule is a unit test rather than a code review.
 */
export function newlyAnnounced(
  announced: ReadonlyMap<string, string>,
  current: readonly { id: string; message: string; tone: ToastTone }[],
): { raise: readonly { id: string; message: string; tone: ToastTone }[]; announced: Map<string, string> } {
  const next = new Map<string, string>();
  const raise: { id: string; message: string; tone: ToastTone }[] = [];

  for (const notification of current) {
    const signature = `${notification.tone}:${notification.message}`;
    next.set(notification.id, signature);
    if (announced.get(notification.id) !== signature) raise.push(notification);
  }

  return { raise, announced: next };
}
