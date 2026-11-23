/**
 * The build, as the app drives it: one gated run at a time, and progress published from the
 * manager's own records.
 *
 * The pieces already exist. `src/build/manager.ts` installs and builds inside the guest and
 * keeps every attempt in `history()`; `src/runtime/bootstrap.ts` is the warm-runtime gate that
 * must be paid before the first `npm install` (the guest's `node` is a first-use shim measured
 * at ~147 s); `src/ui/build-state.ts` turns an attempt into the four states the UI renders.
 * What was missing is the object that puts them in order, and that is this file.
 *
 * Why not call the manager directly from the tools and from the pane? Because then the status
 * bar and the pane would have two sources of truth, and one of them would be a guess. Every
 * call goes through here, so "the bar says building" and "a build is running" are the same
 * fact. The three properties worth stating:
 *
 * - **The gate is before the command.** `install`/`build` await `runtime.ensureReady()` first,
 *   with the caller's signal, so a cancelled run does not leave a 147 s download in flight.
 * - **A verdict only comes from an attempt.** `built` is published only for a `BuildResult`
 *   with `ok: true`, and it carries that result's id; a failure publishes the guest's own
 *   detail. Nothing here can turn a failure into a success.
 * - **Cancellation is not a verdict.** A cancelled run restores the status implied by
 *   `history()` — the newest *completed* attempt — instead of reporting a failure that never
 *   happened.
 */

import type { BuildResult, InstallResult } from "@/build/manager";
import type { BuildPort } from "@/agent/tools/types";
import {
  applyBuildProgress,
  buildStatusFromHistory,
  initialBuild,
  summarizeBuildFailure,
  type BuildStatus,
} from "@/ui/build-state";

/** The one method this controller needs from `RuntimeBootstrap`. */
export interface WarmGate {
  ensureReady(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface BuildControllerDeps {
  /** The manager, narrowed to what tools and the pane need. */
  manager: BuildPort;
  /** The warm-runtime gate. Absent means the caller has already paid for the runtime. */
  runtime?: WarmGate | null;
  /** A successful build, so the preview publishes exactly what was built. */
  onBuilt?: (result: BuildResult) => void;
}

export interface BuildController extends BuildPort {
  /** The current status. Always the last value published to subscribers. */
  status(): BuildStatus;
  subscribe(listener: (status: BuildStatus) => void): () => void;
  /** Abort the run in flight. Safe when nothing is running. */
  cancel(): void;
  /** Install, then build — the pane's own control takes the same path as the tools. */
  run(): Promise<BuildStatus>;
  /** True while a run is in flight. */
  busy(): boolean;
}

/** The sentence for a failed install, from the manager's own record. */
function installFailure(result: InstallResult): string {
  const failure = result.failure;
  if (failure === null) return `the install failed without a recorded reason (${result.command})`;
  const detail = failure.detail.trim();
  return detail.length > 0 ? detail : failure.kind;
}

export function createBuildController(deps: BuildControllerDeps): BuildController {
  const { manager, runtime = null } = deps;

  let status: BuildStatus = initialBuild();
  let active: AbortController | null = null;
  const listeners = new Set<(status: BuildStatus) => void>();

  function publish(next: BuildStatus): void {
    status = next;
    for (const listener of listeners) listener(status);
  }

  /**
   * Open a run: one controller for this call, aborted by `cancel()` or by the caller's own
   * signal. The external listener is removed in `end()`, because a long-lived signal (the
   * agent turn's) outlives many builds and would otherwise accumulate listeners.
   */
  function begin(external?: AbortSignal): { signal: AbortSignal; end(): void } {
    const controller = new AbortController();
    active = controller;
    const forward = () => controller.abort();
    if (external !== undefined) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", forward, { once: true });
    }
    return {
      signal: controller.signal,
      end() {
        if (external !== undefined) external.removeEventListener("abort", forward);
        if (active === controller) active = null;
      },
    };
  }

  /**
   * The status a cancelled run leaves behind: whatever the last *completed* attempt was.
   * Before the first attempt that is `none`, which is the truth — nothing finished.
   */
  function restoreFromHistory(): void {
    publish(buildStatusFromHistory(manager.history()));
  }

  async function install(
    options: { signal?: AbortSignal; fallbackToNpm?: boolean } = {},
  ): Promise<InstallResult> {
    const run = begin(options.signal);
    publish(applyBuildProgress(status, { kind: "installing" }));
    try {
      if (runtime !== null) await runtime.ensureReady({ signal: run.signal });
      const result = await manager.install({
        signal: run.signal,
        ...(options.fallbackToNpm === undefined ? {} : { fallbackToNpm: options.fallbackToNpm }),
      });
      if (!result.ok) {
        publish(applyBuildProgress(status, { kind: "failed", summary: installFailure(result) }));
      }
      return result;
    } catch (error) {
      restoreFromHistory();
      throw error;
    } finally {
      run.end();
    }
  }

  async function build(options: { signal?: AbortSignal } = {}): Promise<BuildResult> {
    const run = begin(options.signal);
    publish(applyBuildProgress(status, { kind: "building" }));
    try {
      if (runtime !== null) await runtime.ensureReady({ signal: run.signal });
      const result = await manager.build({ signal: run.signal });
      if (result.ok) {
        publish(
          applyBuildProgress(status, {
            kind: "built",
            id: result.id,
            durationMs: result.durationMs,
          }),
        );
        deps.onBuilt?.(result);
      } else {
        publish(applyBuildProgress(status, { kind: "failed", summary: summarizeBuildFailure(result) }));
      }
      return result;
    } catch (error) {
      restoreFromHistory();
      throw error;
    } finally {
      run.end();
    }
  }

  return {
    /**
     * Forwarded from the manager, not decided here: the controller may gate and publish a
     * run, but only the manager knows which package manager this machine actually installs
     * with (including a measured fallback to npm).
     */
    get packageManager() {
      return manager.packageManager;
    },

    get runtimeNote() {
      return manager.runtimeNote;
    },

    status() {
      return status;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    install,
    build,

    run: async () => {
      try {
        const installed = await install();
        if (!installed.ok) return status;
        await build();
      } catch {
        // The run already published what happened (history for a cancellation, `failed` for a
        // failure). A button click must not leave an unhandled rejection behind.
      }
      return status;
    },

    cancel() {
      const running = active;
      if (running === null) return;
      active = null;
      running.abort();
      restoreFromHistory();
    },

    busy() {
      return active !== null;
    },

    lastSuccessfulBuild() {
      return manager.lastSuccessfulBuild();
    },

    history() {
      return manager.history();
    },
  };
}
