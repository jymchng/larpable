/**
 * The toast model: identity, tones, lifetimes and what counts as news.
 *
 * No DOM, no React, no timers — `use-toast.ts` owns the clock and this file owns the decisions.
 * The two assertions that matter most are the ones about *not* showing something: a source that
 * re-derives the same sentence on every render must not stack toasts, and a source that has gone
 * quiet must be forgotten so the same sentence can be announced again later.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_TOASTS,
  TOAST_TONE_DURATION_MS,
  dismissToast,
  newlyAnnounced,
  raiseToast,
  type Toast,
} from "../src/ui/toast";

const install = { id: "build", message: "Installing dependencies in the guest…" } as const;

function toasts(...requests: Parameters<typeof raiseToast>[1][]): readonly Toast[] {
  return requests.reduce<readonly Toast[]>((list, request) => raiseToast(list, request), []);
}

describe("raiseToast", () => {
  it("defaults to the info tone and its five seconds, which is what the install notice asked for", () => {
    const [toast] = toasts(install);

    expect(toast).toMatchObject({ id: "build", tone: "info", durationMs: 5_000 });
    expect(TOAST_TONE_DURATION_MS.info).toBe(5_000);
  });

  it("keeps a warning and a failure up for longer, because they have to be read", () => {
    expect(TOAST_TONE_DURATION_MS.warning).toBeGreaterThan(TOAST_TONE_DURATION_MS.info);
    expect(TOAST_TONE_DURATION_MS.danger).toBeGreaterThan(TOAST_TONE_DURATION_MS.success);
    // …and a caller may still ask for anything it likes.
    expect(raiseToast([], { ...install, durationMs: 1_000 })[0]?.durationMs).toBe(1_000);
  });

  it("replaces the toast with the same id instead of stacking a second one", () => {
    const list = toasts(install, { id: "build", message: "Building the site in the guest…" });

    expect(list).toHaveLength(1);
    expect(list[0]?.message).toBe("Building the site in the guest…");
  });

  it("keeps a refreshed toast in its place in the stack", () => {
    const list = toasts(
      { id: "machine", message: "Starting the Linux machine…" },
      install,
      { id: "machine", message: "Linux is ready.", tone: "success" },
    );

    expect(list.map((toast) => toast.id)).toEqual(["machine", "build"]);
    expect(list[0]?.tone).toBe("success");
  });

  it("says nothing rather than something empty", () => {
    expect(toasts({ id: "build", message: "   " })).toHaveLength(0);
  });

  it("drops the oldest when the stack is full, because the newest is the news", () => {
    const many = Array.from({ length: MAX_TOASTS + 1 }, (_unused, index) => ({
      id: `source-${String(index)}`,
      message: `message ${String(index)}`,
    }));
    const list = toasts(...many);

    expect(list).toHaveLength(MAX_TOASTS);
    expect(list[0]?.id).toBe("source-1");
    expect(list[list.length - 1]?.id).toBe(`source-${String(MAX_TOASTS)}`);
  });
});

describe("dismissToast", () => {
  it("removes one toast and leaves the rest alone", () => {
    const list = dismissToast(toasts(install, { id: "machine", message: "Linux is ready." }), "build");

    expect(list.map((toast) => toast.id)).toEqual(["machine"]);
  });

  it("is a no-op for an id that is already gone, because the timer and the cross race", () => {
    const list = toasts(install);

    expect(dismissToast(list, "build")).toHaveLength(0);
    expect(dismissToast(dismissToast(list, "build"), "build")).toHaveLength(0);
  });
});

describe("newlyAnnounced", () => {
  const installing = [{ id: "build", message: "Installing dependencies in the guest…", tone: "info" as const }];

  it("announces a notification the first time it appears", () => {
    const { raise, announced } = newlyAnnounced(new Map(), installing);

    expect(raise).toEqual(installing);
    expect(announced.get("build")).toBe("info:Installing dependencies in the guest…");
  });

  it("does not announce the same sentence twice while it is still true", () => {
    const first = newlyAnnounced(new Map(), installing);
    const second = newlyAnnounced(first.announced, installing);

    expect(second.raise).toEqual([]);
  });

  it("announces a changed sentence or a changed tone", () => {
    const announced = newlyAnnounced(new Map(), installing).announced;

    expect(
      newlyAnnounced(announced, [{ id: "build", message: "Building the site in the guest…", tone: "info" }])
        .raise,
    ).toHaveLength(1);
    expect(
      newlyAnnounced(announced, [{ id: "build", message: installing[0]!.message, tone: "success" }]).raise,
    ).toHaveLength(1);
  });

  it("forgets a source that went quiet, so the same words are news again next time", () => {
    const announced = newlyAnnounced(new Map(), installing).announced;
    const quiet = newlyAnnounced(announced, []);

    expect(quiet.raise).toEqual([]);
    expect(quiet.announced.size).toBe(0);
    // A rebuild says exactly the same thing, and must announce itself.
    expect(newlyAnnounced(quiet.announced, installing).raise).toHaveLength(1);
  });
});
