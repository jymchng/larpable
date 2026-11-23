/**
 * The rules behind "the machine starts itself, and the header says so".
 *
 * Three layers, because the app's UI tests render static markup and cannot run an effect:
 *
 * 1. **The decision** — `planAutoBoot` — is a pure function of support, status and whether an
 *    attempt was already made. Every reason it can say no is asserted here, because each one
 *    is a bug if it flips: booting on a browser without JSPI, booting twice under `StrictMode`,
 *    restarting a machine the user shut down, or restarting a failed boot in a loop.
 * 2. **The latch** — `createAutoBoot` — is what makes repeated `attempt()` calls safe, so the
 *    hook can be wired into an effect without counting renders.
 * 3. **The indicator** — `bootIndicator` — is derived from the environment's own status, its
 *    stage text and its error. A spinner that turned on a timer would keep turning over a
 *    failed boot, which is the failure this rule exists to prevent; the guard at the bottom
 *    asserts the component uses no timer at all.
 *
 * What this file cannot claim: that the effect runs in a browser. That is
 * `tests/autoboot-hook.test.tsx` (jsdom, the real hooks) and `bun run acceptance:autoboot`
 * (Chromium, no click, spinner observed, Ready reached) — see `docs/autoboot.md`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { EnvironmentStatus } from "../src/env/status";
import { bootIndicator, createAutoBoot, planAutoBoot } from "../src/ui/autoboot";

const root = resolve(import.meta.dirname, "..");
const appSource = readFileSync(resolve(root, "src/ui/App.tsx"), "utf8");
const indicatorSource = readFileSync(resolve(root, "src/ui/boot-indicator.tsx"), "utf8");
const hookSource = readFileSync(resolve(root, "src/ui/use-autoboot.ts"), "utf8");

describe("planAutoBoot", () => {
  it("starts an idle machine on a capable browser", () => {
    expect(planAutoBoot({ supported: true, status: "idle", attempted: false })).toEqual({
      boot: true,
      reason: "started",
    });
  });

  it("never starts a machine on a browser that cannot boot", () => {
    for (const status of ["idle", "booting", "ready"] as const) {
      expect(planAutoBoot({ supported: false, status, attempted: false })).toEqual({
        boot: false,
        reason: "unsupported",
      });
    }
  });

  it("does not start a machine that is already on its way up, or up", () => {
    for (const status of ["initializing", "booting", "ready"] as const) {
      expect(planAutoBoot({ supported: true, status, attempted: false })).toEqual({
        boot: false,
        reason: "already-running",
      });
    }
  });

  it("does not silently restart a failed or shut-down machine", () => {
    // `error` and `stopped` both mean an attempt already happened: a retry is the user's press,
    // and a shut-down is an instruction.
    for (const status of ["error", "stopped"] as const) {
      expect(planAutoBoot({ supported: true, status, attempted: false })).toEqual({
        boot: false,
        reason: "already-running",
      });
    }
  });

  it("makes at most one attempt per mount", () => {
    expect(planAutoBoot({ supported: true, status: "idle", attempted: true })).toEqual({
      boot: false,
      reason: "already-attempted",
    });
  });
});

describe("createAutoBoot", () => {
  function controller(statuses: EnvironmentStatus[], supported = true) {
    const calls: string[] = [];
    let index = 0;
    const auto = createAutoBoot({
      supported,
      statusOf: () => statuses[Math.min(index, statuses.length - 1)] ?? "idle",
      boot: () => calls.push("boot"),
    });
    return {
      attempt() {
        const plan = auto.attempt();
        index += 1;
        return plan;
      },
      calls,
      auto,
    };
  }

  it("boots once and refuses the repeats a React re-mount would cause", () => {
    const { attempt, calls, auto } = controller(["idle", "idle", "idle"]);

    expect(attempt().reason).toBe("started");
    expect(attempt().reason).toBe("already-attempted");
    expect(attempt().reason).toBe("already-attempted");

    expect(calls).toEqual(["boot"]);
    expect(auto.attempted).toBe(true);
  });

  it("reads the status at attempt time, so a machine that started first is left alone", () => {
    const calls: string[] = [];
    let status: EnvironmentStatus = "ready";
    const auto = createAutoBoot({ supported: true, statusOf: () => status, boot: () => calls.push("boot") });

    expect(auto.attempt()).toEqual({ boot: false, reason: "already-running" });
    status = "idle";
    // The first attempt was made (and refused), so it does not try again later.
    expect(auto.attempt()).toEqual({ boot: false, reason: "already-attempted" });
    expect(calls).toEqual([]);
  });

  it("leaves the latch open when nothing was started, so a later probe can change its mind", () => {
    const calls: string[] = [];
    const auto = createAutoBoot({ supported: false, statusOf: () => "idle", boot: () => calls.push("boot") });

    expect(auto.attempt()).toEqual({ boot: false, reason: "unsupported" });
    expect(auto.attempted).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("bootIndicator", () => {
  const base = { supported: true, busy: false, stage: null, error: null } as const;

  it("turns while the machine is initializing or booting, and says so accessibly", () => {
    for (const status of ["initializing", "booting"] as const) {
      const state = bootIndicator({ ...base, status, stage: "runtime: Detecting runtimes" });
      expect(state).toEqual({
        kind: "starting",
        label: "Starting Linux",
        detail: "runtime: Detecting runtimes",
      });
    }
  });

  it("turns during the window before the adapter exists, because busy is real state", () => {
    expect(bootIndicator({ ...base, status: "idle", busy: true, stage: "Creating the Linux machine" })).toEqual({
      kind: "starting",
      label: "Starting Linux",
      detail: "Creating the Linux machine",
    });
  });

  it("falls back to the status name when no stage has been reported yet", () => {
    expect(bootIndicator({ ...base, status: "booting" })).toMatchObject({ kind: "starting", detail: "Booting" });
    expect(bootIndicator({ ...base, status: "idle", busy: true })).toMatchObject({
      kind: "starting",
      detail: "Preparing the machine",
    });
  });

  it("stops on ready: there is nothing left to wait for", () => {
    expect(bootIndicator({ ...base, status: "ready" })).toEqual({ kind: "none" });
  });

  it("stops on a stopped machine and on an idle one nobody started", () => {
    expect(bootIndicator({ ...base, status: "stopped" })).toEqual({ kind: "none" });
    expect(bootIndicator({ ...base, status: "idle" })).toEqual({ kind: "none" });
  });

  it("becomes the machine's own error text on failure, never a spinner", () => {
    expect(
      bootIndicator({ ...base, status: "error", error: "the kernel worker exited with code 1" }),
    ).toEqual({
      kind: "failed",
      label: "Linux failed to start",
      detail: "the kernel worker exited with code 1",
    });
  });

  it("treats an error with no status flip as a failure too", () => {
    // `boot()` publishes the exception before the adapter can report anything.
    expect(bootIndicator({ ...base, status: "idle", error: "Failed to fetch /distros/debian.erofs" })).toEqual({
      kind: "failed",
      label: "Linux failed to start",
      detail: "Failed to fetch /distros/debian.erofs",
    });
  });

  it("says nothing to wait for on a browser that cannot boot", () => {
    for (const status of ["idle", "booting"] as const) {
      expect(bootIndicator({ ...base, supported: false, status })).toMatchObject({ kind: "blocked" });
    }
  });
});

describe("the shell and the indicator use these rules", () => {
  it("boots from App with the support verdict and the environment's own boot action", () => {
    expect(appSource).toContain("useAutoBoot({");
    expect(appSource).toContain("supported: support.ok");
    expect(appSource).toContain("boot: environment.boot");
    // The indicator is fed the dashboard's snapshot status, not a second copy.
    expect(appSource).toContain("onRetry: environment.boot");
  });

  it("attempts once per mount rather than once per status", () => {
    expect(hookSource).toContain("useEffect(() => {\n    controller.current?.attempt();\n  }, []);");
  });

  it("draws the verdict instead of inventing one, and owns no timer", () => {
    expect(indicatorSource).toContain("bootIndicator(input)");
    expect(indicatorSource).not.toMatch(/\bsetInterval\b/);
    expect(indicatorSource).not.toMatch(/\bsetTimeout\b/);
    // The accessible name is a prop, not the wordmark's neighbourhood.
    expect(indicatorSource).toContain("aria-label={state.label}");
    expect(indicatorSource).toContain('label="Retry starting Linux"');
  });
});
