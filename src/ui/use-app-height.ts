/**
 * `100dvh` is not quite enough on a phone, so this measures the viewport the browser is really
 * showing and hands the number to the shell.
 *
 * `dvh` fixed the old problem (a `100vh` page whose bottom sat under the URL bar); it did not fix
 * the keyboard. On iOS Safari the visual viewport shrinks when the prompt box is focused, while
 * the layout viewport \u2014 and therefore `dvh` \u2014 often keeps its height, so the composer ends up
 * below the keyboard exactly when the user is typing in it. `window.visualViewport.height` is the
 * one number that tracks what the user can actually see, so this hook returns it and the app's
 * root sets its height from it: the shell stays glued to the visible area without any per-panel
 * arithmetic.
 *
 * The fallback matters as much as the measurement: with no `visualViewport` (older browsers, and
 * every server render) the hook returns null, the caller keeps `100dvh`, and the layout is
 * exactly what it was before this file existed. `appHeight` is separated out so the decision is
 * testable without a window \u2014 which is the only way to test it in this suite.
 */

import { useEffect, useState } from "react";

/**
 * The height to use, in CSS pixels, or null to leave the stylesheet's `100dvh` alone.
 *
 * A visual viewport of 0 (a hidden tab, a transitional resize) and a non-finite number both come
 * back as "no news": writing them would shrink the shell to nothing for a frame. A visual
 * viewport taller than the layout viewport is clamped, because the shell must never claim more
 * room than the document has.
 */
export function appHeight(
  visualViewportHeight: number | null | undefined,
  layoutHeight: number,
): number | null {
  if (typeof visualViewportHeight !== "number" || !Number.isFinite(visualViewportHeight)) return null;
  if (visualViewportHeight <= 0) return null;
  if (!Number.isFinite(layoutHeight) || layoutHeight <= 0) return null;
  return Math.round(Math.min(visualViewportHeight, layoutHeight));
}

/**
 * The visible height in CSS pixels, or null until there is something to say.
 *
 * Returning null for the first paint is deliberate: the first frame uses the stylesheet's `dvh`,
 * so there is no flash of a zero-height shell while the effect measures.
 */
export function useAppHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewport = window.visualViewport ?? null;
    const measure = (): void => {
      setHeight(appHeight(viewport?.height ?? null, window.innerHeight));
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
