/**
 * Wires `notificationsFor` to `useToast`: one effect, one rule.
 *
 * The rule is "announce a notification when it is *new*", and "new" needs a memory: the app
 * re-derives every notification on every render (that is what deriving from state means), so
 * without one, a build that is still installing would raise a toast on every keystroke somewhere
 * else in the app.
 *
 * What counts as new is `newlyAnnounced`'s decision, and it is deliberately generous in one
 * direction and strict in the other:
 *
 * - A source that **changes its sentence or tone** is news: "installing…" becoming "building…"
 *   is a different message and gets announced.
 * - A source that goes **quiet** is forgotten, so the *same* sentence can be announced again
 *   after a gap. That is what makes a second build announce its install step even though the
 *   first build said exactly the same words.
 *
 * The effect depends on a *signature* — the concatenation of every current notification's id,
 * tone and sentence — rather than on `input`'s object identity. `input` is rebuilt on every
 * render by the caller, and depending on it would run this effect on every render to discover
 * that nothing had changed.
 */

import { useEffect, useRef } from "react";

import { notificationsFor, type NotificationInput } from "@/ui/notifications";
import { newlyAnnounced, type ToastRequest } from "@/ui/toast";

/**
 * Announce every notification that is new, and nothing else.
 *
 * `raise` must be stable (it is, from `useToast`): an unstable callback would re-run this effect
 * and, on the render after a dismissal, re-announce whatever is still true.
 */
export function useNotifications(raise: (request: ToastRequest) => void, input: NotificationInput): void {
  const announced = useRef(new Map<string, string>());
  const current = notificationsFor(input);
  // The stable projection of `current` that the effect listens to. Two renders with the same
  // notifications produce the same string, so the effect does not run.
  const signature = current.map((item) => `${item.id}\u0000${item.tone}\u0000${item.message}`).join("\u0001");

  useEffect(() => {
    const { raise: fresh, announced: next } = newlyAnnounced(announced.current, current);
    announced.current = next;
    for (const notification of fresh) {
      raise({ id: notification.id, message: notification.message, tone: notification.tone });
    }
    // `signature` is `current`, flattened into something React can compare. Everything the loop
    // above reads is in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, raise]);
}
