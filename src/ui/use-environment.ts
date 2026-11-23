/**
 * The one place the app touches the environment.
 *
 * Booting is an action the shell takes once on mount (`useAutoBoot`), not a side effect of
 * rendering a pane: a component that booted in an effect of its own would start a kernel
 * every time it remounted. The hook therefore exposes `boot()` and the live snapshot the PRD
 * §5.3 state machine reports; the decision to call it — once, only on a capable browser, never
 * again after a failure unless a human retries — lives in `src/ui/autoboot.ts`.
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
import type { GuestHttpFetch } from "@/env/unkernel-kernel";

export interface EnvironmentBootState {
  snapshot: EnvironmentSnapshot;
  /**
   * The booted machine, or null before boot — always the `ExecutionEnvironment` interface,
   * never the unkernel adapter, so a caller can only do what the contract allows.
   */
  environment: ExecutionEnvironment | null;
  /**
   * HTTP into the guest's loopback, resolved on every call.
   *
   * A function rather than a value because both of its answers are honest and both change:
   * null before boot, null when the booted kernel exposes no `fetch()`, and a working
   * fetcher once it does. The preview is the only caller: a server inside the machine
   * listens on a port that does not exist on the host.
   */
  guestHttp: () => GuestHttpFetch | null;
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

export interface EnvironmentBootOptions {
  /**
   * The factory the hook boots with. Injected so a test can drive this whole hook under jsdom
   * against `FakeEnvironment` instead of downloading a 72 MB image and starting a kernel
   * (`tests/autoboot-hook.test.tsx` is the caller). Default: `createBrowserEnvironment`.
   */
  createEnvironment?: () => Promise<ExecutionEnvironment>;
}

export function useEnvironmentBoot(
  options: EnvironmentBootOptions = {},
): EnvironmentBootState {
  const createEnvironment = options.createEnvironment ?? createBrowserEnvironment;
  const [snapshot, setSnapshot] = useState<EnvironmentSnapshot>(INITIAL_ENVIRONMENT);
  const [booted, setBooted] = useState<ExecutionEnvironment | null>(null);
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
    setBootDurationMs(null);
    setStage("Creating the Linux machine");
    const startedAt = performance.now();

    void (async () => {
      try {
        const env = await createEnvironment();
        environment.current = env;
        // Published as state, not only as a ref: callers that need the machine itself (the
        // preview) must re-render when it appears, and a ref read during render would not.
        setBooted(env);
        unsubscribing.current = env.onStatus(setSnapshot);
        setSnapshot(env.snapshot());

        await env.initialize({
          onStage: (step, detail) => setStage(`${step}: ${detail}`),
        });

        setSnapshot(env.snapshot());
        setBootDurationMs(Math.round(performance.now() - startedAt));
        setStage(null);
      } catch (cause) {
        // A failed boot must be retryable, and it is not while a half-built machine is still
        // in the ref: `boot()` returns early when `environment.current` is set, which turned
        // the retry button into a no-op for every failure that happened after the adapter
        // existed (an `initialize()` that threw). So the failed machine is torn down here,
        // its last snapshot is kept for the footer, and the next press starts clean.
        const failed = environment.current;
        environment.current = null;
        unsubscribing.current?.();
        unsubscribing.current = null;
        setBooted(null);
        if (failed) {
          setSnapshot(failed.snapshot());
          void failed.shutdown().catch(() => undefined);
        }
        setError(cause instanceof Error ? cause.message : String(cause));
        setStage(null);
      } finally {
        starting.current = false;
        setBusy(false);
      }
    })();
  }, [createEnvironment]);

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

  /**
   * The guest's HTTP door, as a stable callback.
   *
   * Stable on purpose: it is a dependency of the preview controller, which must survive
   * re-renders. Reading the ref (rather than the `booted` state) keeps it correct when the
   * machine is replaced, and `null` stays a real answer either way.
   */
  const guestHttp = useCallback(
    () => environment.current?.guestHttp?.() ?? null,
    [],
  );

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
        setBooted(null);
        setBusy(false);
      }
    })();
  }, []);

  return {
    snapshot,
    environment: booted,
    guestHttp,
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
