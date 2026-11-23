/**
 * The preview, as the app sees it: a phase in React state and one control.
 *
 * All the decisions live in `src/preview/controller.ts`, which is plain TypeScript so the
 * browser acceptance run can drive the same object this hook does. This file is the binding:
 * it owns the controller's lifetime (created when the guest becomes usable, stopped when it
 * goes away) and turns phase changes into renders.
 *
 * The environment is passed as a value rather than reached for, because a preview may only
 * exist while a machine does: before boot there is nothing to serve, and after shutdown a
 * stale controller would be talking to a stopped kernel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExecutionEnvironment } from "@/env/execution";
import type { GuestHttpFetch } from "@/env/unkernel-kernel";
import { createPreviewController, type PreviewPhase } from "@/preview/controller";

export interface UsePreviewOptions {
  /** The booted machine, or null. */
  environment: ExecutionEnvironment | null;
  /** HTTP into the guest's loopback; null when there is none. */
  http: () => GuestHttpFetch | null;
  /** Guest port for the preview server. Default: the product's default. */
  port?: number;
  /** Publish directory, workspace-relative. Default `dist`. */
  root?: string;
}

export interface PreviewControl {
  /** The controller's phase, for the pane to render. */
  phase: PreviewPhase;
  /** True while the guest's server is starting or a build is being read. */
  busy: boolean;
  /** True when a preview can be requested at all (a ready machine). */
  available: boolean;
  /**
   * Publish the current build. `buildId` is the id the build manager assigned, when the
   * caller has one; otherwise the controller fingerprints the publish directory.
   */
  refresh: (buildId?: string) => void;
  /** Stop the guest's preview server (called automatically when the machine goes away). */
  stop: () => void;
}

export function usePreview(options: UsePreviewOptions): PreviewControl {
  const { environment, http, port, root } = options;

  const controller = useMemo(() => {
    if (environment === null) return null;
    return createPreviewController({
      environment,
      http,
      ...(port !== undefined ? { port } : {}),
      ...(root !== undefined ? { root } : {}),
    });
  }, [environment, http, port, root]);

  const [phase, setPhase] = useState<PreviewPhase>({ kind: "idle" });

  // The subscription is an effect because it must pair with an unsubscribe: a component
  // that unmounts mid-publish must not keep writing phases into a dead tree.
  useEffect(() => {
    if (controller === null) {
      setPhase({ kind: "idle" });
      return;
    }
    setPhase(controller.phase());
    return controller.subscribe(setPhase);
  }, [controller]);

  // A stopped machine has no server left to stop, but a *replaced* one does: the cleanup
  // runs on every controller change, including the change to a new environment.
  const stopping = useRef<Promise<void> | null>(null);
  useEffect(
    () => () => {
      if (controller === null) return;
      stopping.current = controller.stop().catch(() => undefined);
    },
    [controller],
  );

  const refresh = useCallback(
    (buildId?: string) => {
      if (controller === null) return;
      void controller.refresh(buildId).catch(() => undefined);
    },
    [controller],
  );

  const stop = useCallback(() => {
    void controller?.stop().catch(() => undefined);
  }, [controller]);

  return {
    phase,
    busy: phase.kind === "starting" || phase.kind === "publishing",
    available: environment !== null && environment.status() === "ready",
    refresh,
    stop,
  };
}
