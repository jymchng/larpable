/**
 * The dot-only status indicators.
 *
 * Two user-visible statuses used to be worded badges — the terminal's connection state and
 * the dashboard's "N/3 requirements" — sitting in toolbar rows next to icon buttons. They
 * are now one filled circle each. The point of these tests is that the change removed the
 * *words*, not the *information*:
 *
 * - nothing is painted as text (a dot with a label next to it would be the badge again);
 * - the words are still the accessible name and the tooltip, so a screen reader, a keyboard
 *   user and a mouse user all get them;
 * - the colour is the product decision, so it is asserted per state — green only when the
 *   thing is actually good, amber while it is in progress or partly good, red on failure,
 *   grey when the state is neutral rather than a failure.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusDot, toneFor } from "../src/ui/components/status-dot";
import { describeConnection } from "../src/ui/terminal-panel";
import { requirementsTone } from "../src/ui/dashboard";

function render(tone: Parameters<typeof StatusDot>[0]["tone"], label: string): string {
  return renderToStaticMarkup(<StatusDot tone={tone} label={label} testId="probe" />);
}

describe("StatusDot", () => {
  it("is a dot and nothing else — the label is the accessible name, not text", () => {
    const html = render("green", "Connected");

    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Connected"');
    expect(html).toContain('title="Connected"');
    expect(html).toContain('data-testid="probe"');
    // No text node at all: the span is empty, so nothing can be painted.
    expect(html).toMatch(/<span[^>]*><\/span>/);
    expect(html).not.toContain(">Connected<");
  });

  it("paints each tone with the theme's own success/warning/destructive colours", () => {
    expect(render("green", "ok")).toContain("bg-success");
    expect(render("amber", "pending")).toContain("bg-warning");
    expect(render("red", "failed")).toContain("bg-destructive");
    expect(render("grey", "idle")).toContain("bg-muted-foreground/60");
  });

  it("is round, small and non-shrinking, so a flex row cannot squash it into a line", () => {
    const html = render("green", "Connected");
    expect(html).toContain("rounded-full");
    expect(html).toContain("size-2.5");
    expect(html).toContain("shrink-0");
  });

  it("carries its tone in the DOM, which is how the tests and a theme can read it", () => {
    for (const tone of ["green", "amber", "red", "grey"] as const) {
      expect(render(tone, tone)).toContain(`data-tone="${tone}"`);
    }
  });

  it("turns a boolean into a tone, with a caller-chosen not-good colour", () => {
    expect(toneFor(true)).toBe("green");
    expect(toneFor(false)).toBe("red");
    expect(toneFor(false, "grey")).toBe("grey");
  });
});

describe("the terminal's connection as a dot", () => {
  it("is green only when the shell is actually attached", () => {
    expect(describeConnection("connected")).toEqual({ label: "Connected", tone: "green" });
  });

  it("is amber while attaching and red only on failure", () => {
    expect(describeConnection("connecting")).toEqual({ label: "Connecting", tone: "amber" });
    expect(describeConnection("error")).toEqual({ label: "Failed", tone: "red" });
  });

  it("is neutral, not red, for states that are neither good nor broken", () => {
    expect(describeConnection("ended")).toEqual({ label: "Exited", tone: "grey" });
    expect(describeConnection("waiting")).toEqual({ label: "Not connected", tone: "grey" });
  });

  it("never paints green for a state that is not connected", () => {
    for (const connection of ["connecting", "ended", "error", "waiting"] as const) {
      expect(describeConnection(connection).tone).not.toBe("green");
    }
  });
});

describe("the browser's requirement count as a dot", () => {
  it("is green for all three, amber for partly there, red for none", () => {
    expect(requirementsTone(3)).toBe("green");
    expect(requirementsTone(2)).toBe("amber");
    expect(requirementsTone(1)).toBe("amber");
    expect(requirementsTone(0)).toBe("red");
  });
});
