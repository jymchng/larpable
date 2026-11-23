/**
 * The viewport presets, and the sentence that keeps them honest.
 *
 * A preset that merely drew a narrow frame would be a lie of omission about device pixel
 * ratio and touch. So the tests assert the sizes, the "desktop fills the pane" decision, the
 * clamp inside a narrower pane, and the disclosure the status line has to carry.
 */

import { describe, expect, it } from "vitest";

import {
  VIEWPORTS,
  describeViewport,
  isSizedViewport,
  viewportFor,
  viewportStyle,
  type ViewportName,
} from "../src/ui/viewport";

describe("VIEWPORTS", () => {
  it("offers desktop, tablet and mobile, in that order", () => {
    expect(VIEWPORTS.map((preset) => preset.name)).toEqual(["desktop", "tablet", "mobile"]);
  });

  it("does not pin desktop to a size, because the pane is the real window", () => {
    expect(viewportFor("desktop").width).toBeNull();
    expect(viewportFor("desktop").height).toBeNull();
  });

  it("sizes tablet and mobile at the widths a responsive layout breaks at", () => {
    expect(viewportFor("tablet")).toMatchObject({ width: 834, height: 1112 });
    expect(viewportFor("mobile")).toMatchObject({ width: 390, height: 844 });
  });
});

describe("viewportFor", () => {
  it("falls back to filling the pane for a name no longer in the list", () => {
    expect(viewportFor("phablet" as ViewportName).name).toBe("desktop");
  });
});

describe("isSizedViewport", () => {
  it("is true only for a preset that constrains both dimensions", () => {
    expect(isSizedViewport(viewportFor("desktop"))).toBe(false);
    expect(isSizedViewport(viewportFor("mobile"))).toBe(true);
  });
});

describe("viewportStyle", () => {
  it("returns null for desktop, so the frame fills the pane", () => {
    expect(viewportStyle(viewportFor("desktop"))).toBeNull();
  });

  it("clamps with maxWidth/maxHeight so a narrow pane cannot overflow", () => {
    expect(viewportStyle(viewportFor("mobile"))).toEqual({
      width: "390px",
      height: "844px",
      maxWidth: "100%",
      maxHeight: "100%",
    });
  });
});

describe("describeViewport", () => {
  it("states what a sized preset does not emulate", () => {
    const sentence = describeViewport(viewportFor("mobile"));
    expect(sentence).toContain("390 × 844 CSS px");
    expect(sentence).toContain("no touch events or device pixel ratio");
  });

  it("does not disclaim emulation for a preset that emulates nothing", () => {
    expect(describeViewport(viewportFor("desktop"))).toBe("Desktop: Fills the pane at your window's size.");
  });
});
