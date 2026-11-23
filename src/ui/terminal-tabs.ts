/**
 * The terminal's tabs: what "new shell" and "close" mean, as pure functions.
 *
 * A terminal pane that can only ever hold one shell makes the "+" button a lie: pressing it
 * kills the session you were reading. So a shell lives in a tab, "+" opens another one, and
 * the × on a tab closes that tab's shell (and only that one — its pty is closed when the tab
 * unmounts, which is why the *set* of tabs is the state and the sessions hang off it).
 *
 * The selection rules are here rather than in the component because they are the part a
 * user notices when they are wrong: closing the active tab must leave you looking at a
 * neighbouring shell, not at an empty pane, and closing the last tab must leave *nothing*
 * selected rather than a dangling id that points at a session that no longer exists.
 */

export interface ShellTab {
  /** Stable id, also the React key. Never reused, so a closed tab cannot be resurrected. */
  id: string;
  /** What the tab shows: `Shell 1`, `Shell 2`, … */
  label: string;
}

export interface AddTabResult {
  tabs: ShellTab[];
  tab: ShellTab;
  /** The number to use for the *next* tab. Monotonic, so labels never collide. */
  nextNumber: number;
}

/**
 * Append a tab.
 *
 * `nextNumber` is passed in and returned rather than derived from `tabs.length`: after
 * closing `Shell 1` of two, a length-derived label would produce a second `Shell 2`.
 */
export function addTab(tabs: readonly ShellTab[], nextNumber: number): AddTabResult {
  const tab: ShellTab = { id: `shell-${String(nextNumber)}`, label: `Shell ${String(nextNumber)}` };
  return { tabs: [...tabs, tab], tab, nextNumber: nextNumber + 1 };
}

export interface CloseTabResult {
  tabs: ShellTab[];
  /** The tab to show next, or null when none are left. */
  activeId: string | null;
}

/**
 * Remove one tab and decide what stays selected.
 *
 * Closing a tab that is not active leaves the selection alone. Closing the active one moves
 * to its left neighbour, or to the first remaining tab when it was leftmost — the behaviour
 * a browser does, so the user does not have to re-find their shell.
 */
export function closeTab(
  tabs: readonly ShellTab[],
  id: string,
  activeId: string | null,
): CloseTabResult {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index === -1) return { tabs: [...tabs], activeId };

  const remaining = tabs.filter((tab) => tab.id !== id);
  if (activeId !== id) return { tabs: remaining, activeId };

  if (remaining.length === 0) return { tabs: remaining, activeId: null };
  const neighbour = remaining[Math.max(0, index - 1)];
  return { tabs: remaining, activeId: neighbour?.id ?? null };
}

/** The tab to render as active, tolerating an id that no longer exists. */
export function activeTabOf(
  tabs: readonly ShellTab[],
  activeId: string | null,
): ShellTab | null {
  if (tabs.length === 0) return null;
  return tabs.find((tab) => tab.id === activeId) ?? tabs[tabs.length - 1] ?? null;
}
