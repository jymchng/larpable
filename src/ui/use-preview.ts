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
import type { PreviewPort } from "@/agent/tools/types";
import { createPreviewController, type PreviewPhase } from "@/preview/controller";
import { createPreviewPort } from "@/ui/preview-port";

export interface UsePreviewOptions {
  /** The booted machine, or null. */
  environment: ExecutionEnvironment | null;
  /** HTTP into the guest's loopback; null when there is none. */
  http: () => GuestHttpFetch | null;
  /** Guest port for the preview server, or the port to attach to. Default: the product's. */
  port?: number;
  /** Publish directory, workspace-relative. Default `dist`. */
  root?: string;
  /**
   * The Settings switch: `true` publishes the build, `false` attaches to the user's server.
   *
   * It rebuilds the controller rather than reconfiguring it, because the two modes own different
   * things in the guest — a published build holds a static server, an attach holds a worker
   * forwarder — and a controller that could switch would have to stop one to start the other
   * anyway. Rebuilding is that stop, done by the hook's own cleanup.
   */
  prod?: boolean;
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
  /**
   * Attach the pane to a guest server on `port` — the address bar's `localhost:1234`.
   *
   * Separate from `refresh` because the port is the address bar's, not Settings'.
   */
  attach: (port: number) => void;
  /** Stop the guest's preview server (called automatically when the machine goes away). */
  stop: () => void;
  /**
   * The port the agent's `preview_site` tool receives, or null before the machine exists.
   *
   * It is the *same* controller the pane renders, so a tool's publish moves the pane and the
   * status bar. Two controllers would be two answers to "is the preview up".
   */
  port: PreviewPort | null;
}

export function usePreview(options: UsePreviewOptions): PreviewControl {
  const { environment, http, port, root, prod } = options;

  // The door is read through a ref, so *its identity* is not a dependency of the controller.
  //
  // A caller that passes an inline `() => environment.guestHttp()` — which is the obvious way to
  // write it — produces a new function every render. With `http` in the memo below, that made a new
  // controller every render, whose subscription effect set a fresh phase object, which re-rendered,
  // which made another controller: an endless render loop, i.e. a frozen tab, with no error to read.
  // The controller is rebuilt when the *machine* changes, not when a closure is re-created, and it
  // still calls the newest door.
  const httpRef = useRef(http);
  httpRef.current = http;

  const controller = useMemo(() => {
    if (environment === null) return null;
    return createPreviewController({
      environment,
      http: () => httpRef.current(),
      ...(port !== undefined ? { port } : {}),
      ...(root !== undefined ? { root } : {}),
      ...(prod !== undefined ? { prod } : {}),
    });
  }, [environment, port, root, prod]);

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

  const attach = useCallback(
    (target: number) => {
      if (controller === null) return;
      void controller.attach(target).catch(() => undefined);
    },
    [controller],
  );

  const agentPort = useMemo(() => (controller === null ? null : createPreviewPort(controller)), [controller]);

  return {
    phase,
    busy: phase.kind === "starting" || phase.kind === "publishing",
    available: environment !== null && environment.status() === "ready",
    refresh,
    attach,
    stop,
    port: agentPort,
  };
}
