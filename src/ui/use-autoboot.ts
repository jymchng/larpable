/**
 * The effect that starts the machine when the page opens.
 *
 * The decision and the latch live in `src/ui/autoboot.ts`; this hook is only lifetime and
 * the ref that keeps the controller from being rebuilt on every render. Keeping it this thin
 * is the point: a hook cannot be asserted in this suite's default Node environment, so the
 * part that could be wrong was moved out of it — and `tests/autoboot-hook.test.tsx` mounts
 * *this* hook under jsdom anyway, to prove the effect really is the thing that boots.
 *
 * `status` is read through a ref at attempt time rather than captured when the controller is
 * created. The effect that runs last wins, so on mount the ref already holds the first
 * render's status — which is `idle` — and a status that changed between render and effect
 * (a snapshot landing early) is still respected.
 */

import { useEffect, useRef } from "react";

import type { EnvironmentStatus } from "@/env/status";
import { createAutoBoot, type AutoBoot } from "@/ui/autoboot";

export interface UseAutoBootOptions {
  /** `SupportReport.ok`: false means this browser cannot boot, so nothing is attempted. */
  supported: boolean;
  status: EnvironmentStatus;
  /** The environment's boot action, from `useEnvironmentBoot`. */
  boot: () => void;
}

export function useAutoBoot({ supported, status, boot }: UseAutoBootOptions): void {
  const statusRef = useRef(status);
  // Kept in an effect rather than assigned during render, because a render may be thrown away
  // and this ref must describe the tree that actually committed. Declared first so it has
  // already run when the attempt below reads it.
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const controller = useRef<AutoBoot | null>(null);
  if (controller.current === null) {
    controller.current = createAutoBoot({
      // `supported` is a fact about the browser, decided once per page load; it cannot change
      // under a mounted shell, so it does not need a ref of its own.
      supported,
      statusOf: () => statusRef.current,
      boot,
    });
  }

  // Mount only. Re-running this on every status change would attempt a boot on each render of
  // a booting machine — harmless because of the latch, but it would also mean the attempt
  // depends on render count, which is exactly the coupling this avoids. The latch and the
  // `status !== idle` rule are what make one call enough.
  useEffect(() => {
    controller.current?.attempt();
  }, []);
}
