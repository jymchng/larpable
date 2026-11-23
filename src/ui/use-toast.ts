/**
 * The toasts on screen, and the clock that takes them away.
 *
 * `src/ui/toast.ts` decides what a toast *is*; this hook owns the two things a pure function
 * cannot: the list, and the timer that removes each entry after its own duration.
 *
 * The rules it keeps:
 *
 * - **Raising is a pure state update.** `raise` only folds a request into the list; the timers
 *   live in an effect that *reconciles* itself with that list. Scheduling inside a state updater
 *   would schedule twice under React 18's `StrictMode` double-invocation, which is the kind of
 *   bug that shows up as a toast vanishing after 2.5 s in development only.
 * - **One timer per toast, and a refresh restarts it.** The reconciliation compares the toast
 *   *object*, not its id: `raiseToast` builds a fresh object when it refreshes an id, so a
 *   re-raised notice gets its full duration instead of the remainder of its predecessor's.
 * - **Dismiss is the same operation as expiry.** Both call the same update, so a toast can never
 *   be gone from the DOM while its timer is still armed, and a timer that fires after a manual
 *   dismissal is a no-op rather than an error.
 * - **Nothing outlives the pane.** Unmounting clears every timer: a tree torn down (a hot reload,
 *   a test) must not leave callbacks that set state on a dead component.
 *
 * Both callbacks are stable, which is what lets `use-notifications.ts` depend on them in an
 * effect without re-raising a toast on every render.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { dismissToast, raiseToast, type Toast, type ToastRequest } from "@/ui/toast";

export interface ToastControl {
  /** Oldest first. The host paints them bottom-up. */
  toasts: readonly Toast[];
  /** Raise a toast, or refresh the toast with the same id and restart its clock. */
  raise: (request: ToastRequest) => void;
  /** Take one down now. Safe on an id that is already gone. */
  dismiss: (id: string) => void;
}

interface Armed {
  handle: ReturnType<typeof setTimeout>;
  /** The exact object the timer was armed for: a refreshed toast is a new object. */
  toast: Toast;
}

export function useToast(): ToastControl {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  // `Map` rather than an object: an id can be any string, and deleting while iterating is safe.
  const timers = useRef<Map<string, Armed>>(new Map());

  const dismiss = useCallback((id: string) => {
    const armed = timers.current.get(id);
    if (armed !== undefined) {
      clearTimeout(armed.handle);
      timers.current.delete(id);
    }
    setToasts((current) => dismissToast(current, id));
  }, []);

  const raise = useCallback((request: ToastRequest) => {
    setToasts((current) => raiseToast(current, request));
  }, []);

  // Reconcile the clocks with the list: arm what is new (or refreshed), disarm what is gone.
  useEffect(() => {
    const armed = timers.current;

    for (const toast of toasts) {
      const existing = armed.get(toast.id);
      if (existing !== undefined && existing.toast === toast) continue;
      if (existing !== undefined) clearTimeout(existing.handle);
      const handle = setTimeout(() => {
        armed.delete(toast.id);
        setToasts((current) => dismissToast(current, toast.id));
      }, toast.durationMs);
      armed.set(toast.id, { handle, toast });
    }

    for (const [id, entry] of armed) {
      if (toasts.some((toast) => toast.id === id)) continue;
      clearTimeout(entry.handle);
      armed.delete(id);
    }
  }, [toasts]);

  useEffect(() => {
    const armed = timers.current;
    return () => {
      for (const entry of armed.values()) clearTimeout(entry.handle);
      armed.clear();
    };
  }, []);

  return { toasts, raise, dismiss };
}
