/**
 * The preview pane: a sandboxed iframe pointed at the guest's build.
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
 */

import { RotateCw, TriangleAlert } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";

import { PREVIEW_PREFIX } from "@/preview/routing";
import { PREVIEW_IFRAME_SANDBOX } from "@/preview/sandbox";
import { Button } from "@/ui/components/button";
import { cn } from "@/lib/utils";

// The sandbox string lives in `preview/sandbox.ts` so that the browser acceptance run
// applies the product's own policy rather than a copy of it. Re-exported here because
// callers and tests have always imported it from this module.
export { PREVIEW_IFRAME_SANDBOX };

/** The URL a build is previewed at. Always trailing-slashed: the worker's scope needs it. */
export function previewUrlFor(buildId: string, path = ""): string {
  const suffix = path.replace(/^\/+/, "");
  return `${PREVIEW_PREFIX}/${encodeURIComponent(buildId)}/${suffix}`;
}

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
  /** Bumped by the caller to force a reload of the same build. */
  reloadKey?: number;
  /**
   * The frame's own size, for a device preset. Null/absent fills the pane.
   *
   * The size is applied to the *iframe* rather than to a wrapper so the document inside it
   * sees the viewport the preset names (`100vw` in the page is the frame's width).
   */
  style?: CSSProperties | null;
  className?: string;
}

/**
 * The iframe itself. Pure: it renders one URL and nothing else, so a test can assert the
 * sandbox policy and the URL without a browser.
 */
export function PreviewFrame({ buildId, title, reloadKey = 0, style, className }: PreviewFrameProps) {
  return (
    <iframe
      // A reload of the same build is a new document: React keeps the element and would
      // otherwise reuse the loaded page, so the key is the reload mechanism.
      key={`${buildId}:${String(reloadKey)}`}
      data-testid="preview-iframe"
      data-build-id={buildId}
      title={title ?? "Website preview"}
      src={previewUrlFor(buildId)}
      sandbox={PREVIEW_IFRAME_SANDBOX}
      // No credentials or referrer for guest code, and no permission grants beyond the
      // sandbox: a previewed page is untrusted content, not part of the app.
      referrerPolicy="no-referrer"
      allow=""
      style={style ?? undefined}
      className={cn("bg-background size-full border-0", className)}
    />
  );
}

export interface PreviewPanelProps {
  state: PreviewState;
  /** Called when the user asks for a fresh document of the same build. */
  onReload?: () => void;
  /** Rendered above the frame, e.g. viewport controls. */
  toolbar?: ReactNode;
  /**
   * A device preset's size for the frame, or null to fill the pane.
   *
   * The pane centres a sized frame instead of stretching it, because a 390-px "phone" pinned
   * to the left edge of a 900-px pane reads as a broken layout rather than as a device.
   */
  frameStyle?: CSSProperties | null;
  className?: string;
}

/**
 * The pane: a placeholder while there is nothing to show, the routing module's message
 * when a request failed, and the frame once a build is published.
 *
 * The error case exists because the alternative — a blank iframe — is indistinguishable
 * from a site that renders nothing. `routing.ts` already writes those messages in plain
 * language ("No preview build has been published yet…"); showing them is what makes them
 * worth writing.
 */
export function PreviewPanel({ state, onReload, toolbar, frameStyle, className }: PreviewPanelProps) {
  const [reloadKey, setReloadKey] = useState(0);

  const reload = () => {
    setReloadKey((key) => key + 1);
    onReload?.();
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {toolbar}
      {state.kind === "ready" ? (
        <div
          data-testid="preview-frame-box"
          data-sized={frameStyle === undefined || frameStyle === null ? "false" : "true"}
          className={cn(
            "relative min-h-0 flex-1",
            frameStyle !== undefined && frameStyle !== null && "flex items-center justify-center overflow-auto",
          )}
        >
          <PreviewFrame
            buildId={state.buildId}
            title={state.title}
            reloadKey={reloadKey}
            style={frameStyle ?? null}
            className={
              frameStyle === undefined || frameStyle === null
                ? "absolute inset-0 h-full w-full"
                : "h-full w-full"
            }
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="preview-reload"
            onClick={reload}
            className="absolute top-2 right-2 gap-1.5 opacity-80 shadow-sm hover:opacity-100"
          >
            <RotateCw aria-hidden="true" className="size-3.5" />
            Reload
          </Button>
        </div>
      ) : (
        <div
          data-testid="preview-placeholder"
          className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center"
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
