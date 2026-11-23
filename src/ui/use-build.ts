/**
 * The build, wired to one booted guest.
 *
 * `src/ui/build-controller.ts` owns the ordering, the gate and the progress. This hook adds
 * only lifetime, and lifetime is where this kind of code goes wrong:
 *
 * - **One controller per machine.** A new guest means a new manager, because the old one's
 *   `history()` describes a filesystem that no longer exists.
 * - **The runtime is constructed with the machine, not per build.** `RuntimeBootstrap` keeps
 *   the warm-up's result; creating it per build would re-pay the shim on every click.
 * - **The preview is refreshed from the build's own id.** `onBuilt` receives the `BuildResult`,
 *   so the pane publishes exactly the bytes that were built (the build-id rule in §12).
 *
 * The factory functions are injectable so a test can drive the whole hook against a stub
 * manager, without a kernel, a runtime download or a 2-minute install.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BuildResult } from "@/build/manager";
import { BuildManager } from "@/build/manager";
import type { ExecutionEnvironment } from "@/env/execution";
import { RuntimeBootstrap } from "@/runtime/bootstrap";
import type { BuildPort } from "@/agent/tools/types";
import { createBuildController, type WarmGate } from "@/ui/build-controller";
import { buildProblem } from "@/ui/availability";
import { initialBuild, type BuildStatus } from "@/ui/build-state";
import { useMachineStatus } from "@/ui/use-environment-status";

export interface UseBuildOptions {
  environment: ExecutionEnvironment | null;
  /** Guest project root. Defaults to the environment's workspace. */
  root?: string;
  /** Called with the successful build, so the preview can publish that build's id. */
  onBuilt?: (result: BuildResult) => void;
  /** Injected in tests: the warm-runtime gate for this machine. */
  createRuntime?: (environment: ExecutionEnvironment) => WarmGate;
  /** Injected in tests: the manager for this machine. */
  createManager?: (environment: ExecutionEnvironment, root: string | undefined) => BuildPort;
}

export interface BuildControl {
  status: BuildStatus;
  /** True while an install or build is in flight. */
  busy: boolean;
  /** Why a build cannot start right now, or null. */
  problem: string | null;
  /** Install, then build. Safe to call when a run is already in flight (it is ignored). */
  run: () => void;
  /** Abort the run in flight. Safe when idle. */
  cancel: () => void;
  /**
   * The port the agent's build tools receive, or null before the machine exists. It is this
   * controller, not the manager: a tool's build must move the same status the bar shows.
   */
  port: BuildPort | null;
}

const defaultRuntime = (environment: ExecutionEnvironment): WarmGate =>
  new RuntimeBootstrap({ environment, persistentDataDisk: true });

const defaultManager = (
  environment: ExecutionEnvironment,
  root: string | undefined,
): BuildPort => new BuildManager({ environment, ...(root === undefined ? {} : { root }) });

export function useBuild(options: UseBuildOptions): BuildControl {
  const { environment, root, onBuilt, createRuntime = defaultRuntime, createManager = defaultManager } = options;

  // The callback is read at call time so a re-render with a new closure does not rebuild the
  // manager (and lose the history the status is derived from).
  const onBuiltRef = useRef(onBuilt);
  onBuiltRef.current = onBuilt;

  const controller = useMemo(() => {
    if (environment === null) return null;
    return createBuildController({
      manager: createManager(environment, root),
      runtime: createRuntime(environment),
      onBuilt: (result) => onBuiltRef.current?.(result),
    });
  }, [environment, root, createManager, createRuntime]);

  const [status, setStatus] = useState<BuildStatus>(initialBuild());

  useEffect(() => {
    if (controller === null) {
      setStatus(initialBuild());
      return;
    }
    setStatus(controller.status());
    return controller.subscribe(setStatus);
  }, [controller]);

  const run = useCallback(() => {
    if (controller === null) return;
    void controller.run().catch(() => undefined);
  }, [controller]);

  const cancel = useCallback(() => {
    controller?.cancel();
  }, [controller]);

  // Subscribed, for the same reason as the chat: a memo over the environment object kept the
  // build button disabled after the guest was ready.
  const machine = useMachineStatus(environment);
  const problem = useMemo(() => buildProblem(machine), [machine]);

  return { status, busy: status.kind === "running", problem, run, cancel, port: controller };
}
