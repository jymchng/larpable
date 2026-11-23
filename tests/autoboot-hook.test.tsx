// @vitest-environment jsdom
/**
 * The auto-boot, driven through the real hooks in a real React tree.
 *
 * `tests/autoboot.test.ts` proves the rules; this file proves the thing the rules were
 * extracted for: that mounting the app's shell calls `boot()` **exactly once**, that React 18's
 * `StrictMode` double-invocation does not turn that into two kernels, that a machine which is
 * already booting or ready is left alone, and that a failed boot can actually be retried.
 *
 * Why jsdom now: the suite's UI tests render static markup, which cannot run an effect — so
 * "the hook boots on mount" was, until this file, a claim about a code path no test executed.
 * `useEnvironmentBoot` takes an injectable factory for exactly this: the test mounts the real
 * hook against `FakeEnvironment`, so there is no 72 MB image and no WebAssembly here, and the
 * browser proof stays where it belongs (`bun run acceptance:autoboot`).
 *
 * The retry test exists because of a bug this work fixed: `boot()` returns early while an
 * environment object is in its ref, so a boot that threw *after* the adapter existed left the
 * machine unrecoverable — the retry button was a no-op. The hook now tears the failed machine
 * down first, and the assertion below fails if that regresses.
 */

import { StrictMode, act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { FakeEnvironment } from "../src/env/fake-environment";
import { useAutoBoot } from "../src/ui/use-autoboot";
import { useEnvironmentBoot } from "../src/ui/use-environment";

// React only uses `act`'s synchronous flushing when it is told it is in a test environment.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount(node: ReactNode): Root {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  return root;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

/** Let every microtask and timer React scheduled inside the tree settle. */
async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface Booted {
  status: string;
  busy: boolean;
  error: string | null;
  stage: string | null;
  boot: () => void;
}

/** A harness that mounts the two real hooks and publishes what they report. */
function Shell({
  createEnvironment,
  seen,
  tick = 0,
}: {
  createEnvironment: () => Promise<FakeEnvironment>;
  seen: { current: Booted | null };
  tick?: number;
}) {
  const environment = useEnvironmentBoot({ createEnvironment });
  useAutoBoot({
    supported: true,
    status: environment.snapshot.status,
    boot: environment.boot,
  });

  // Reading the hook's own state during render, into a plain object: no assertion touches
  // React internals, and a missing value shows up as a failed expectation rather than as a
  // silently skipped branch.
  useEffect(() => {
    seen.current = {
      status: environment.snapshot.status,
      busy: environment.busy,
      error: environment.error,
      stage: environment.stage,
      boot: environment.boot,
    };
  });

  return <p data-testid="status">{`${environment.snapshot.status}${tick > 0 ? `#${String(tick)}` : ""}`}</p>;
}

function fakeFactory(options: { initializeError?: string } = {}) {
  const created: FakeEnvironment[] = [];
  const createEnvironment = (): Promise<FakeEnvironment> => {
    const environment = new FakeEnvironment(options);
    created.push(environment);
    return Promise.resolve(environment);
  };
  return { created, createEnvironment };
}

describe("the app's shell boots the machine on mount", () => {
  it("calls boot exactly once and reaches ready, even under StrictMode", async () => {
    const { created, createEnvironment } = fakeFactory();
    const seen: { current: Booted | null } = { current: null };
    const tree = mount(
      <StrictMode>
        <Shell createEnvironment={createEnvironment} seen={seen} />
      </StrictMode>,
    );

    await act(async () => {
      tree.render(
        <StrictMode>
          <Shell createEnvironment={createEnvironment} seen={seen} />
        </StrictMode>,
      );
    });
    await settle();

    // One machine, one initialize: StrictMode's mount/unmount/mount cycle is absorbed by the
    // latch in `createAutoBoot` and by the "no second boot while one is running" guard in the
    // hook — two kernels would race for the same IndexedDB data disk.
    expect(created).toHaveLength(1);
    expect(created[0]?.calls.filter((call) => call.method === "initialize")).toHaveLength(1);
    expect(seen.current?.status).toBe("ready");
    expect(seen.current?.error).toBeNull();
    expect(container?.textContent).toBe("ready");
  });

  it("does not boot again when an already-ready machine re-renders", async () => {
    const { created, createEnvironment } = fakeFactory();
    const seen: { current: Booted | null } = { current: null };
    const tree = mount(<Shell createEnvironment={createEnvironment} seen={seen} />);
    await act(async () => {
      tree.render(<Shell createEnvironment={createEnvironment} seen={seen} />);
    });
    await settle();
    expect(seen.current?.status).toBe("ready");

    // A re-render (a new stage, a new snapshot, a keystroke) must not touch the machine.
    await act(async () => {
      tree.render(<Shell createEnvironment={createEnvironment} seen={seen} tick={1} />);
    });
    await settle();

    expect(created).toHaveLength(1);
    expect(created[0]?.calls.filter((call) => call.method === "initialize")).toHaveLength(1);
  });

  it("boots nothing while a boot is already in flight", async () => {
    const { created, createEnvironment } = fakeFactory();
    const seen: { current: Booted | null } = { current: null };
    const tree = mount(<Shell createEnvironment={createEnvironment} seen={seen} />);
    // Render twice before letting the first boot's promises settle: the effect has already
    // fired, the machine is between `idle` and `initializing`, and a second attempt here is
    // exactly the double-boot this test exists to rule out.
    await act(async () => {
      tree.render(<Shell createEnvironment={createEnvironment} seen={seen} />);
    });
    await act(async () => {
      tree.render(<Shell createEnvironment={createEnvironment} seen={seen} tick={1} />);
    });
    await settle();

    expect(created).toHaveLength(1);
  });
});

describe("useAutoBoot against a machine that is not idle", () => {
  function AutoOnly({ status, boot, supported = true }: { status: EnvironmentStatus; boot: () => void; supported?: boolean }) {
    useAutoBoot({ supported, status, boot });
    return null;
  }

  it("does not call boot when the status is already booting or ready", async () => {
    for (const status of ["initializing", "booting", "ready", "stopped", "error"] as const) {
      const calls: string[] = [];
      const tree = mount(<AutoOnly status={status} boot={() => calls.push(status)} />);
      await act(async () => {
        tree.render(<AutoOnly status={status} boot={() => calls.push(status)} />);
      });
      await settle(2);
      expect(calls).toEqual([]);
    }
  });

  it("does not call boot on a browser the support probe rejected", async () => {
    const calls: string[] = [];
    const tree = mount(<AutoOnly status="idle" supported={false} boot={() => calls.push("boot")} />);
    await act(async () => {
      tree.render(<AutoOnly status="idle" supported={false} boot={() => calls.push("boot")} />);
    });
    await settle(2);
    expect(calls).toEqual([]);
  });

  it("calls boot once for an idle machine", async () => {
    const calls: string[] = [];
    const tree = mount(<AutoOnly status="idle" boot={() => calls.push("boot")} />);
    await act(async () => {
      tree.render(<AutoOnly status="idle" boot={() => calls.push("boot")} />);
    });
    await settle(2);
    expect(calls).toEqual(["boot"]);
  });
});

describe("a failed boot is recoverable", () => {
  it("reports the machine's error, tears it down, and lets the retry start a fresh boot", async () => {
    const { created, createEnvironment } = fakeFactory({ initializeError: "the kernel worker exited" });
    const seen: { current: Booted | null } = { current: null };
    const tree = mount(<Shell createEnvironment={createEnvironment} seen={seen} />);
    await act(async () => {
      tree.render(<Shell createEnvironment={createEnvironment} seen={seen} />);
    });
    await settle();

    expect(seen.current?.status).toBe("error");
    expect(seen.current?.error).toBe("the kernel worker exited");
    expect(seen.current?.busy).toBe(false);
    // The failed machine is shut down rather than left half-booted in the background.
    expect(created[0]?.calls.some((call) => call.method === "shutdown")).toBe(true);

    // The retry is the user's press: same action the environment card offers.
    await act(async () => {
      seen.current?.boot();
    });
    await settle();

    // Without tearing the failed environment down, `boot()` would return early and this would
    // still be one: the retry button would be a no-op.
    expect(created).toHaveLength(2);
    expect(seen.current?.status).toBe("error");
    expect(seen.current?.busy).toBe(false);
  });
});
