/**
 * The resizable split, as arithmetic rather than as a component.
 *
 * A drag handle is the kind of feature that looks trivial and then traps the pointer: a
 * percentage below zero, a split so narrow that the pane's own toolbar overflows, a keyboard
 * user with no way to move it. So the rules are here, pure, and the component only feeds them
 * a pointer position and renders the result.
 *
 * The bounds are 20/80 rather than 5/95 on purpose: the agent pane has a prompt input and the
 * preview pane has a toolbar, and both become unusable below a fifth of the window. A
 * preference outside the bounds is *clamped*, not rejected — a stored 5 % from a previous
 * layout should open at 20 %, not refuse to restore.
 */

/** The narrowest a pane may be, in percent of the split container. */
export const MIN_SPLIT = 20;

export function clampSplit(percent: number): number {
  if (!Number.isFinite(percent)) return 50;
  return Math.min(100 - MIN_SPLIT, Math.max(MIN_SPLIT, percent));
}

/**
 * Where the divider should be for a pointer at `x` in a container starting at `left`.
 *
 * A zero-width container (the pane was collapsed, or the layout is not measured yet) answers
 * 50 %, because dividing by zero would answer `NaN` and put the handle nowhere.
 */
export function splitFromPointer(x: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 50;
  return clampSplit(((x - left) / width) * 100);
}

/** The CSS `grid-template-columns` value for a split, both sides `minmax(0, …)` so they can shrink. */
export function splitGridTemplate(percent: number): string {
  const left = clampSplit(percent);
  return `minmax(0, ${left.toFixed(2)}fr) minmax(0, ${(100 - left).toFixed(2)}fr)`;
}

/** How far one arrow key moves the divider. Shift is the coarse step. */
export const SPLIT_KEY_STEP = 2;
export const SPLIT_KEY_STEP_COARSE = 10;

/**
 * The split after a key press, or null when the key is not one this control owns.
 *
 * `Home`/`End` jump to the bounds instead of to 0/100: the control's own `aria-valuemin`/
 * `aria-valuemax` are the honest limits, and a key that goes outside them would make the
 * announced value a lie.
 */
export function splitAfterKey(
  percent: number,
  key: string,
  options: { shift?: boolean; rtl?: boolean } = {},
): number | null {
  const step = options.shift === true ? SPLIT_KEY_STEP_COARSE : SPLIT_KEY_STEP;
  // In a right-to-left layout the pane on the "start" side is on the right, so the arrows
  // that grow it are reversed. Ignoring this is how a keyboard user in Arabic or Hebrew finds
  // the handle moving the wrong way.
  const direction = options.rtl === true ? -1 : 1;
  switch (key) {
    case "ArrowLeft":
      return clampSplit(percent - step * direction);
    case "ArrowRight":
      return clampSplit(percent + step * direction);
    case "Home":
      return MIN_SPLIT;
    case "End":
      return 100 - MIN_SPLIT;
    default:
      return null;
  }
}
