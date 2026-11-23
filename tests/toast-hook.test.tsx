// @vitest-environment jsdom
/**
 * The toast clock, driven through the real hooks in a real React tree.
 *
 * `tests/toast.test.ts` proves the model and `tests/toast-view.test.tsx` proves the markup; this
 * file proves the part neither can: that a toast actually *leaves*. "Five seconds and closable"
 * is a claim about a timer, and a claim about a timer that no test runs is a claim nobody checked.
 *
 * Fake timers rather than a real sleep: `advanceTimersByTime(5_000)` is exact, instant, and does
 * not make the suite slower for every case. `vi.useFakeTimers()` also fakes `queueMicrotask`-free
 * paths only, so React's own scheduling still works through `act()`.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastHost } from "../src/ui/components/toast";
import { useToast, type ToastControl } from "../src/ui/use-toast";
import { TOAST_TONE_DURATION_MS } from "../src/ui/toast";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

/** A host that publishes the control object, so a test can raise and dismiss like the app does. */
function Harness({ expose }: { expose: { current: ToastControl | null } }) {
  const toast = useToast();
  expose.current = toast;
  return <ToastHost toasts={toast.toasts} onDismiss={toast.dismiss} />;
}

function mount(): { current: ToastControl | null } {
  const expose: { current: ToastControl | null } = { current: null };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(<Harness expose={expose} />);
  });
  return expose;
}

/** The messages currently painted, in order. */
function painted(): string[] {
  return Array.from(document.querySelectorAll("[data-toast-id]")).map(
    (element) => element.textContent?.trim() ?? "",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("useToast with the real host", () => {
  it("shows the install notice and takes it away after five seconds", () => {
    const expose = mount();

    act(() => {
      expose.current?.raise({ id: "build", message: "Installing dependencies in the guest…" });
    });
    expect(document.body.textContent).toContain("Installing dependencies in the guest…");

    act(() => {
      vi.advanceTimersByTime(TOAST_TONE_DURATION_MS.info - 1);
    });
    // One millisecond short: still there. This is the half that a "it disappears eventually"
    // test would not catch.
    expect(painted()).toHaveLength(1);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(painted()).toEqual([]);
  });

  it("keeps a failure up for longer than a progress notice", () => {
    const expose = mount();

    act(() => {
      expose.current?.raise({ id: "build", message: "The build failed: TS2322", tone: "danger" });
    });
    act(() => {
      vi.advanceTimersByTime(TOAST_TONE_DURATION_MS.info);
    });
    expect(painted()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(TOAST_TONE_DURATION_MS.danger - TOAST_TONE_DURATION_MS.info);
    });
    expect(painted()).toEqual([]);
  });

  it("closes on the button, immediately, and leaves the other toasts alone", () => {
    const expose = mount();

    act(() => {
      expose.current?.raise({ id: "machine", message: "Linux is ready.", tone: "success" });
      expose.current?.raise({ id: "build", message: "Installing dependencies in the guest…" });
    });
    expect(painted()).toHaveLength(2);

    const close = document.querySelector<HTMLButtonElement>('[data-testid="toast-dismiss-build"]');
    expect(close).not.toBeNull();
    act(() => {
      close?.click();
    });

    expect(painted()).toHaveLength(1);
    expect(painted()[0]).toContain("Linux is ready.");
    // Its timer was disarmed with it: nothing fires for a toast that is already gone.
    act(() => {
      vi.advanceTimersByTime(TOAST_TONE_DURATION_MS.success * 2);
    });
    expect(painted()).toEqual([]);
  });

  it("restarts the clock when the same id is raised again", () => {
    const expose = mount();

    act(() => {
      expose.current?.raise({ id: "build", message: "Installing dependencies in the guest…" });
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    act(() => {
      expose.current?.raise({ id: "build", message: "Building the site in the guest…" });
    });

    // Four seconds in, the message changed — and the *new* message gets its own five seconds.
    expect(painted()[0]).toContain("Building the site in the guest…");
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(painted()).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(painted()).toEqual([]);
  });
});
