/**
 * The popover's rules, and the wiring that has to use them.
 *
 * Two layers, because the suite has no DOM (every UI test renders with
 * `renderToStaticMarkup`):
 *
 * 1. **The rules** — `src/ui/popover.ts` — are pure and asserted directly: what "closed"
 *    means for the surface, which key dismisses, and which presses count as "outside".
 * 2. **The wiring** — `src/ui/components/popover.tsx` — is a guard test over its source: it
 *    must call those two rules, listen on `document` for `keydown` and `pointerdown`, and
 *    render a labelled `role="dialog"`. A component that reimplemented the rules inline would
 *    pass layer 1 and fail layer 2.
 *
 * What neither layer can honestly claim is that a *real* keypress closes a *real* browser
 * dialog. That is measured, not asserted here: `bun run acceptance:popover`
 * (`scripts/popover-acceptance.ts`) opens the popover in Chromium at 390 px, clicks the cog,
 * reads `document.activeElement`, presses Escape, presses outside, and measures the surface's
 * rectangle — see `docs/provider-popover.md` for the numbers it wrote.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isPopoverDismissKey, pointerDownDismisses, popoverSurface } from "../src/ui/popover";

const root = resolve(import.meta.dirname, "..");
const component = readFileSync(resolve(root, "src/ui/components/popover.tsx"), "utf8");

describe("popoverSurface", () => {
  it("is closed until it is opened, and closed means hidden", () => {
    expect(popoverSurface(false)).toEqual({ state: "closed", hidden: true });
  });

  it("keeps the surface in the DOM when open, because aria-controls must resolve", () => {
    expect(popoverSurface(true)).toEqual({ state: "open", hidden: false });
  });
});

describe("isPopoverDismissKey", () => {
  it("closes on Escape, in both spellings", () => {
    expect(isPopoverDismissKey("Escape")).toBe(true);
    expect(isPopoverDismissKey("Esc")).toBe(true);
  });

  it("leaves every other key to the control that has focus", () => {
    for (const key of ["Enter", "Tab", " ", "e", "ArrowDown", "F1"]) {
      expect(isPopoverDismissKey(key)).toBe(false);
    }
  });
});

describe("pointerDownDismisses", () => {
  it("closes on a press anywhere outside the panel and its anchor", () => {
    expect(pointerDownDismisses({ panel: false, anchor: false })).toBe(true);
  });

  it("does not close on a press inside the panel: a click in a form is not a request to leave", () => {
    expect(pointerDownDismisses({ panel: true, anchor: true })).toBe(false);
    expect(pointerDownDismisses({ panel: true, anchor: false })).toBe(false);
  });

  it("does not close on a press on the trigger, or the click would reopen what it closed", () => {
    expect(pointerDownDismisses({ panel: false, anchor: true })).toBe(false);
  });
});

describe("the surface uses the rules rather than its own copies", () => {
  it("imports both decision functions from src/ui/popover.ts", () => {
    expect(component).toContain('from "@/ui/popover"');
    expect(component).toContain("isPopoverDismissKey");
    expect(component).toContain("pointerDownDismisses");
    expect(component).toContain("popoverSurface");
  });

  it("dismisses from the document, on keydown and on pointerdown", () => {
    // Both events happen outside the surface by definition, so a listener on the surface
    // itself would never fire for the two ways out.
    expect(component).toContain('document.addEventListener("keydown"');
    expect(component).toContain('document.addEventListener("pointerdown"');
    expect(component).toContain('document.removeEventListener("keydown"');
    expect(component).toContain('document.removeEventListener("pointerdown"');
  });

  it("is a labelled dialog that can take focus, and says it is not modal", () => {
    expect(component).toContain('role="dialog"');
    expect(component).toContain("aria-labelledby={headingId}");
    expect(component).toContain('aria-modal="false"');
    expect(component).toContain("tabIndex={-1}");
  });

  it("moves focus in on open and back to the trigger on the two keyboard ways out", () => {
    expect(component).toContain("surface.current?.focus()");
    // Once for Escape, once for the close button: both hide the control that had focus.
    expect(component.match(/querySelector<HTMLElement>\("button"\)\?\.focus\(\)/g)).toHaveLength(2);
  });
});
