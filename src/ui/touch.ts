/**
 * The phone's hit target, in one place.
 *
 * A 32 px button is comfortable under a mouse and an error under a thumb: a fingertip's contact
 * patch is roughly 10 mm, which at a typical phone's ~160 dpi is about 40 CSS px, and WCAG 2.5.5
 * asks for 44. The desktop rows in this app were built around 32 px (`size-8`) because they sit
 * in dense toolbars two pixels apart, and that is still right on a laptop \u2014 so the rule is
 * *responsive*: 32 px from `lg` up, 44 px below it. Both numbers live in exactly one string each,
 * used by the components and asserted by the tests.
 *
 * Why a constant instead of writing `max-lg:size-11` in nine components: the number is a
 * requirement, and a requirement that is copied is a requirement that drifts. `size-11` is
 * 11 x 0.25rem = 2.75rem = 44 px at a 16 px root, which is where `TOUCH_TARGET_MIN_PX` comes
 * from \u2014 the browser's audit in `scripts/mobile-acceptance.ts` (`bun run acceptance:mobile`) re-measures the rendered
 * rectangles, so the arithmetic is checked, not assumed.
 */

/** WCAG 2.5.5 (AAA) target size, and the floor for every control below the laptop breakpoint. */
export const TOUCH_TARGET_MIN_PX = 44;

/** Tailwind's spacing scale: 1 unit = 0.25rem = 4 px, so 11 units are 44 px. */
export const TOUCH_TARGET_SPACING_UNITS = 11;

/** A square icon button: 44 x 44 below `lg`, the caller's own size above it. */
export const TOUCH_TARGET_ICON = "max-lg:size-11";

/** A control with words in it: 44 px tall below `lg`, its text size above. */
export const TOUCH_TARGET_BLOCK = "max-lg:min-h-11";

/** The measured edge a control must reach to count as touch-friendly. */
export function meetsTouchTarget(widthPx: number, heightPx: number): boolean {
  return widthPx >= TOUCH_TARGET_MIN_PX && heightPx >= TOUCH_TARGET_MIN_PX;
}
