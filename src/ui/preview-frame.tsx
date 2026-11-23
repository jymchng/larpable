/**
 * The preview pane: a sandboxed iframe pointed at the guest's build, wrapped in browser chrome.
 *
 * The iframe is not decoration. Everything before this file is a decision about bytes;
 * this is where those bytes become a document that runs someone else's JavaScript. So the
 * two things that matter here are the `sandbox` attribute and the honesty of the states.
 *
 * ## The sandbox, and the one grant that is not optional
 *
 * Preview URLs live on the app's own origin (`/__preview__/<buildId>/…`), which is what
 * makes relative imports and an SPA router behave exactly as they will on Netlify. The
 * sandbox string itself is `preview/sandbox.ts`, and it *does* include `allow-same-origin`
 * — measured, not preferred: Chromium does not hand a sandboxed iframe's requests to a
 * service worker unless the frame's origin matches the worker's scope, so without it
 * `/__preview__/<id>/` is answered by the dev server with the app's own `index.html` and the
 * frame goes blank. The rationale and the accepted cost (a previewed site shares this
 * origin's storage) live there, with the measurement that forced it.
 *
 * Deliberately still absent: `allow-top-navigation`, `allow-popups`, `allow-modals` and
 * `allow-downloads` — a preview must never be able to leave, freeze or download from the app.
 *
 * The matching change is in `public/preview-sw.js`: the worker sends
 * `access-control-allow-origin: *` on build bytes, because module requests from an opaque
 * origin are cross-origin requests.
 *
 * ## Why the frame's `src` does not follow the address bar
 *
 * The chrome's address follows what the frame is showing, including an SPA's own
 * `history.pushState`. If the frame's `src` were derived from that value, React would rewrite
 * the attribute half a second after the site navigated and the browser would reload the
 * document — throwing away the user's client-side state and looking like a crash. So `src` is
 * derived from `PreviewNavigation` alone ("what we last asked the frame to load"), which only
 * an explicit back/forward/reload/new-build changes. The address bar reads the observed path;
 * the frame's URL comes from the navigation. `src` also never changes on its own: the `key`
 * carries the navigation nonce, so a reload is a fresh document at the URL on screen.
 */

import { TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

import { PREVIEW_IFRAME_SANDBOX } from "@/preview/sandbox";
import { addressFor, previewUrlFor } from "@/ui/preview-browser";
import {
  PreviewBrowserBar,
  PreviewDeviceToolbar,
  PreviewTabStrip,
} from "@/ui/preview-chrome";
import { frameZoom, viewportFor, type ViewportName, type ViewportPreset } from "@/ui/viewport";
import { cn } from "@/lib/utils";

// The sandbox string lives in `preview/sandbox.ts` so that the browser acceptance run
// applies the product's own policy rather than a copy of it. Re-exported here because
// callers and tests have always imported it from this module.
export { PREVIEW_IFRAME_SANDBOX };

/**
 * The URL a build is previewed at.
 *
 * Defined in `preview-browser.ts` — the module that owns every URL decision — and re-exported
 * here because this is where callers and tests have always imported it from.
 */
export { previewUrlFor };

/** What the pane is showing. Absence of a build is a state, not an error. */
export type PreviewState =
  | { kind: "idle" }
  | { kind: "building"; buildId: string | null }
  | { kind: "ready"; buildId: string; title?: string }
  /**
   * A failure, with the status the server sent — or null when no server was reached at all
   * (an empty publish directory, a guest with no HTTP door, an unconfirmed publish). A null
   * status is printed as the message alone rather than as a made-up code.
   */
  | { kind: "error"; status: number | null; message: string };

export interface PreviewFrameProps {
  buildId: string;
  title?: string;
  /** The path inside the build the frame is told to load. Default the build's root. */
  path?: string;
  /**
   * Bumped by the caller to force a fresh document at the same URL.
   *
   * The `key` is the reload mechanism: React keeps the element and would otherwise reuse the
   * loaded page, so a reload has to be a new element.
   */
  reloadKey?: number;
  /**
   * The frame's own size, for a device preset. Null/absent fills the pane.
   *
   * The size is applied to the *iframe* rather than to a wrapper so the document inside it
   * sees the viewport the preset names (`100vw` in the page is the frame's width).
   */
  style?: CSSProperties | null;
  /**
   * The factor the frame is drawn at when the preset is wider than the pane (see
   * `frameZoom` in `viewport.ts`). `1`/absent means no scaling.
   */
  zoom?: number;
  /** For watching where the frame navigates: the address bar reads this element. */
  frameRef?: RefObject<HTMLIFrameElement>;
  /** Fired on every document load, so the address bar updates without waiting for a poll. */
  onLoad?: () => void;
  className?: string;
}

/**
 * The iframe itself. Pure: it renders one URL and nothing else, so a test can assert the
 * sandbox policy and the URL without a browser.
 */
export function PreviewFrame({
  buildId,
  title,
  path = "",
  reloadKey = 0,
  style,
  zoom = 1,
  frameRef,
  onLoad,
  className,
}: PreviewFrameProps) {
  return (
    <iframe
      key={`${buildId}:${String(reloadKey)}`}
      ref={frameRef}
      data-testid="preview-iframe"
      data-build-id={buildId}
      data-path={path}
      title={title ?? "Website preview"}
      src={previewUrlFor(buildId, path)}
      sandbox={PREVIEW_IFRAME_SANDBOX}
      // No credentials or referrer for guest code, and no permission grants beyond the
      // sandbox: a previewed page is untrusted content, not part of the app.
      referrerPolicy="no-referrer"
      allow=""
      onLoad={onLoad}
      // `zoom` keeps the frame's own layout width (the preset's CSS pixels) while shrinking the
      // box it occupies, so a 834-px tablet preview is legible on a 390-px phone instead of
      // forcing the pane to scroll sideways.
      style={zoom === 1 ? (style ?? undefined) : { ...style, zoom }}
      className={cn("bg-background size-full border-0", className)}
    />
  );
}

/**
 * The scale the frame should be drawn at, measured from the box it lives in.
 *
 * Measured rather than derived from the viewport width: the pane's own width is what matters, and
 * on a phone the pane is narrower than the window (padding, the switcher, a scrollbar). One
 * ResizeObserver on the box is enough — the pane resizes when the device toolbar changes preset,
 * when the split is dragged, and when the window is rotated.
 *
 * A desktop preset has no fixed width (`viewport.width === null`) and fills the pane, so it is
 * never scaled; `frameZoom` decides the rest, including the floor below which a scrollbar is the
 * more honest answer than an illegible page.
 */
function useFitZoom(
  box: RefObject<HTMLDivElement | null>,
  viewport: ViewportPreset,
): number {
  const [zoom, setZoom] = useState(1);
  const frameWidth = viewport.width;

  useEffect(() => {
    const element = box.current;
    if (element === null || frameWidth === null) {
      setZoom(1);
      return;
    }
    const measure = (): void => {
      setZoom(frameZoom(element.clientWidth, frameWidth));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [box, frameWidth]);

  return zoom;
}

/** The frame's origin, when this code is running in a browser. Null in a static render. */
function browserOrigin(): string | null {
  try {
    const host = typeof window === "undefined" ? "" : window.location.host;
    return host.length === 0 ? null : host;
  } catch {
    return null;
  }
}

export interface PreviewPanelProps {
  state: PreviewState;
  /**
   * Called when the user asks for a fresh document of the same build.
   *
   * The build id is passed so the caller can re-publish *that* build rather than re-reading
   * whatever happens to be in `dist/`; a browser's reload loads the page you are on, not the
   * next one.
   */
  onReload?: (buildId: string | null) => void;
  /** The pane's own controls, e.g. install/build, "Run the app", the served-by badge. */
  toolbar?: ReactNode;
  /** A strip rendered under the chrome and above the frame, e.g. the build progress line. */
  strip?: ReactNode;
  /**
   * A device preset's size for the frame, or null to fill the pane.
   *
   * The pane centres a sized frame instead of stretching it, because a 390-px "phone" pinned
   * to the left edge of a 900-px pane reads as a broken layout rather than as a device.
   */
  frameStyle?: CSSProperties | null;
  /** The path inside the build the frame is on. Drives the address bar. */
  path?: string;
  /**
   * The path the frame is *told* to load, when that differs from the one it is on.
   *
   * They differ in exactly one situation, and it is the reason this prop exists: the frame
   * navigated itself (a link, an SPA push) so the address bar moved, but nobody asked it to
   * load anything. Writing `src` from the observed path there would reload the user's page.
   */
  framePath?: string;
  /** The navigation nonce: bumping it is a reload. */
  reloads?: number;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  /** The preset that sizes the frame. Default desktop, so a bare panel still shows chrome. */
  viewport?: ViewportPreset;
  onViewport?: (name: ViewportName) => void;
  frameRef?: RefObject<HTMLIFrameElement>;
  onFrameLoad?: () => void;
  className?: string;
}

/**
 * The pane: browser chrome, the caller's controls, and then the routing module's message when a
 * request failed or the frame once a build is published.
 *
 * The error case exists because the alternative — a blank iframe — is indistinguishable
 * from a site that renders nothing. `routing.ts` already writes those messages in plain
 * language ("No preview build has been published yet…"); showing them is what makes them
 * worth writing. The chrome stays visible in every state: a browser with no page still shows
 * its tab strip and its address bar, and hiding them would make the pane's state harder to
 * read, not easier.
 */
export function PreviewPanel({
  state,
  onReload,
  toolbar,
  strip,
  frameStyle,
  path = "/",
  framePath,
  reloads = 0,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  viewport = viewportFor("desktop"),
  onViewport,
  frameRef,
  onFrameLoad,
  className,
}: PreviewPanelProps) {
  const ready = state.kind === "ready";
  // A fixed-preset frame (tablet, mobile) can be wider than a phone's pane. Measuring the box
  // lets the frame be drawn at a factor that fits, and the toolbar prints the factor.
  const frameBox = useRef<HTMLDivElement | null>(null);
  const zoom = useFitZoom(frameBox, viewport);
  const buildId = state.kind === "ready" ? state.buildId : null;
  const address = buildId === null ? "" : addressFor(buildId, path);
  const title = ready ? (state.title ?? "Website preview") : "Preview";

  return (
    <div
      data-testid="preview-browser"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <PreviewTabStrip title={title} buildId={buildId} />

      <PreviewBrowserBar
        address={address}
        origin={browserOrigin()}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        onBack={() => onBack?.()}
        onForward={() => onForward?.()}
        onReload={() => onReload?.(buildId)}
        // A browser with no document cannot reload one either; and a reload while a publish is
        // in flight would ask two questions of the same guest at once.
        reloadDisabled={!ready}
      />

      <PreviewDeviceToolbar viewport={viewport} onChange={onViewport} zoom={zoom} />

      {toolbar}
      {strip}

      {ready ? (
        <div
          data-testid="preview-frame-box"
          ref={frameBox}
          data-sized={frameStyle === undefined || frameStyle === null ? "false" : "true"}
          data-zoom={zoom < 1 ? zoom.toFixed(2) : "1"}
          className={cn(
            "relative min-h-0 flex-1",
            frameStyle !== undefined && frameStyle !== null && "flex items-center justify-center overflow-auto",
          )}
        >
          <PreviewFrame
            buildId={state.buildId}
            title={state.title}
            path={framePath ?? path}
            reloadKey={reloads}
            // `zoom` rather than a transform: the layout box shrinks with it, so a scaled frame
            // neither scrolls the pane nor overflows it, and the iframe still lays its document
            // out at the preset's width (which is the whole point of the preset).
            style={frameStyle ?? null}
            zoom={zoom}
            {...(frameRef !== undefined ? { frameRef } : {})}
            {...(onFrameLoad !== undefined ? { onLoad: onFrameLoad } : {})}
            className={
              frameStyle === undefined || frameStyle === null
                ? "absolute inset-0 h-full w-full"
                : "h-full w-full"
            }
          />
        </div>
      ) : (
        <div
          data-testid="preview-placeholder"
          /*
            `min-h-0 overflow-y-auto`: in landscape at 844 x 390 this pane is about 196 px tall
            once the tab strip, address bar and device toolbar have taken theirs, and this
            placeholder is ~163 px of icon and copy. A plain `flex-1` child keeps its content's
            min-height, so the pane grew to 574 px inside a 390 px window and — `body` is
            `overflow: hidden` — the explanation at the bottom was clipped, not scrolled.
          */
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 overflow-y-auto px-2 py-3 text-center"
        >
          {state.kind === "error" ? (
            <>
              <TriangleAlert aria-hidden="true" className="text-destructive/70 size-6" />
              <p className="text-sm font-medium">The preview could not load.</p>
              <p className="text-muted-foreground max-w-[46ch] font-mono text-[12px]">
                {/* A null status is a failure that never reached HTTP. Printing "null —"
                    would be a number no server sent, so it is the message alone. */}
                {state.status === null ? state.message : `${String(state.status)} — ${state.message}`}
              </p>
            </>
          ) : (
            <>
              <TriangleAlert aria-hidden="true" className="text-muted-foreground/60 size-6" />
              <p className="text-sm font-medium">
                {state.kind === "building" ? "Building the site…" : "No production build yet."}
              </p>
              <p className="text-muted-foreground max-w-[42ch] text-[13px]">
                {state.kind === "building"
                  ? "The preview shows the real output as soon as the build finishes."
                  : "The preview renders the real dist/ output built inside the guest, never a mock page."}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The pane's own controls, kept as a slot type.
 *
 * `PreviewPanel` receives them as a node so this module never has to know about the agent,
 * the build manager or the netlify verdict — the same reason it has always taken `toolbar`.
 */
export type PreviewToolbarSlot = ReactNode;
