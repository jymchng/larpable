/**
 * The phone's decisions, as functions: which stage a link asks for, how tall the visible area is,
 * how much a fixed-size preview must shrink, what a fingertip needs, and what a handset should be
 * told before it waits four minutes for a kernel.
 *
 * None of this needs a browser, which is the point: the layout itself is CSS and the behaviour is
 * exercised by `scripts/mobile-acceptance.ts` (`bun run acceptance:mobile`) in Chromium at
 * 390 x 844 and 844 x 390. What is
 * proven here is that the *values* are right — the boundary is Tailwind's, the target is WCAG's,
 * the scale never inflates and never goes illegible, and the notes appear only where they apply.
 */

import { describe, expect, it } from "vitest";

import { evaluateSupport } from "../src/env/support";
import {
  handsetNotes,
  isHandset,
  mobilePlatform,
  type HandsetFacts,
} from "../src/ui/mobile";
import {
  DEFAULT_STAGE,
  PANE_STAGES,
  STAGE_LABEL,
  isPaneStage,
  needsStageSwitch,
  stageFromSearch,
  stageShows,
} from "../src/ui/stage";
import {
  TOUCH_TARGET_BLOCK,
  TOUCH_TARGET_ICON,
  TOUCH_TARGET_MIN_PX,
  TOUCH_TARGET_SPACING_UNITS,
  meetsTouchTarget,
} from "../src/ui/touch";
import { appHeight } from "../src/ui/use-app-height";
import { frameZoom, viewportFor } from "../src/ui/viewport";

const supported = evaluateSupport({
  crossOriginIsolated: true,
  jspi: true,
  sharedArrayBuffer: true,
});
const noJspi = evaluateSupport({
  crossOriginIsolated: true,
  jspi: false,
  sharedArrayBuffer: true,
});

const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1";
const android = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/137.0 Mobile Safari/537.36";

function facts(overrides: Partial<HandsetFacts> = {}): HandsetFacts {
  return { width: 390, userAgent: iphone, deviceMemoryGb: null, coarsePointer: true, ...overrides };
}

describe("the pane stages", () => {
  it("names exactly two panes, agent first", () => {
    expect(PANE_STAGES).toEqual(["agent", "preview"]);
    expect(DEFAULT_STAGE).toBe("agent");
    expect(STAGE_LABEL).toEqual({ agent: "Agent", preview: "Preview" });
  });

  it("only accepts its own names", () => {
    expect(isPaneStage("preview")).toBe(true);
    expect(isPaneStage("agent")).toBe(true);
    for (const value of ["Preview", "pane", "", null, undefined, 1]) {
      expect(isPaneStage(value)).toBe(false);
    }
  });

  it("reads ?pane=preview and falls back for anything else", () => {
    expect(stageFromSearch("?pane=preview")).toBe("preview");
    expect(stageFromSearch("pane=preview&x=1")).toBe("preview");
    expect(stageFromSearch("?pane=agent")).toBe("agent");
    // A URL is user input: a typo shows the app, not a blank pane.
    expect(stageFromSearch("?pane=termnial")).toBe("agent");
    expect(stageFromSearch("")).toBe("agent");
    expect(stageFromSearch("?")).toBe("agent");
  });

  it("shows one pane per stage", () => {
    expect(stageShows("agent", "agent")).toBe(true);
    expect(stageShows("agent", "preview")).toBe(false);
    expect(stageShows("preview", "preview")).toBe(true);
    expect(stageShows("preview", "agent")).toBe(false);
  });

  it("needs the switcher below Tailwind's lg breakpoint, and only there", () => {
    // The two ends of the range the goal names, plus the boundary itself.
    expect(needsStageSwitch(360)).toBe(true);
    expect(needsStageSwitch(430)).toBe(true);
    expect(needsStageSwitch(1023)).toBe(true);
    expect(needsStageSwitch(1024)).toBe(false);
    expect(needsStageSwitch(1440)).toBe(false);
  });
});

describe("the visible height", () => {
  it("follows the visual viewport, which is what the keyboard shrinks", () => {
    expect(appHeight(844, 844)).toBe(844);
    // iOS reports a shorter visual viewport while the keyboard is up; that is the number to use.
    expect(appHeight(512, 844)).toBe(512);
  });

  it("never claims more room than the document has", () => {
    expect(appHeight(900, 844)).toBe(844);
  });

  it("keeps the stylesheet's dvh when there is nothing to measure", () => {
    expect(appHeight(null, 844)).toBeNull();
    expect(appHeight(undefined, 844)).toBeNull();
    expect(appHeight(0, 844)).toBeNull();
    expect(appHeight(Number.NaN, 844)).toBeNull();
    expect(appHeight(844, 0)).toBeNull();
  });
});

