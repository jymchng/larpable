/**
 * The resizable split's arithmetic.
 *
 * The handle is the one §13 control a pointer can put into an impossible state (a negative
 * width, a pane too narrow for its own toolbar), so the rules are pure functions and this file
 * asserts them without a DOM: the bounds, the pointer mapping, the keyboard steps, the RTL
 * reversal and the "unmeasured container" answer that would otherwise be NaN.
 */

import { describe, expect, it } from "vitest";

import {
  MIN_SPLIT,
  SPLIT_KEY_STEP,
  SPLIT_KEY_STEP_COARSE,
  clampSplit,
  splitAfterKey,
  splitFromPointer,
  splitGridTemplate,
} from "../src/ui/split";

describe("clampSplit", () => {
  it("keeps a preference inside the usable band", () => {
    expect(clampSplit(50)).toBe(50);
    expect(clampSplit(MIN_SPLIT)).toBe(MIN_SPLIT);
    expect(clampSplit(100 - MIN_SPLIT)).toBe(100 - MIN_SPLIT);
  });

  it("clamps rather than rejects a stored preference outside the band", () => {
    expect(clampSplit(2)).toBe(MIN_SPLIT);
    expect(clampSplit(99)).toBe(100 - MIN_SPLIT);
  });

  it("answers the default for a value that is not a number", () => {
    expect(clampSplit(Number.NaN)).toBe(50);
    expect(clampSplit(Number.POSITIVE_INFINITY)).toBe(50);
  });
});

describe("splitFromPointer", () => {
  it("maps a pointer position to a percentage of the container", () => {
    expect(splitFromPointer(500, 0, 1000)).toBe(50);
    expect(splitFromPointer(250, 0, 1000)).toBe(25);
    expect(splitFromPointer(750, 100, 1000)).toBe(65);
  });

  it("clamps a drag past the edge instead of going out of bounds", () => {
    expect(splitFromPointer(-400, 0, 1000)).toBe(MIN_SPLIT);
    expect(splitFromPointer(4000, 0, 1000)).toBe(100 - MIN_SPLIT);
  });

  it("answers the default for an unmeasured container", () => {
    expect(splitFromPointer(400, 0, 0)).toBe(50);
    expect(splitFromPointer(400, 0, Number.NaN)).toBe(50);
  });
});

describe("splitAfterKey", () => {
  it("moves by the fine step, and by the coarse step with Shift", () => {
    expect(splitAfterKey(50, "ArrowRight")).toBe(50 + SPLIT_KEY_STEP);
    expect(splitAfterKey(50, "ArrowLeft")).toBe(50 - SPLIT_KEY_STEP);
    expect(splitAfterKey(50, "ArrowRight", { shift: true })).toBe(50 + SPLIT_KEY_STEP_COARSE);
  });

  it("jumps to the control's own bounds, not to 0 and 100", () => {
    expect(splitAfterKey(50, "Home")).toBe(MIN_SPLIT);
    expect(splitAfterKey(50, "End")).toBe(100 - MIN_SPLIT);
  });

  it("cannot be driven outside the announced range by repeated keys", () => {
    let percent = 50;
    for (let step = 0; step < 100; step += 1) percent = splitAfterKey(percent, "ArrowLeft", { shift: true }) ?? percent;
    expect(percent).toBe(MIN_SPLIT);
  });

  it("reverses the arrows in a right-to-left layout", () => {
    expect(splitAfterKey(50, "ArrowLeft", { rtl: true })).toBe(50 + SPLIT_KEY_STEP);
    expect(splitAfterKey(50, "ArrowRight", { rtl: true })).toBe(50 - SPLIT_KEY_STEP);
  });

  it("ignores keys it does not own", () => {
    expect(splitAfterKey(50, "Tab")).toBeNull();
    expect(splitAfterKey(50, "a")).toBeNull();
  });
});

describe("splitGridTemplate", () => {
  it("gives both columns minmax(0, …) so a long line can shrink", () => {
    expect(splitGridTemplate(60)).toBe("minmax(0, 60.00fr) minmax(0, 40.00fr)");
  });

  it("clamps before writing the template", () => {
    expect(splitGridTemplate(0)).toBe(`minmax(0, ${MIN_SPLIT.toFixed(2)}fr) minmax(0, ${(100 - MIN_SPLIT).toFixed(2)}fr)`);
  });
});
