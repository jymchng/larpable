/**
 * What each clipboard action is allowed to read, and what it must refuse.
 *
 * The bug this file exists for: Copy / Paste / Cut acted on "all the content of the terminal
 * panel". The measured cause is that the browser's own copy path takes the *document's* selection
 * (the pane, including the sr-only transcript mirror), while the terminal's selection is a
 * different thing entirely. So the actions were moved into `src/ui/terminal-clipboard.ts`, where
 * the text is a parameter — and these tests pin that down:
 *
 * - the copy is exactly the string `getSelection()` returned, and a `window.getSelection()` that
 *   would answer "the whole pane" is never consulted (it is booby-trapped below, so a regression
 *   fails the test instead of silently copying the pane);
 * - an empty selection writes nothing and says so;
 * - a missing or refusing clipboard API is reported, not swallowed;
 * - Cut copies and then drops the highlight (a terminal has no cut), Paste writes into exactly one
 *   terminal, and neither reaches for the other;
 * - Ctrl/Cmd+C and Ctrl/Cmd+X only take over when the terminal actually has a selection, because
 *   `^C` is how a user interrupts a build.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clipboardKeyAction,
  copySelection,
  cutSelection,
  pasteClipboard,
  type ClipboardPort,
  type TerminalSelection,
} from "../src/ui/terminal-clipboard";

const SELECTED = "bravo charlie delta";

interface TerminalSpy extends TerminalSelection {
  readonly calls: string[];
  readonly pasted: string[];
}

function fakeTerminal(selection: string): TerminalSpy {
  const calls: string[] = [];
  const pasted: string[] = [];
  return {
    calls,
    pasted,
    getSelection: () => {
      calls.push("getSelection");
      return selection;
    },
    clearSelection: () => {
      calls.push("clearSelection");
    },
    paste: (text: string) => {
      calls.push("paste");
      pasted.push(text);
    },
    focus: () => {
      calls.push("focus");
    },
  };
}

interface PortSpy extends ClipboardPort {
  readonly written: string[];
}

function fakePort(text = ""): PortSpy {
  const written: string[] = [];
  return {
    written,
    readText: async () => text,
    writeText: async (value: string) => {
      written.push(value);
    },
  };
}

/** Set while a test wants to prove the document's selection is never read. */
let domReads: string[];

beforeEach(() => {
  domReads = [];
  const boobyTrap = (name: string) => () => {
    domReads.push(name);
    return "THE WHOLE TERMINAL PANEL";
  };
  vi.stubGlobal("window", { getSelection: boobyTrap("window.getSelection") });
  vi.stubGlobal("document", { getSelection: boobyTrap("document.getSelection") });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copySelection", () => {
  it("writes exactly the terminal's selection — and never the document's", async () => {
    const terminal = fakeTerminal(SELECTED);
    const port = fakePort();

    const result = await copySelection(terminal, port);

    expect(result).toEqual({
      ok: true,
      text: SELECTED,
      notice: `Copied ${String(SELECTED.length)} characters.`,
    });
    expect(port.written).toEqual([SELECTED]);
    expect(port.written[0]).not.toBe("THE WHOLE TERMINAL PANEL");
    // The document's selection is never consulted: that read is what put the pane on the
    // clipboard in the first place.
    expect(domReads).toEqual([]);
  });

  it("gives the keyboard back to the shell after acting", async () => {
    const terminal = fakeTerminal(SELECTED);

    await copySelection(terminal, fakePort());

    expect(terminal.calls.at(-1)).toBe("focus");
  });

  it("refuses to invent a selection when nothing is selected", async () => {
    const terminal = fakeTerminal("");
    const port = fakePort();

    const result = await copySelection(terminal, port);

    expect(result).toMatchObject({ ok: false, reason: "empty" });
    expect(port.written).toEqual([]);
    expect(domReads).toEqual([]);
  });

  it("says why when there is no shell, no clipboard API, or a refused write", async () => {
    expect(await copySelection(null, fakePort())).toMatchObject({ ok: false, reason: "no-shell" });
    expect(await copySelection(fakeTerminal(SELECTED), null)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });

    const refusing: ClipboardPort = {
      readText: async () => "",
      writeText: async () => {
        throw new Error("Denied by the user agent");
      },
    };
    const refused = await copySelection(fakeTerminal(SELECTED), refusing);
    expect(refused).toMatchObject({ ok: false, reason: "refused" });
    expect(refused.ok === false && refused.notice).toContain("Denied by the user agent");
  });
});

