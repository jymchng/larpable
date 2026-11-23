/**
 * The terminal's extra keys and sticky modifiers, as pure data and pure functions.
 *
 * A phone and a touch-screen laptop have no `Ctrl` key, and even on a desk the guest's
 * shell needs keys a soft keyboard does not offer: `ESC` to leave vi's insert mode, `TAB`
 * for completion, arrows for history and cursor movement. So the pane grows a key bar.
 *
 * The logic lives here rather than inside the component for one reason: `Ctrl-C` is the
 * difference between interrupting a runaway build and doing nothing, and that mapping is
 * worth a test that runs without xterm, a pty, or a booted kernel. `terminal-panel.tsx`
 * owns pixels; this file owns bytes.
 *
 * ## Sticky, not held
 *
 * A touch screen cannot hold two keys at once, so `CTRL` and `ALT` are *sticky*: pressing
 * one arms it, the next character is transformed, and both modifiers disarm. That is the
 * same interaction mobile terminal emulators use, and it makes `Ctrl-C` two taps
 * (`CTRL`, `c`) instead of an impossible chord.
 */

/** The modifiers that can be armed. */
export type StickyModifier = "ctrl" | "alt";

export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
}

export const NO_MODIFIERS: ModifierState = { ctrl: false, alt: false };

export interface KeyDefinition {
  /** Stable id, used for `data-testid` and for the toggle logic. */
  id: string;
  /** What the keycap shows. Arrow keys show the arrow itself. */
  label: string;
  /** Bytes written to the pty when the key is tapped. Empty for a sticky modifier. */
  sequence: string;
  /** The accessible name: a glyph like `↑` says nothing to a screen reader. */
  description: string;
  /** Set for a sticky modifier: tapping it arms the next character instead of sending. */
  modifier?: StickyModifier;
}

/**
 * The key row, in order.
 *
 * The arrow sequences are xterm's `ESC [ A`-style (CSI) forms, which is what a real
 * terminal sends; sending `^[[A` as visible text would not work, and sending nothing would
 * make the keys decorative.
 */
export const TERMINAL_KEYS: readonly KeyDefinition[] = [
  {
    id: "ctrl",
    label: "CTRL",
    sequence: "",
    description: "Control (sticky): the next character is sent as a control code, so CTRL then C is Ctrl-C",
    modifier: "ctrl",
  },
  {
    id: "alt",
    label: "ALT",
    sequence: "",
    description: "Alt (sticky): the next character is sent with an ESC prefix, as a real terminal does",
    modifier: "alt",
  },
  { id: "esc", label: "ESC", sequence: "\u001b", description: "Escape (cancel, or leave insert mode)" },
  { id: "tab", label: "TAB", sequence: "\t", description: "Tab (completion)" },
  { id: "up", label: "↑", sequence: "\u001b[A", description: "Up arrow (previous command)" },
  { id: "down", label: "↓", sequence: "\u001b[B", description: "Down arrow (next command)" },
  { id: "right", label: "→", sequence: "\u001b[C", description: "Right arrow (move the cursor)" },
  { id: "left", label: "←", sequence: "\u001b[D", description: "Left arrow (move the cursor)" },
];

/** Arm or disarm one modifier, leaving the other alone. */
export function toggleModifier(state: ModifierState, modifier: StickyModifier): ModifierState {
  return modifier === "ctrl" ? { ...state, ctrl: !state.ctrl } : { ...state, alt: !state.alt };
}

export function hasModifiers(state: ModifierState): boolean {
  return state.ctrl || state.alt;
}

/**
 * The control code for one printable character, or null when it has none.
 *
 * The rule every terminal uses: `@`–`_` (which includes `A`–`Z`) map to `0x00`–`0x1f` by
 * clearing bit 5, so `c` → `0x03` (ETX, "interrupt") and `d` → `0x04` (EOT). `?` is the
 * exception everyone relies on: `Ctrl-?` sends DEL (`0x7f`), not `0x1f`.
 */
export function controlCodeFor(char: string): string | null {
  if (char === "?") return "\u007f";
  const upper = char.toUpperCase();
  if (upper.length !== 1) return null;
  const code = upper.charCodeAt(0);
  if (code < 0x40 || code > 0x5f) return null;
  return String.fromCharCode(code & 0x1f);
}

/**
 * What to send for `data` typed into the terminal while modifiers are armed.
 *
 * `consumed` is the modifier state *after* the keystroke: an armed modifier is one-shot, so
 * it is cleared when it changed the bytes, and left alone when it could not (there is no
 * `Ctrl` form of `€` — silently dropping the character would be worse than sending it).
 *
 * Multi-character input is always passed through untouched. That is what makes paste safe:
 * the clipboard arrives as one chunk, and turning the first character of a pasted file into
 * a control code because `CTRL` happened to be armed is exactly the kind of bug a user
 * would never diagnose.
 */
export function encodeModifiedInput(
  data: string,
  state: ModifierState,
): { data: string; consumed: ModifierState } {
  if (data.length === 0 || !hasModifiers(state)) return { data, consumed: state };
  if (data.length !== 1) return { data, consumed: state };

  let out = data;
  if (state.ctrl) {
    const code = controlCodeFor(data);
    if (code === null) return { data, consumed: state };
    out = code;
  }
  if (state.alt) out = `\u001b${out}`;
  return { data: out, consumed: NO_MODIFIERS };
}
