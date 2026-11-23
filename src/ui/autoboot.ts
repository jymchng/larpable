/**
 * The machine starts itself, and the header says so.
 *
 * The product used to open on `Linux: Not started` and wait for a press. That is a page that
 * has not finished loading dressed as a page that has: the first thing a person sees is an
 * idle machine and an instruction, and the 14 MB image only begins downloading when they
 * obey it. Now the shell boots on mount (user request: "the linux kernel should be started
 * with a spinner when in progress when the webapp is opened").
 *
 * Everything here is a pure function of facts the app already owns, for two reasons:
 *
 * - **Testability.** The suite has no DOM for hooks to run effects in
 *   (`tests/autoboot.test.ts` asserts these rules directly, `tests/autoboot-hook.test.tsx`
 *   mounts the real hook under jsdom), so the *decision* to boot must be readable without a
 *   React tree.
 * - **Honesty.** The indicator is derived from the environment's own status, the stage the
 *   adapter reported and its error text — never from a timer. A spinner that runs on
 *   `setInterval` would keep turning while a failed boot sat behind it, which is the exact
 *   failure this rule set exists to prevent.
 *
 * Three decisions are deliberate and stated as such:
 *
 * 1. **Once per mount, not once per status.** A page boots the machine, and then never
 *    again: a shut-down machine stays down (the user asked for that), and a failed boot
 *    waits for a human to retry. Only a reload starts a machine that was stopped.
 * 2. **Never on a browser that cannot boot.** `support.ok` false means the probe already
 *    knows this will fail; `src/ui/environment-panel.tsx` does not even render a boot button
 *    there. Starting anyway would produce an error the user cannot act on.
 * 3. **The indicator stops on `ready` and on `error`.** Ready needs no chrome, and an error
 *    gets an error surface with the machine's own message plus a retry — not a spinner that
 *    never ends.
 */

import { statusLabel, type EnvironmentStatus } from "@/env/status";

/** Why the shell did or did not start the machine. Named so the hook can be asserted. */
export type AutoBootReason =
  | "started"
  | "unsupported"
  | "already-attempted"
  | "already-running";

export interface AutoBootPlan {
  /** True only for the one attempt that actually calls `boot()`. */
  boot: boolean;
  reason: AutoBootReason;
}

export interface AutoBootInput {
  /** Whether this browser passed the support probe (`SupportReport.ok`). */
  supported: boolean;
  /** The machine's status at the moment of the attempt. */
  status: EnvironmentStatus;
  /** Whether an attempt has already been made during this mount. */
  attempted: boolean;
}

/**
 * The whole decision, as a function of three facts.
 *
 * `already-running` is not only about `ready`: `initializing`, `booting`, `error` and
 * `stopped` all mean an attempt has already happened (the environment only leaves `idle`
 * once something started it), so none of them is a reason to start it again.
 */
export function planAutoBoot({ supported, status, attempted }: AutoBootInput): AutoBootPlan {
  if (!supported) return { boot: false, reason: "unsupported" };
  if (attempted) return { boot: false, reason: "already-attempted" };
  if (status !== "idle") return { boot: false, reason: "already-running" };
  return { boot: true, reason: "started" };
}

export interface AutoBootOptions {
  supported: boolean;
  /** Read at attempt time, so a status that changed since render is respected. */
  statusOf: () => EnvironmentStatus;
  boot: () => void;
}

export interface AutoBoot {
  /** Idempotent: call it as often as React re-runs the effect; it boots at most once. */
  attempt(): AutoBootPlan;
  /** Whether this controller has already made its one attempt. */
  readonly attempted: boolean;
}

/**
 * A latch around `planAutoBoot`.
 *
 * The latch is the guard the effect cannot provide on its own: React 18 `StrictMode`
 * deliberately mounts, unmounts and re-mounts every component in development, so a naive
 * "boot in an effect" runs twice — and two `createKernel` calls would race for the same
 * IndexedDB data disk. `useEnvironmentBoot` refuses a second *boot* too; this refuses a
 * second *attempt*, which is the state the browser test would otherwise never catch.
 *
 * `unsupported` deliberately does not latch: nothing was started, so a later attempt (a
 * support probe re-run after an opt-in flag) is allowed to change its mind.
 */
export function createAutoBoot({ supported, statusOf, boot }: AutoBootOptions): AutoBoot {
  let attempted = false;

  return {
    get attempted() {
      return attempted;
    },
    attempt() {
      const plan = planAutoBoot({ supported, status: statusOf(), attempted });
      if (plan.reason === "started") {
        attempted = true;
        boot();
      } else if (plan.reason !== "unsupported") {
        attempted = true;
      }
      return plan;
    },
  };
}

/** What the header should draw, and the words that make it accessible. */
export type BootIndicator =
  | { kind: "starting"; label: string; detail: string }
  | { kind: "failed"; label: string; detail: string }
  | { kind: "blocked"; label: string; detail: string }
  | { kind: "none" };

export interface BootIndicatorInput {
  status: EnvironmentStatus;
  /** Whether this browser can boot at all. */
  supported: boolean;
  /** True while `createBrowserEnvironment()`/`initialize()` is in flight. */
  busy: boolean;
  /** The stage the adapter last reported, e.g. `runtime: Detecting JavaScript runtimes`. */
  stage: string | null;
  /** The boot's failure text, when it has one. */
  error: string | null;
}

/**
 * The header indicator, derived from real status.
 *
 * The `busy && idle` branch is not a fudge: `boot()` sets `busy` while it awaits
 * `createBrowserEnvironment()`, and the adapter cannot report `initializing` until there is
 * an adapter — so for those few hundred milliseconds the truthful reading is "starting",
 * from `busy` (real state), not from a stopwatch.
 *
 * A stopped machine is `none`: it is not busy, not failed, and purposefully off.
 */
export function bootIndicator({
  status,
  supported,
  busy,
  stage,
  error,
}: BootIndicatorInput): BootIndicator {
  if (!supported) {
    return {
      kind: "blocked",
      label: "Linux cannot start in this browser",
      detail: "Open the browser report (the d beside the wordmark) to see which requirement is missing.",
    };
  }

  if (status === "error") {
    return {
      kind: "failed",
      label: "Linux failed to start",
      detail: error ?? "The machine reported an error. Open the browser report for its message.",
    };
  }

  // A failure that has an error to show is a failure even if the adapter has not flipped its
  // own status yet: `boot()` catches the exception and publishes it here first.
  if (error !== null) {
    return { kind: "failed", label: "Linux failed to start", detail: error };
  }

  if (status === "initializing" || status === "booting") {
    return { kind: "starting", label: "Starting Linux", detail: stage ?? statusLabel(status) };
  }

  if (busy && status === "idle") {
    return { kind: "starting", label: "Starting Linux", detail: stage ?? "Preparing the machine" };
  }

  return { kind: "none" };
}