describe("cutSelection", () => {
  it("copies first and only then clears the highlight", async () => {
    const terminal = fakeTerminal(SELECTED);
    const port = fakePort();

    const result = await cutSelection(terminal, port);

    expect(port.written).toEqual([SELECTED]);
    expect(terminal.calls).toEqual(["getSelection", "clearSelection", "focus"]);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.notice).toContain("cleared the selection");
    expect(domReads).toEqual([]);
  });

  it("does not clear a highlight it did not copy", async () => {
    const terminal = fakeTerminal("");

    const result = await cutSelection(terminal, fakePort());

    expect(result).toMatchObject({ ok: false, reason: "empty" });
    expect(terminal.calls).not.toContain("clearSelection");
  });
});

describe("pasteClipboard", () => {
  it("writes the clipboard into the one terminal it was handed", async () => {
    const active = fakeTerminal("");
    const other = fakeTerminal("");

    const result = await pasteClipboard(active, fakePort("PASTE-ME"));

    expect(result).toMatchObject({ ok: true, text: "PASTE-ME", notice: "Pasted 8 characters." });
    expect(active.pasted).toEqual(["PASTE-ME"]);
    expect(other.pasted).toEqual([]);
    expect(active.calls.at(-1)).toBe("focus");
    expect(domReads).toEqual([]);
  });

  it("refuses an empty clipboard instead of pasting nothing", async () => {
    const terminal = fakeTerminal("");

    const result = await pasteClipboard(terminal, fakePort(""));

    expect(result).toMatchObject({ ok: false, reason: "empty" });
    expect(terminal.pasted).toEqual([]);
  });

  it("reports a missing API, a refused read and a refused write", async () => {
    expect(await pasteClipboard(fakeTerminal(""), null)).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(await pasteClipboard(null, fakePort("x"))).toMatchObject({
      ok: false,
      reason: "no-shell",
    });

    const unreadable: ClipboardPort = {
      readText: async () => {
        throw new Error("Clipboard read blocked");
      },
      writeText: async () => undefined,
    };
    const refusedRead = await pasteClipboard(fakeTerminal(""), unreadable);
    expect(refusedRead).toMatchObject({ ok: false, reason: "refused" });
    expect(refusedRead.ok === false && refusedRead.notice).toContain("Clipboard read blocked");

    const throwing = fakeTerminal("");
    throwing.paste = () => {
      throw new Error("pty is gone");
    };
    const refusedWrite = await pasteClipboard(throwing, fakePort("x"));
    expect(refusedWrite).toMatchObject({ ok: false, reason: "refused" });
    expect(refusedWrite.ok === false && refusedWrite.notice).toContain("pty is gone");
  });
});

describe("clipboardKeyAction", () => {
  it("takes over Ctrl/Cmd+C and Ctrl/Cmd+X only when there is a selection", () => {
    expect(clipboardKeyAction("c", true, SELECTED)).toBe("copy");
    expect(clipboardKeyAction("C", true, SELECTED)).toBe("copy");
    expect(clipboardKeyAction("x", true, SELECTED)).toBe("cut");
    expect(clipboardKeyAction("X", true, SELECTED)).toBe("cut");
  });

  it("leaves the interrupt alone when nothing is selected", () => {
    // `^C` with no selection must reach the pty, or a user cannot stop a build.
    expect(clipboardKeyAction("c", true, "")).toBe("passthrough");
    expect(clipboardKeyAction("x", true, "")).toBe("passthrough");
  });

  it("does not touch plain keys, paste, or other modified keys", () => {
    expect(clipboardKeyAction("c", false, SELECTED)).toBe("passthrough");
    expect(clipboardKeyAction("a", true, SELECTED)).toBe("passthrough");
    // Paste stays with xterm's own paste event: the browser's paste needs no permission,
    // `navigator.clipboard.readText()` does.
    expect(clipboardKeyAction("v", true, SELECTED)).toBe("passthrough");
  });
});
