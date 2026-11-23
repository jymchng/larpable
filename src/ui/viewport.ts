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
    note: "Fills the pane at your window's size.",
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

/** One sentence for the toolbar's status line, so the claim is written down. */
export function describeViewport(preset: ViewportPreset): string {
  return preset.width === null
    ? `${preset.label}: ${preset.note}`
    : `${preset.label}: ${preset.note} Sizes the frame only — no touch events or device pixel ratio.`;
}
