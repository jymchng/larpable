/**
 * The one place the app touches the environment.
 *
 * Booting is an explicit action, not a side effect of rendering: the user asked for a
 * Linux machine, and a page that silently downloads 14 MB and starts a VM on load is a
 * page that lies about what it is doing. The hook therefore exposes `boot()` and the
 * live snapshot the PRD §5.3 state machine reports.
 *
 * Everything the hook holds is derived from the environment (`snapshot()`,
 * `onStatus()`), never invented here — the status bar cannot claim `ready` before the
 * adapter does.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { createBrowserEnvironment } from "@/env/boot";
import type { ExecutionEnvironment, ShellOptions, TerminalSession } from "@/env/execution";
import { runEnvironmentSelfTest, type SelfTestResult } from "@/env/self-test";
import { INITIAL_ENVIRONMENT, type EnvironmentSnapshot } from "@/env/status";

export interface EnvironmentBootState {
  snapshot: EnvironmentSnapshot;
  /** The PRD §5.3 step currently running, e.g. `runtime: Detecting JavaScript runtimes`. */
  stage: string | null;
  /** True while `initialize()` is running. */
  busy: boolean;
  selfTest: SelfTestResult | null;
  selfTestBusy: boolean;
  /** Wall-clock milliseconds from clicking Boot to `ready`, measured; null until ready. */
  bootDurationMs: number | null;
  /** Boot failure text; also present in `snapshot.error`. */
  error: string | null;
  boot: () => void;
  runSelfTest: () => void;
  /**
   * Open a real pty in the guest for the user's terminal. Rejects when the environment
   * is not running: there is no machine to open a shell on.
   */
  openShell: (options?: ShellOptions) => Promise<TerminalSession>;
  shutdown: () => void;
}

export function useEnvironmentBoot(): EnvironmentBootState {
  const [snapshot, setSnapshot] = useState<EnvironmentSnapshot>(INITIAL_ENVIRONMENT);
  const [stage, setStage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selfTest, setSelfTest] = useState<SelfTestResult | null>(null);
  const [selfTestBusy, setSelfTestBusy] = useState(false);
  const [bootDurationMs, setBootDurationMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const environment = useRef<ExecutionEnvironment | null>(null);
  const unsubscribing = useRef<(() => void) | null>(null);
  const starting = useRef(false);

  // A page that navigates away must not keep a Linux kernel alive in a worker.
  useEffect(
    () => () => {
      unsubscribing.current?.();
      void environment.current?.shutdown().catch(() => undefined);
    },
    [],
  );

  const boot = useCallback(() => {
    if (starting.current || environment.current) return;
    starting.current = true;
    setBusy(true);
    setError(null);
    setStage("Creating the Linux machine");
    const startedAt = performance.now();

    void (async () => {
      try {
        const env = await createBrowserEnvironment();
        environment.current = env;
        unsubscribing.current = env.onStatus(setSnapshot);
        setSnapshot(env.snapshot());

        await env.initialize({
          onStage: (step, detail) => setStage(`${step}: ${detail}`),
        });

        setSnapshot(env.snapshot());
        setBootDurationMs(Math.round(performance.now() - startedAt));
        setStage(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        if (environment.current) setSnapshot(environment.current.snapshot());
        setStage(null);
      } finally {
        starting.current = false;
        setBusy(false);
      }
    })();
  }, []);

  const runSelfTest = useCallback(() => {
    const env = environment.current;
    if (!env || selfTestBusy) return;
    setSelfTestBusy(true);
    void (async () => {
      try {
        setSelfTest(await runEnvironmentSelfTest(env));
      } finally {
        setSelfTestBusy(false);
      }
    })();
  }, [selfTestBusy]);

  const openShell = useCallback(async (options?: ShellOptions): Promise<TerminalSession> => {
    const env = environment.current;
    if (!env) throw new Error("The Linux environment is not running. Boot it first.");
    return env.openShell(options);
  }, []);

  const shutdown = useCallback(() => {
    const env = environment.current;
    if (!env) return;
    void (async () => {
      setBusy(true);
      try {
        await env.shutdown();
        setSnapshot(env.snapshot());
      } finally {
        unsubscribing.current?.();
        unsubscribing.current = null;
        environment.current = null;
        setBusy(false);
      }
    })();
  }, []);

  return {
    snapshot,
    stage,
    busy,
    selfTest,
    selfTestBusy,
    bootDurationMs,
    error,
    boot,
    runSelfTest,
    openShell,
    shutdown,
  };
}
