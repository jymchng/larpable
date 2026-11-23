/**
 * The preview pane: a sandboxed iframe pointed at the guest's build.
 *
 * The iframe is not decoration. Everything before this file is a decision about bytes;
 * this is where those bytes become a document that runs someone else's JavaScript. So the
 * two things that matter here are the `sandbox` attribute and the honesty of the states.
 *
 * ## Why the sandbox has no `allow-same-origin`
 *
 * Preview URLs live on the app's own origin (`/__preview__/<buildId>/…`), which is what
 * makes relative imports and an SPA router behave exactly as they will on Netlify. But a
 * same-origin document could read `localStorage`, where this app keeps projects, provider
 * keys and conversation history — a generated site would then be one `fetch("/api/…")`
 * away from them. `sandbox="allow-scripts"` without `allow-same-origin` puts the document
 * in an opaque origin: scripts run, storage and cookies are refused, and the parent app is
 * unreachable.
 *
 * The cost is real and documented rather than hidden: a previewed site cannot use
 * `localStorage`, `sessionStorage`, `indexedDB` or cookies, so a site that persists a
 * theme choice will look reset on every reload. `allow-forms` is granted because a form is
 * the most common thing a landing page has and submitting one is harmless; navigation of
 * the *top* page and popups are not, because a preview must never be able to leave the app.
 *
 * The matching change is in `public/preview-sw.js`: the worker sends
 * `access-control-allow-origin: *` on build bytes, because module requests from an opaque
 * origin are cross-origin requests.
 */

import { RotateCw, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import { PREVIEW_PREFIX } from "@/preview/routing";
import { Button } from "@/ui/components/button";
import { cn } from "@/lib/utils";

/**
 * The sandbox policy for a previewed site.
 *
 * `allow-scripts` is the point of a preview; `allow-forms` covers the contact form every
 * landing page has. Deliberately absent: `allow-same-origin` (storage, cookies, the
 * parent app's DOM), `allow-top-navigation` (leaving the app), `allow-popups` (a
 * `window.open` in guest code must not escape), `allow-modals` (`alert()` would freeze the
 * editor) and `allow-downloads`.
 */
export const PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-forms";

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
  | { kind: "error"; status: number; message: string };

export interface PreviewFrameProps {
  buildId: string;
  title?: string;
  /** Bumped by the caller to force a reload of the same build. */
  reloadKey?: number;
  className?: string;
}

/**
 * The iframe itself. Pure: it renders one URL and nothing else, so a test can assert the
 * sandbox policy and the URL without a browser.
 */
export function PreviewFrame({ buildId, title, reloadKey = 0, className }: PreviewFrameProps) {
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
export function PreviewPanel({ state, onReload, toolbar, className }: PreviewPanelProps) {
  const [reloadKey, setReloadKey] = useState(0);

  const reload = () => {
    setReloadKey((key) => key + 1);
    onReload?.();
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {toolbar}
      {state.kind === "ready" ? (
        <div className="relative min-h-0 flex-1">
          <PreviewFrame
            buildId={state.buildId}
            title={state.title}
            reloadKey={reloadKey}
            className="absolute inset-0 h-full w-full"
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
                {state.status} — {state.message}
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
