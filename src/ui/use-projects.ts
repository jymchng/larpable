/**
 * Projects, owned by the app rather than by the panel that lists them.
 *
 * `ProjectManager` (src/projects/manager.ts) already knows how to create, open, rename and
 * delete a project, and how to keep the open one saved; `WorkspaceBridge` enforces the
 * `/workspace` boundary; `openProjectStore()` picks IndexedDB when the browser has it and a
 * memory store when it does not. What none of them can do is *exist* — something has to build
 * them, hand them the booted machine, start the autosave watcher and stop it again. That is
 * this hook, and it is the only place in `src/ui/` that imports `src/projects/`.
 *
 * Three decisions worth stating:
 *
 * 1. **Nothing happens before the machine is ready.** A project is files in `/workspace`, and
 *    before boot there is no `/workspace` to read: the bridge would throw on every call. So the
 *    hook reports `unavailable` with the reason, and the panel says so instead of showing an
 *    empty list that looks like "you have no projects".
 * 2. **The manager is rebuilt when the machine changes, not patched.** A rebooted guest is a
 *    different `ExecutionEnvironment`; keeping the old manager would mean a bridge writing into
 *    a dead kernel. The effect is keyed on the environment, and its cleanup calls `stop()`,
 *    which clears the autosave timer and the guest poll.
 * 3. **The store is injectable.** The product uses IndexedDB; a test uses `MemoryProjectStore`
 *    and never touches the browser's database. `persistent` rides along to the panel because a
 *    session-only workspace is a fact the user must be told, not a detail to hide.
 *
 * Action failures are caught here, not thrown at the caller: a name with a slash in it, or a
 * project deleted in another tab, must appear as a sentence in the panel. Throwing from an
 * `onClick` would only reach the console.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ExecutionEnvironment } from "@/env/execution";
import { WorkspaceBridge } from "@/env/fs-bridge";
import { EMPTY_PROJECT_STATE, ProjectManager, type ProjectState } from "@/projects/manager";
import { openProjectStore, type ProjectStore } from "@/projects/store";

/** What the panel renders and what it may ask for. Mirrors `ProjectManager`, plus its own state. */
export interface ProjectsControl {
  state: ProjectState;
  /** True when projects survive a reload (IndexedDB), false for a session-only workspace. */
  persistent: boolean;
  /** Why projects cannot be managed right now, or null when they can. */
  unavailable: string | null;
  /** True while an action the user asked for is still running. */
  busy: boolean;
  /** The last action's failure text, or null. Cleared by the next action. */
  error: string | null;
  create: (name: string) => Promise<void>;
  open: (id: string) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export interface ProjectsOptions {
  /**
   * The booted machine. Null before boot and after a shutdown; the hook then reports
   * `unavailable` and builds nothing.
   */
  environment: ExecutionEnvironment | null;
  /**
   * Where projects are persisted. Injectable so a test can hand in a memory store and assert
   * the wiring without an IndexedDB implementation underneath it.
   */
  openStore?: () => Promise<{ store: ProjectStore; persistent: boolean }>;
  /** Files a new project starts from. Default: the manager's starter tree. */
  starter?: Readonly<Record<string, string>>;
  /** Autosave debounce, passed through. Default 400 ms. */
  autosaveMs?: number;
  /** How often to look for edits made in Linux. Default 1500 ms. */
  pollMs?: number;
}

/** The reason the panel prints when there is no machine to hold a project. */
export const NO_MACHINE_REASON =
  "Projects live in the machine's workspace, so they appear once Linux is ready.";

export function useProjects(options: ProjectsOptions): ProjectsControl {
  const { environment, openStore, starter, autosaveMs, pollMs } = options;

  const [state, setState] = useState<ProjectState>(EMPTY_PROJECT_STATE);
  const [persistent, setPersistent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const managerRef = useRef<ProjectManager | null>(null);

  useEffect(() => {
    if (environment === null) {
      managerRef.current = null;
      setState(EMPTY_PROJECT_STATE);
      return;
    }

    let cancelled = false;
    const bridge = new WorkspaceBridge(environment);
    let manager: ProjectManager | null = null;
    let unsubscribe: (() => void) | null = null;

    void (async () => {
      const opened = await (openStore ?? openProjectStore)();
      if (cancelled) return;
      manager = new ProjectManager({
        bridge,
        store: opened.store,
        ...(starter === undefined ? {} : { starter }),
        ...(autosaveMs === undefined ? {} : { autosaveMs }),
        ...(pollMs === undefined ? {} : { pollMs }),
      });
      unsubscribe = manager.onState((next) => {
        setState(next);
      });
      managerRef.current = manager;
      setPersistent(opened.persistent);
      // `start()` restores the session (adopting the workspace the guest booted with as the
      // first project) and then watches both sides. A failure here is a project that cannot be
      // restored, which the panel must say rather than swallow.
      try {
        await manager.start();
      } catch (cause) {
        if (!cancelled) setError(messageOf(cause));
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      manager?.stop();
      managerRef.current = null;
    };
  }, [environment, openStore, starter, autosaveMs, pollMs]);

  /** Run one user action: busy while it runs, and its failure as a sentence afterwards. */
  const run = useCallback(async (action: (manager: ProjectManager) => Promise<unknown>) => {
    const manager = managerRef.current;
    if (!manager) {
      setError(NO_MACHINE_REASON);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await action(manager);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }, []);

  const create = useCallback(
    (name: string) => run((manager) => manager.create(name)),
    [run],
  );
  const open = useCallback((id: string) => run((manager) => manager.open(id)), [run]);
  const rename = useCallback(
    (id: string, name: string) => run((manager) => manager.rename(id, name)),
    [run],
  );
  const remove = useCallback((id: string) => run((manager) => manager.remove(id)), [run]);

  return {
    state,
    persistent,
    unavailable: environment === null ? NO_MACHINE_REASON : null,
    busy,
    error,
    create,
    open,
    rename,
    remove,
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
