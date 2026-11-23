/**
 * The phone's hit target, in one place.
 *
 * A 32 px button is comfortable under a mouse and an error under a thumb: a fingertip's contact
 * patch is roughly 10 mm, which at a typical phone's ~160 dpi is about 40 CSS px, and WCAG 2.5.5
 * asks for 44. The desktop rows in this app were built around 32 px (`size-8`) because they sit
 * in dense toolbars two pixels apart, and that is still right on a laptop.
 *
 * What was *wrong* — and made every phone toolbar look inflated — is that the old rule grew the
 * painted box to 44 px (`max-lg:size-11`), so the visual size idled at the requirement instead of
 * sitting under it. The requirement is the *hit* area. So on a phone a control paints at 36 px
 * (`size-9`, `min-h-9`) and carries `tap-target`, a `::after` that adds 4 px of transparent,
 * clickable margin on every side: 44 x 44 of live area, 36 x 36 of ink. `bun run acceptance:mobile`
 * probes `document.elementFromPoint` at the edges of that 44 px box, so the claim is checked by a
 * browser rather than by this comment.
 *
 * Why a constant instead of writing the classes in nine components: the number is a requirement,
 * and a requirement that is copied is a requirement that drifts.
 */

/** WCAG 2.5.5 (AAA) target size, and the floor for every control below the laptop breakpoint. */
export const TOUCH_TARGET_MIN_PX = 44;

/**
 * What a phone control *paints* at. The 8 px difference to `TOUCH_TARGET_MIN_PX` is what
 * `tap-target` gives back as invisible, clickable margin (4 px per side).
 */
export const TOUCH_TARGET_VISUAL_PX = 36;

/** Tailwind's spacing scale: 1 unit = 0.25rem = 4 px, so 11 units are the 44 px floor. */
export const TOUCH_TARGET_SPACING_UNITS = 11;

/** And 9 units are the 36 px a phone control paints at. */
export const TOUCH_TARGET_VISUAL_UNITS = 9;

/** The transparent margin `::after` adds to each side: (44 − 36) / 2. */
export const TOUCH_TARGET_HIT_MARGIN_PX = (TOUCH_TARGET_MIN_PX - TOUCH_TARGET_VISUAL_PX) / 2;

/** The utility that turns the painted box into a full-size hit box (see `globals.css`). */
export const TOUCH_TARGET_HIT_AREA = "tap-target";

/** A square icon button: 36 px of ink below `lg`, 44 px of hit area, the caller's size above. */
export const TOUCH_TARGET_ICON = `max-lg:size-${String(TOUCH_TARGET_VISUAL_UNITS)} ${TOUCH_TARGET_HIT_AREA}`;

/** A control with words in it: 36 px tall below `lg`, 44 px of hit area, its text size above. */
export const TOUCH_TARGET_BLOCK = `max-lg:min-h-${String(TOUCH_TARGET_VISUAL_UNITS)} ${TOUCH_TARGET_HIT_AREA}`;

/** The measured edge a control's *hit* area must reach to count as touch-friendly. */
export function meetsTouchTarget(widthPx: number, heightPx: number): boolean {
  return widthPx >= TOUCH_TARGET_MIN_PX && heightPx >= TOUCH_TARGET_MIN_PX;
}
