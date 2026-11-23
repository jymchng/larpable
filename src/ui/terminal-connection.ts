/**
 * The terminal's connection state, as data rather than as a dot.
 *
 * The panel used to paint one `StatusDot` in its own header (user request: "remove the green dot
 * from the terminal panel and move its information into the debug popover"). That dot was the only
 * green in the terminal's near-black strip, which made it read as a decoration of *this* pane
 * rather than as a fact about the machine — and it was invisible from the other pane, which is
 * exactly when "is my shell attached?" is worth asking. The fact lives in the debug popover now,
 * beside the other six.
 *
 * The state and its vocabulary are here, in a module with no React and no xterm, for the same
 * reason `build-state.ts` exists: the mapping is the contract, and `status-bar.ts` must be able to
 * read it without importing a component that pulls in a terminal emulator. `terminal-panel.tsx`
 * owns the states; this file owns what they are called and what colour they are.
 */

import type { StatusTone } from "@/ui/components/status-dot";

/**
 * Every state a shell can be in.
 *
 * `waiting` is "the panel exists and has not asked the guest for a shell yet"; `ended` is a shell
 * that ran and exited; `error` is one that never attached.
 */
export type Connection = "waiting" | "connecting" | "connected" | "ended" | "error";

/**
 * What the debug popover shows for the terminal.
 *
 * `connection` is null when no shell is open at all, which is a different fact from `waiting`:
 * the panel has no tabs, so there is nothing to attach.
 */
export interface TerminalStatus {
  /** How many shell tabs the panel holds. */
  readonly shells: number;
  /** The *active* tab's connection, or null when no shell is open. */
  readonly connection: Connection | null;
  /** The guest's own words when the active shell failed, if it has any. */
  readonly error: string | null;
}

/** Before the panel has opened anything: no tabs, nothing to describe. */
export const NO_TERMINAL: TerminalStatus = { shells: 0, connection: null, error: null };

/**
 * The terminal's connection state with the words that go beside it.
 *
 * A state that is not `connected` must never paint green, and `error` must never paint anything
 * but red. The component test asserts every case, so a new `Connection` member cannot compile
 * without a decision here (the switch is exhaustive and the return type is checked).
 */
export function describeConnection(connection: Connection): {
  label: string;
  tone: StatusTone;
} {
  switch (connection) {
    case "connected":
      return { label: "Connected", tone: "green" };
    case "connecting":
      return { label: "Connecting", tone: "amber" };
    case "ended":
      return { label: "Exited", tone: "grey" };
    case "error":
      return { label: "Failed", tone: "red" };
    case "waiting":
      return { label: "Not connected", tone: "grey" };
  }
}
