/**
 * The terminal's added keys and clipboard chrome.
 *
 * Two things are worth testing here, and neither needs a browser:
 *
 * 1. the byte mapping — `CTRL` then `c` must send `0x03`, because that is the difference
 *    between interrupting a build and doing nothing, and a wrong constant would fail
 *    silently (the shell would simply print a `c`);
 * 2. the chrome a touch screen needs — copy / paste / cut / clear buttons and a key row —
 *    is actually rendered, and "New shell" is an icon now rather than a word.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  NO_MODIFIERS,
  TERMINAL_KEYS,
  controlCodeFor,
  encodeModifiedInput,
  hasModifiers,
  toggleModifier,
} from "../src/ui/terminal-keys";
import { TerminalPanel, TRANSCRIPT_MIRROR_CLASS } from "../src/ui/terminal-panel";

describe("controlCodeFor", () => {
  it("maps letters the way every terminal does", () => {
    expect(controlCodeFor("c")).toBe("\u0003");
    expect(controlCodeFor("C")).toBe("\u0003");
    expect(controlCodeFor("d")).toBe("\u0004");
    expect(controlCodeFor("z")).toBe("\u001a");
    expect(controlCodeFor("l")).toBe("\u000c");
  });

  it("maps the punctuation in the @.._ range", () => {
    expect(controlCodeFor("@")).toBe("\u0000");
    expect(controlCodeFor("[")).toBe("\u001b");
    expect(controlCodeFor("_")).toBe("\u001f");
  });

  it("sends DEL for Ctrl-?, not 0x1f", () => {
    expect(controlCodeFor("?")).toBe("\u007f");
  });

  it("refuses characters that have no control form", () => {
    expect(controlCodeFor("1")).toBeNull();
    expect(controlCodeFor(" ")).toBeNull();
    expect(controlCodeFor("é")).toBeNull();
    expect(controlCodeFor("€")).toBeNull();
  });
});

describe("encodeModifiedInput", () => {
  it("passes everything through when nothing is armed", () => {
    expect(encodeModifiedInput("ls", NO_MODIFIERS)).toEqual({ data: "ls", consumed: NO_MODIFIERS });
    expect(encodeModifiedInput("c", NO_MODIFIERS)).toEqual({ data: "c", consumed: NO_MODIFIERS });
  });

  it("turns an armed CTRL and one character into a control code, once", () => {
    const armed = { ctrl: true, alt: false };
    const first = encodeModifiedInput("c", armed);
    expect(first.data).toBe("\u0003");
    // One-shot: the modifier is spent, so the next keystroke is literal again.
    expect(first.consumed).toEqual(NO_MODIFIERS);
    expect(encodeModifiedInput("c", first.consumed).data).toBe("c");
  });

  it("prefixes an armed ALT with ESC, as a real terminal does", () => {
    const result = encodeModifiedInput("b", { ctrl: false, alt: true });
    expect(result.data).toBe("\u001bb");
    expect(result.consumed).toEqual(NO_MODIFIERS);
  });

  it("applies both modifiers when both are armed", () => {
    expect(encodeModifiedInput("x", { ctrl: true, alt: true }).data).toBe("\u001b\u0018");
  });

  it("keeps the modifier armed when the character has no control form", () => {
    const armed = { ctrl: true, alt: false };
    const result = encodeModifiedInput("€", armed);
    expect(result.data).toBe("€");
    expect(result.consumed).toEqual(armed);
  });

  it("never mangles a paste: multi-character input goes through untouched", () => {
    const pasted = "npm run build\n";
    expect(encodeModifiedInput(pasted, { ctrl: true, alt: true })).toEqual({
      data: pasted,
      consumed: { ctrl: true, alt: true },
    });
  });

  it("does nothing for an empty chunk", () => {
    expect(encodeModifiedInput("", { ctrl: true, alt: false })).toEqual({
      data: "",
      consumed: { ctrl: true, alt: false },
    });
  });
});

describe("toggleModifier", () => {
  it("arms and disarms one modifier without touching the other", () => {
    const armed = toggleModifier(NO_MODIFIERS, "ctrl");
    expect(armed).toEqual({ ctrl: true, alt: false });
    expect(toggleModifier(armed, "alt")).toEqual({ ctrl: true, alt: true });
    expect(toggleModifier(armed, "ctrl")).toEqual(NO_MODIFIERS);
    expect(hasModifiers(NO_MODIFIERS)).toBe(false);
    expect(hasModifiers({ ctrl: true, alt: false })).toBe(true);
  });
});

describe("TERMINAL_KEYS", () => {
  it("offers the keys a soft keyboard cannot send", () => {
    expect(TERMINAL_KEYS.map((key) => key.id)).toEqual([
      "ctrl",
      "alt",
      "esc",
      "tab",
      "up",
      "down",
      "right",
      "left",
    ]);
  });

  it("sends real terminal sequences, not literal text", () => {
    const byId = new Map(TERMINAL_KEYS.map((key) => [key.id, key]));
    expect(byId.get("esc")?.sequence).toBe("\u001b");
    expect(byId.get("tab")?.sequence).toBe("\t");
    expect(byId.get("up")?.sequence).toBe("\u001b[A");
    expect(byId.get("down")?.sequence).toBe("\u001b[B");
    expect(byId.get("right")?.sequence).toBe("\u001b[C");
    expect(byId.get("left")?.sequence).toBe("\u001b[D");
  });

  it("makes the modifiers sticky rather than bytes", () => {
    const ctrl = TERMINAL_KEYS.find((key) => key.id === "ctrl");
    const alt = TERMINAL_KEYS.find((key) => key.id === "alt");
    expect(ctrl?.modifier).toBe("ctrl");
    expect(alt?.modifier).toBe("alt");
    expect(ctrl?.sequence).toBe("");
    expect(alt?.sequence).toBe("");
  });

  it("gives every key a description, because a glyph is not a name", () => {
    for (const key of TERMINAL_KEYS) {
      expect(key.description.length).toBeGreaterThan(8);
    }
  });
});

describe("TerminalPanel chrome", () => {
  const markup = renderToStaticMarkup(
    <TerminalPanel ready={false} cwd="/workspace" openShell={null} />,
  );

  it("puts copy, paste, cut and clear in the header", () => {
    for (const label of [
      "Copy the selection",
      "Paste from the clipboard",
      "Cut: copy the selection and clear the highlight",
      "Clear the terminal",
    ]) {
      expect(markup).toContain(`aria-label="${label}"`);
    }
  });

  it("offers a new shell as a + in the tab strip, not as a word", () => {
    expect(markup).toContain('data-testid="terminal-new-shell"');
    expect(markup).toContain('aria-label="New shell tab"');
    expect(markup).toContain('role="tablist"');
    // The button carries no visible text any more: it is a `+` glyph.
    expect(markup).not.toContain(">New shell<");
  });

  it("starts with no tab, and says so with a dot instead of a word", () => {
    expect(markup).toContain('data-testid="terminal-empty"');
    expect(markup).toContain("Boot Linux to get a shell in /workspace.");
    // The status is one filled circle: the words live in the label and the tooltip.
    expect(markup).toContain('data-testid="terminal-status"');
    expect(markup).toContain('data-tone="grey"');
    expect(markup).toContain('aria-label="No shell"');
    expect(markup).toContain('title="No shell"');
    expect(markup).not.toContain(">No shell<");
  });

  it("keeps the sr-only transcript out of the browser's selection", () => {
    // The mirror only renders once a shell exists, which a static render cannot reach, so the
    // classes are asserted where they are defined; the browser probe
    // (`scripts/probe-clipboard.ts`) asserts the computed `user-select` and the clipboard text.
    expect(TRANSCRIPT_MIRROR_CLASS).toContain("sr-only");
    expect(TRANSCRIPT_MIRROR_CLASS).toContain("select-none");
  });

  it("renders the whole key row, disabled until a shell is attached", () => {
    expect(markup).toContain('role="toolbar"');
    for (const key of TERMINAL_KEYS) {
      expect(markup).toContain(`data-testid="terminal-key-${key.id}"`);
      expect(markup).toContain(`aria-label="${key.description}"`);
    }
    expect(markup).toContain('data-testid="terminal-key-ctrl"');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('data-connection="waiting"');
  });
});