describe("the preview's fit-to-width scale", () => {
  it("leaves a frame that fits exactly alone", () => {
    expect(frameZoom(900, null)).toBe(1);
    expect(frameZoom(null, 834)).toBe(1);
    expect(frameZoom(390, 390)).toBe(1);
    expect(frameZoom(900, 834)).toBe(1);
  });

  it("scales a preset that is wider than the pane, and says so in hundredths", () => {
    // The real case: the tablet preset in a 390 px phone pane.
    expect(frameZoom(374, 834)).toBe(0.45);
    expect(frameZoom(390, 834)).toBe(0.47);
    // The phone preset in a slightly narrower pane.
    expect(frameZoom(360, 390)).toBe(0.92);
  });

  it("stops at 25 % and lets the pane scroll rather than draw an illegible page", () => {
    expect(frameZoom(300, 834)).toBe(0.36);
    // 200/834 is 0.24: below the floor, so the pane scrolls instead of shrinking to a smear.
    expect(frameZoom(200, 834)).toBe(1);
    expect(frameZoom(100, 834)).toBe(1);
    expect(frameZoom(0, 834)).toBe(1);
  });

  it("has a preset to scale in the first place", () => {
    expect(viewportFor("tablet").width).toBe(834);
    expect(viewportFor("desktop").width).toBeNull();
  });
});

describe("the touch target", () => {
  it("is WCAG's 44 px, which is Tailwind's 11 spacing units", () => {
    expect(TOUCH_TARGET_MIN_PX).toBe(44);
    expect(TOUCH_TARGET_SPACING_UNITS * 4).toBe(TOUCH_TARGET_MIN_PX);
    expect(TOUCH_TARGET_ICON).toContain(`size-${String(TOUCH_TARGET_SPACING_UNITS)}`);
    expect(TOUCH_TARGET_BLOCK).toContain(`min-h-${String(TOUCH_TARGET_SPACING_UNITS)}`);
  });

  it("is applied below the laptop breakpoint, not above it", () => {
    // `max-lg:` is the variant that matters: a 32 px button is right under a mouse and wrong
    // under a thumb.
    expect(TOUCH_TARGET_ICON.startsWith("max-lg:")).toBe(true);
    expect(TOUCH_TARGET_BLOCK.startsWith("max-lg:")).toBe(true);
  });

  it("measures both edges", () => {
    expect(meetsTouchTarget(44, 44)).toBe(true);
    expect(meetsTouchTarget(48, 44)).toBe(true);
    expect(meetsTouchTarget(32, 44)).toBe(false);
    expect(meetsTouchTarget(44, 32)).toBe(false);
  });
});

describe("what a handset is told", () => {
  it("recognises the two engines and refuses to guess at a third", () => {
    expect(mobilePlatform(iphone)).toBe("ios");
    expect(mobilePlatform(android)).toBe("android");
    expect(mobilePlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("other");
  });

  it("counts a narrow screen with a finger as a handset, and a narrow desktop window as neither", () => {
    expect(isHandset(facts())).toBe(true);
    expect(isHandset(facts({ width: 844, userAgent: android }))).toBe(true);
    // A 390-px window on a laptop: narrowed, but not a phone, and "update iOS" would be a lie.
    expect(isHandset(facts({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", coarsePointer: false }))).toBe(
      false,
    );
    expect(isHandset(facts({ width: 1440 }))).toBe(false);
  });

  it("says nothing at all on a desktop", () => {
    expect(handsetNotes(noJspi, facts({ width: 1440, userAgent: "Mozilla/5.0 (X11; Linux x86_64)" }))).toEqual([]);
  });

  it("tells an iPhone the truth about its engine: every browser there is Safari", () => {
    const notes = handsetNotes(noJspi, facts());
    expect(notes).toHaveLength(2);
    expect(notes[0]?.tone).toBe("warn");
    expect(notes[0]?.text).toContain("every browser is Safari under the hood");
    expect(notes[0]?.text).toContain("JSPI");
    // The advice a laptop gets would be wrong here, so it is not repeated.
    expect(notes[0]?.text).not.toContain("Chrome/Edge 137+");
    // Nothing is lost: projects live on this device.
    expect(notes[1]?.text).toContain("Nothing you have built is lost");
  });

  it("tells an Android user to try the browser they are not using", () => {
    const notes = handsetNotes(noJspi, facts({ userAgent: android }));
    expect(notes[0]?.text).toContain("Chrome and Edge 137+");
    expect(notes[0]?.text).toContain("built into another app");
  });

  it("warns about memory only when the browser actually reports a small number", () => {
    const small = handsetNotes(supported, facts({ deviceMemoryGb: 2 }));
    expect(small.some((note) => note.text.includes("2 GB of memory"))).toBe(true);
    expect(small.some((note) => note.text.includes("out-of-memory"))).toBe(true);

    // iOS reports nothing; silence is not "0 GB".
    const unknown = handsetNotes(supported, facts({ deviceMemoryGb: null }));
    expect(unknown.some((note) => note.text.includes("GB of memory"))).toBe(false);

    // 8 GB is plenty, so no note.
    expect(handsetNotes(supported, facts({ deviceMemoryGb: 8 })).some((note) => note.text.includes("GB"))).toBe(
      false,
    );
  });

  it("always asks a phone user to keep the tab in front", () => {
    const notes = handsetNotes(supported, facts({ deviceMemoryGb: 8 }));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.tone).toBe("info");
    expect(notes[0]?.text).toContain("suspends a backgrounded tab");
  });
});
