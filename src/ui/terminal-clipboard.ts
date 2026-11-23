/**
 * The terminal's clipboard actions, as functions that cannot lie about what they read.
 *
 * The panel used to hold this logic inline, next to `navigator.clipboard` and a live xterm, which
 * made one question impossible to answer from a test: *what does Copy copy?* The user reported
 * that Copy / Paste / Cut "always acts on all the content of the terminal panel", and the
 * measured answer is that the browser's own copy path does exactly that — a `copy` event whose
 * target is outside the terminal copies the **DOM** selection, and the pane's DOM includes a
 * screen-reader mirror of the whole transcript (`data-testid="terminal-output"`), the prompt, and
 * the header text.
 *
 * So the text a clipboard action may touch is a parameter here, not a lookup:
 *
 * - Copy and Cut take a `getSelection()` and copy *that string*, never a selection read from the
 *   document. There is no `window` in this module, so a caller cannot even reach for it.
 * - Paste writes into the one terminal it was handed — the active tab — so a second shell cannot
 *   receive the text.
 * - Every outcome is a value (`ok` or a named reason with the sentence to show), so the pane can
 *   report a refused permission instead of appearing to work.
 *
 * Tests: `tests/terminal-clipboard.test.ts`.
 */

/** The clipboard API this module needs; `navigator.clipboard` satisfies it. */
export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

/** The slice of a terminal the actions touch. xterm's `Terminal` satisfies it. */
export interface TerminalSelection {
  getSelection(): string;
  clearSelection(): void;
  paste(text: string): void;
  focus(): void;
}

export type ClipboardFailure = "no-shell" | "empty" | "unavailable" | "refused";

export type ClipboardResult =
  | { ok: true; text: string; notice: string }
  | { ok: false; reason: ClipboardFailure; notice: string };

/** The message for a context with no clipboard API at all (plain http, an old browser). */
function unavailable(verb: "copy" | "paste", reason: ClipboardFailure = "unavailable"): ClipboardResult {
  return {
    ok: false,
    reason,
    notice: `This browser exposes no clipboard API here (it needs https or localhost), so ${verb} is unavailable.`,
  };
}

function refusal(verb: "copy" | "paste", cause: unknown): ClipboardResult {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return { ok: false, reason: "refused", notice: `The browser refused the ${verb}: ${detail}` };
}

const NOTHING_SELECTED: ClipboardResult = {
  ok: false,
  reason: "empty",
  notice: "Nothing is selected: drag across the terminal text first.",
};

/**
 * Copy the terminal's own selection.
 *
 * The only text this function can write is the string `source.getSelection()` returns: the
 * document's selection is not consulted, so a drag that wandered out of the terminal (and
 * picked up the pane's transcript mirror) cannot end up on the clipboard through this path.
 */
export async function copySelection(
  source: TerminalSelection | null,
  port: ClipboardPort | null,
): Promise<ClipboardResult> {
  if (source === null) {
    return { ok: false, reason: "no-shell", notice: "Open a shell first: there is nothing to copy from." };
  }
  if (port === null) return unavailable("copy");

  const text = source.getSelection();
  if (text.length === 0) return NOTHING_SELECTED;

  try {
    await port.writeText(text);
  } catch (cause) {
    return refusal("copy", cause);
  }
  // The click that ran this lives outside the terminal, so give the keyboard back to the shell:
  // measured, every header button otherwise leaves focus on the button and the next keystroke
  // goes nowhere.
  source.focus();
  return { ok: true, text, notice: `Copied ${String(text.length)} characters.` };
}

/**
 * Cut: copy, then drop the highlight.
 *
 * A terminal has no cut — the scrollback is the guest's output and no browser can delete a line
 * from it — so the notice says what actually happened rather than implying the text was removed.
 */
export async function cutSelection(
  source: TerminalSelection | null,
  port: ClipboardPort | null,
): Promise<ClipboardResult> {
  if (source === null) {
    return { ok: false, reason: "no-shell", notice: "Open a shell first: there is nothing to cut from." };
  }
  if (port === null) return unavailable("copy");

  const text = source.getSelection();
  if (text.length === 0) return NOTHING_SELECTED;

  try {
    await port.writeText(text);
  } catch (cause) {
    return refusal("copy", cause);
  }
  // Clear before focusing: the highlight goes, the shell gets the keyboard back.
  source.clearSelection();
  source.focus();
  return {
    ok: true,
    text,
    notice: `Copied ${String(text.length)} characters and cleared the selection (the shell's scrollback is untouched).`,
  };
}

/**
 * Paste the clipboard into one terminal — the active tab, as handed in.
 *
 * `source.paste()` runs the text through the terminal, so it reaches the pty exactly as a typed
 * paste would (line endings normalised, bracketed-paste mode honoured).
 */
export async function pasteClipboard(
  source: TerminalSelection | null,
  port: ClipboardPort | null,
): Promise<ClipboardResult> {
  if (source === null) {
    return { ok: false, reason: "no-shell", notice: "Open a shell first: there is nothing to paste into." };
  }
  if (port === null) return unavailable("paste");

  let text: string;
  try {
    text = await port.readText();
  } catch (cause) {
    return refusal("paste", cause);
  }
  if (text.length === 0) {
    return { ok: false, reason: "empty", notice: "The clipboard is empty." };
  }

  try {
    source.paste(text);
  } catch (cause) {
    return refusal("paste", cause);
  }
  source.focus();
  return { ok: true, text, notice: `Pasted ${String(text.length)} characters.` };
}

export type ClipboardKeyAction = "copy" | "cut" | "passthrough";

/**
 * What Ctrl/Cmd + C or X should do, given what the terminal has selected.
 *
 * A copy shortcut is *also* the terminal's interrupt (`^C`), so the rule cannot be "always
 * copy": with nothing selected the key must reach the pty untouched — that is how a user stops a
 * build. With a selection the browser's default would copy the DOM selection (the pane, not the
 * terminal), so the panel handles it itself and stops the event.
 *
 * V is deliberately not here: xterm's own paste event already writes into the pty, and
 * re-implementing it through `navigator.clipboard.readText()` would need a permission the
 * browser's paste does not.
 */
export function clipboardKeyAction(
  key: string,
  modified: boolean,
  selection: string,
): ClipboardKeyAction {
  if (!modified) return "passthrough";
  if (selection.length === 0) return "passthrough";
  const normalised = key.toLowerCase();
  if (normalised === "c") return "copy";
  if (normalised === "x") return "cut";
  return "passthrough";
}
