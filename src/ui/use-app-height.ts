/**
 * `100dvh` is not quite enough on a phone, so this measures the viewport the browser is really
 * showing and hands it to the layout.
 *
 * `dvh` fixed the old problem (a `100vh` page whose bottom sat under the URL bar); it did not fix
 * the keyboard. On iOS Safari the visual viewport shrinks when the prompt box is focused, while
 * the layout viewport \u2014 and therefore `dvh` \u2014 often keeps its height, so the composer ends up
 * below the keyboard exactly when the user is typing in it. `window.visualViewport.height` is the
 * one number that tracks what the user can actually see, so this hook publishes it as a CSS
 * variable and the app's root reads it (`height: var(--app-height, 100dvh)`), which keeps the
 * shell glued to the visible area without any per-panel arithmetic.
 *
 * The fallback matters as much as the measurement: with no `visualViewport` (older browsers, and
 * every server render) nothing is written, the CSS default `100dvh` applies, and the layout is
 * exactly what it was before this file existed. `appHeight` is separated out so the decision is
 * testable without a window \u2014 which is the only way to test it in this suite.
 */

import { useEffect, useState } from "react";

/**
 * The height to use, in CSS pixels, or null to leave the stylesheet's `100dvh` alone.
 *
 * A visual viewport of 0 (a hidden tab, a transitional resize) and a value that has not changed
 * by a pixel both come back as "no news": writing them would shrink the shell to nothing for a
 * frame, or re-render on every scroll of the URL bar.
 */
export function appHeight(
  visualViewportHeight: number | null | undefined,
  layoutHeight: number,
): number | null {
  if (typeof visualViewportHeight !== "number" || !Number.isFinite(visualViewportHeight)) return null;
  if (visualViewportHeight <= 0) return null;
  if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
  // The URL bar collapsing makes the visual viewport *taller* than the layout in some versions;
  // the shell should never claim more room than the document has.
  const clamped = Math.min(visualViewportHeight, layoutHeight);
  return Math.round(clamped);
}

/**
 * Publish the visible height as `--app-height`, and return it.
 *
 * Returns null until the first measurement, so the first paint uses the stylesheet's `dvh` and
 * there is no flash of a wrong height.
 */
export function useAppHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewport = window.visualViewport ?? null;
    const measure = (): void => {
      const next = appHeight(viewport?.height ?? null, window.innerHeight);
      setHeight(next);
      const root = document.documentElement;
      if (next === null) root.style.removeProperty("--app-height");
      else root.style.setProperty("--app-height", `${String(next)}px`);
    };
    measure();
    // `resize` covers the keyboard and rotation; `scroll` covers iOS moving the visible area
    // instead of resizing it, which it does while the page is scrolled.
    viewport?.addEventListener("resize", measure);
    viewport?.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      viewport?.removeEventListener("resize", measure);
      viewport?.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, []);

  return height;
}
