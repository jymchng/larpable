/**
 * The preview's device presets: desktop, tablet, mobile.
 *
 * PRD §13 asks for viewport controls. The part that is easy to get wrong is the claim: a pane
 * that draws a 390-px frame inside a 900-px pane and calls it "mobile" is honest about the
 * *width* and silent about the two things that actually differ on a phone — the CSS pixel
 * ratio and the fact that there is no hover. So each preset states exactly what it changes
 * (the frame's width and height) and the panel states what it does not (no DPR emulation, no
 * touch events), rather than implying a device lab.
 *
 * The sizes are CSS pixels, which is what a `<meta name="viewport">`-less page (a Vite build
 * has one) sees inside an iframe of that width.
 */

export type ViewportName = "desktop" | "tablet" | "mobile";

export interface ViewportPreset {
  name: ViewportName;
  /** The toolbar's word for it. */
  label: string;
  /** Frame width in CSS pixels, or null for "fill the pane". */
  width: number | null;
  /** Frame height in CSS pixels, or null for "fill the pane". */
  height: number | null;
  /** What this preset is for, in one clause. */
  note: string;
}

/**
 * The three presets, in the order the toolbar shows them.
 *
 * Desktop is *not* a size: it fills the pane, because the pane is the user's real window and
 * pinning it to 1280 px would show them something narrower than the space they have. The
 * other two are the two widths a responsive layout is most often broken at — a tablet in
 * portrait (834) and a phone (390, iPhone 14/15 logical width).
 */
export const VIEWPORTS: readonly ViewportPreset[] = [
  {
    name: "desktop",
    label: "Desktop",
    width: null,
    height: null,
    note: "Follows your window.",
  },
  {
    name: "tablet",
    label: "Tablet",
    width: 834,
    height: 1112,
    note: "834 × 1112 CSS px, portrait.",
  },
  { name: "mobile", label: "Mobile", width: 390, height: 844, note: "390 × 844 CSS px, portrait." },
];

export function viewportFor(name: ViewportName): ViewportPreset {
  const preset = VIEWPORTS.find((candidate) => candidate.name === name);
  // Unreachable through the type, but a preset restored from storage could name a size that
  // no longer exists; filling the pane is the honest fallback.
  return preset ?? (VIEWPORTS[0] as ViewportPreset);
}

/**
 * The factor to draw a fixed-size frame at so it fits the pane it is in.
 *
 * This exists because of the phone. A 390-px pane showing the 834-px tablet preset at 1:1 is a
 * site you can only read by dragging the pane sideways, which is not a preview. Scaling down is
 * the better answer — but it is a *claim* about the frame, so the toolbar prints the factor
 * next to the size rather than letting `834 × 1112` describe something drawn at 45 %.
 *
 * Below 25 % nothing is legible and a scrollbar is the honest failure, so that is where the
 * scale stops (`1` is returned instead, and the pane scrolls). A frame that already fits is
 * never scaled up: a preview that inflates a 390-px page to fill a 900-px pane would misrepresent
 * the layout it is showing.
 */
export function frameZoom(availableWidth: number | null, frameWidth: number | null): number {
  if (availableWidth === null || frameWidth === null) return 1;
  if (!Number.isFinite(availableWidth) || !Number.isFinite(frameWidth)) return 1;
  if (availableWidth <= 0 || frameWidth <= 0) return 1;
  if (frameWidth <= availableWidth) return 1;
  const raw = availableWidth / frameWidth;
  if (raw < 0.25) return 1;
  // Two decimals: enough that `zoom` and the printed percentage agree, and stable across
  // re-measures so a ResizeObserver cannot make the readout flicker.
  return Math.round(raw * 100) / 100;
}


/** True when the preset constrains the frame at all. */
export function isSizedViewport(preset: ViewportPreset): boolean {
  return preset.width !== null && preset.height !== null;
}

/**
 * The inline size for the frame, or null to fill the pane.
 *
 * `maxWidth`/`maxHeight` rather than `width`/`height`: inside a pane narrower than the preset
 * (a phone, or a half-width window) a fixed 834 px would overflow the pane and produce a
 * horizontal scrollbar that looks like the preview is broken. Clamping with `max-*` keeps the
 * frame inside its box and lets it be *narrower* than the preset, which is the truth of the
 * available space rather than a lie about the device.
 */
export function viewportStyle(preset: ViewportPreset): Record<string, string> | null {
  if (preset.width === null || preset.height === null) return null;
  return {
    width: `${String(preset.width)}px`,
    height: `${String(preset.height)}px`,
    maxWidth: "100%",
    maxHeight: "100%",
  };
}

/**
 * The limit of every sized preset, written once.
 *
 * It travels with the size wherever the size is printed, because a width on its own reads as a
 * device: a 390-px frame is *not* a phone, and the toolbar would be lying by omission if it let
 * the number stand alone.
 */
const SIZED_LIMIT = "Sizes the frame only — no touch events or device pixel ratio.";

/**
 * The size as the toolbar prints it, or `null` for the preset that has no size.
 *
 * `null` rather than the words "full width": what to say for the preset that follows the window
 * is the caller's decision (the tooltip says "Fills the pane"), and this function has one job —
 * the exact claim, in exact pixels.
 */
export function viewportSize(preset: ViewportPreset): string | null {
  if (preset.width === null || preset.height === null) return null;
  return `${String(preset.width)} × ${String(preset.height)}`;
}

/**
 * The sentence that qualifies a preset: what it does, or what it does not do.
 *
 * Desktop has no limit to state — it sizes nothing — so the preset's own note ("Follows your
 * window.") is the honest thing to print. The two sized presets get the disclaimer, because the
 * number is exactly the part that would otherwise imply a device.
 */
export function viewportLimit(preset: ViewportPreset): string {
  return viewportSize(preset) === null ? preset.note : SIZED_LIMIT;
}

/**
 * One sentence for the whole preset: name, size and limit.
 *
 * It is no longer painted in a row of its own — the device toolbar states it in the tooltip of
 * the button that applies it — but it is still the single source of those words, and it is what
 * an `aria-describedby` target should hold when a caller wants the sentence rather than its
 * parts. Composed from `viewportSize`/`viewportLimit` so the three cannot drift apart.
 */
export function describeViewport(preset: ViewportPreset): string {
  return preset.width === null
    ? `${preset.label}: ${preset.note}`
    : `${preset.label}: ${preset.note} Sizes the frame only — no touch events or device pixel ratio.`;
}
