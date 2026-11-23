/**
 * Tabs in the terminal: "+" means another shell, "×" closes that shell.
 *
 * The rules that matter are the ones a user feels immediately: `+` must not kill the shell
 * you were reading, closing a tab must leave you looking at a shell rather than an empty
 * pane, and labels must never repeat (closing `Shell 1` of two must not make the next tab a
 * second `Shell 2`).
 */

import { describe, expect, it } from "vitest";

import { activeTabOf, addTab, closeTab, type ShellTab } from "../src/ui/terminal-tabs";

const one: ShellTab = { id: "shell-1", label: "Shell 1" };
const two: ShellTab = { id: "shell-2", label: "Shell 2" };
const three: ShellTab = { id: "shell-3", label: "Shell 3" };

describe("addTab", () => {
  it("appends without touching the shells already open", () => {
    const result = addTab([one], 2);
    expect(result.tabs).toEqual([one, two]);
    expect(result.tab).toEqual(two);
    expect(result.nextNumber).toBe(3);
  });

  it("keeps numbering monotonic, so a closed label is never reused", () => {
    const first = addTab([], 1);
    const second = addTab(first.tabs, first.nextNumber);
    // Close the first, then open another: a length-derived number would repeat "Shell 2".
    const afterClose = closeTab(second.tabs, "shell-1", "shell-2");
    const third = addTab(afterClose.tabs, second.nextNumber);
    expect(third.tabs.map((tab) => tab.label)).toEqual(["Shell 2", "Shell 3"]);
    expect(new Set(third.tabs.map((tab) => tab.id)).size).toBe(2);
  });
});

describe("closeTab", () => {
  it("leaves the selection alone when another tab is closed", () => {
    expect(closeTab([one, two, three], "shell-3", "shell-2")).toEqual({
      tabs: [one, two],
      activeId: "shell-2",
    });
  });

  it("selects the left neighbour when the active tab closes", () => {
    expect(closeTab([one, two, three], "shell-2", "shell-2")).toEqual({
      tabs: [one, three],
      activeId: "shell-1",
    });
  });

  it("selects the first remaining tab when the leftmost active tab closes", () => {
    expect(closeTab([one, two], "shell-1", "shell-1")).toEqual({
      tabs: [two],
      activeId: "shell-2",
    });
  });

  it("selects nothing when the last tab closes", () => {
    expect(closeTab([one], "shell-1", "shell-1")).toEqual({ tabs: [], activeId: null });
  });

  it("ignores an unknown id", () => {
    expect(closeTab([one], "shell-9", "shell-1")).toEqual({ tabs: [one], activeId: "shell-1" });
  });
});

describe("activeTabOf", () => {
  it("falls back to the last tab when the id is stale", () => {
    expect(activeTabOf([one, two], "shell-9")?.id).toBe("shell-2");
  });

  it("has nothing to show when there are no tabs", () => {
    expect(activeTabOf([], "shell-1")).toBeNull();
  });
});
