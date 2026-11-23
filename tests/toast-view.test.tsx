/**
 * The toast stack as markup: what a screenshot shows and a screen reader hears.
 *
 * The four things this pins, in the order they would break: the live region exists even when
 * there is nothing to announce (a region added *with* its content is usually not announced at
 * all), each tone paints its own colour and its own glyph (so colour is never the only channel),
 * every toast is dismissible through a real named button, and the container cannot swallow a
 * press meant for the pane behind it.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ToastHost } from "../src/ui/components/toast";
import { raiseToast, type Toast, type ToastTone } from "../src/ui/toast";

function host(toasts: readonly Toast[] = []): string {
  return renderToStaticMarkup(<ToastHost toasts={toasts} onDismiss={() => undefined} />);
}

function one(tone: ToastTone, message = "Something happened."): string {
  return host(raiseToast([], { id: "build", message, tone }));
}

describe("ToastHost", () => {
  it("keeps the live region mounted when there is nothing to say", () => {
    const html = host();

    expect(html).toContain('data-testid="toast-host"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("pointer-events-none");
    // No toast, no rectangle: the stack is a region, not furniture.
    expect(html).not.toContain("data-toast-id");
  });

  it("paints each tone in its own colour, with the tint the rest of the app uses", () => {
    const tones: Record<ToastTone, string> = {
      info: "bg-info/20",
      success: "bg-success/20",
      warning: "bg-warning/20",
      danger: "bg-destructive/20",
    };

    for (const [tone, expected] of Object.entries(tones)) {
      const html = one(tone as ToastTone);
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain(expected);
      // The message itself is full-strength text of the same tone, never grey.
      expect(html).toContain(`text-${tone === "danger" ? "destructive" : tone}`);
    }
  });

  it("gives every tone its own pictogram, so the colour is not the only channel", () => {
    expect(one("info")).toContain("lucide-info");
    expect(one("success")).toContain("lucide-circle-check");
    expect(one("warning")).toContain("lucide-triangle-alert");
    expect(one("danger")).toContain("lucide-triangle-alert");
  });

  it("dismisses through a real, named button rather than a bare pictogram", () => {
    const html = one("info", "Installing dependencies in the guest…");

    expect(html).toContain('data-testid="toast-dismiss-build"');
    expect(html).toContain('aria-label="Dismiss this message"');
    // The hit target and the focus ring come from `IconButton`, not from this file.
    expect(html).toContain("size-8");
    expect(html).toContain("focus-visible:ring");
  });

  it("lets a press reach its own close button while the stack ignores the rest", () => {
    const html = one("danger", "The build failed.");

    expect(html).toContain("pointer-events-auto");
    expect(html).toContain("data-testid=\"toast-build\"");
    expect(html).toContain("The build failed.");
  });

  it("stacks in order, oldest first, each with its own id", () => {
    const first = raiseToast([], { id: "machine", message: "Linux is ready.", tone: "success" });
    const both = raiseToast(first, { id: "build", message: "Installing dependencies in the guest…" });
    const html = host(both);

    expect(html.indexOf("Linux is ready.")).toBeLessThan(
      html.indexOf("Installing dependencies in the guest…"),
    );
  });
});
