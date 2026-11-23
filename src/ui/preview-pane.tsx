/**
 * The preview pane, driven by the controller's phase.
 *
 * The split matters: `src/preview/controller.ts` decides *what happened*, `preview-frame.tsx`
 * knows how to draw a sandboxed iframe and a failure, and this file is the one place that maps
 * one onto the other. Keeping the mapping here — not in the controller — means the controller
 * stays free of UI types and the acceptance run can assert phases instead of markup.
 *
 * The toolbar is not decoration. A preview does not appear by itself: the user asks for one,
 * and the moment they do, the start of a guest `node` can take a minute. So the control shows
 * what is happening (`Starting the guest's server…`, `Reading 14 files out of the guest…`)
 * rather than a spinner, and the *how* — a service worker holding the bytes, or the guest
 * answering on demand — is stated instead of hidden, because the second is slower and the
 * difference explains a slow deep link.
 */

import { Loader2, Play, RotateCw, Server } from "lucide-react";
import type { ReactNode } from "react";

import type { PreviewPhase } from "@/preview/controller";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { PreviewPanel, type PreviewState } from "@/ui/preview-frame";

/**
 * A controller phase as the frame's state.
 *
 * `status` is null when the failure never reached HTTP — an empty `dist/`, a guest with no
 * `fetch()`, a service-worker message that was never confirmed. Inventing a status code for
 * those would make the pane print a number that no server ever sent.
 */
export function toPreviewState(phase: PreviewPhase): PreviewState {
  switch (phase.kind) {
    case "idle":
      return { kind: "idle" };
    case "starting":
      return { kind: "building", buildId: null };
    case "publishing":
      return { kind: "building", buildId: phase.buildId };
    case "ready":
      return { kind: "ready", buildId: phase.buildId, title: "Website preview" };
    case "failed":
      return { kind: "error", status: null, message: phase.message };
  }
}

/** What the toolbar says about the phase in one short phrase. */
export function describePreviewPhase(phase: PreviewPhase): string {
  switch (phase.kind) {
    case "idle":
      return "No preview published yet.";
    case "starting":
      return phase.detail;
    case "publishing":
      return phase.detail;
    case "ready":
      return phase.served === "worker"
        ? `Serving ${String(phase.files)} file${phase.files === 1 ? "" : "s"} from the preview worker.`
        : `Serving from the guest on demand: ${phase.files} file${phase.files === 1 ? "" : "s"}.`;
    case "failed":
      return "The preview could not be published.";
  }
}

export interface PreviewPaneProps {
  phase: PreviewPhase;
  /** Called when the user asks for the build in the guest to be published. */
  onRefresh: () => void;
  /** False when there is no running machine to ask. */
  available: boolean;
  className?: string;
}

export function PreviewPane({ phase, onRefresh, available, className }: PreviewPaneProps) {
  return (
    <PreviewPanel
      state={toPreviewState(phase)}
      onReload={onRefresh}
      className={className}
      toolbar={
        <PreviewToolbar phase={phase} onRefresh={onRefresh} available={available} />
      }
    />
  );
}

export interface PreviewToolbarProps {
  phase: PreviewPhase;
  onRefresh: () => void;
  available: boolean;
}

export function PreviewToolbar({ phase, onRefresh, available }: PreviewToolbarProps) {
  const busy = phase.kind === "starting" || phase.kind === "publishing";
  const label = phase.kind === "ready" ? "Rebuild preview" : "Preview build";

  return (
    <div
      data-testid="preview-toolbar"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2"
    >
      <Button
        type="button"
        size="sm"
        variant="secondary"
        data-testid="preview-build"
        onClick={onRefresh}
        disabled={!available || busy}
        className="gap-1.5"
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : phase.kind === "ready" ? (
          <RotateCw aria-hidden="true" className="size-3.5" />
        ) : (
          <Play aria-hidden="true" className="size-3.5" />
        )}
        {label}
      </Button>

      <p
        data-testid="preview-status"
        aria-live="polite"
        className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11.5px]"
      >
        {describePreviewPhase(phase)}
      </p>

      <ServedBy phase={phase} />
    </div>
  );
}

/** How the bytes reach the iframe, stated rather than implied. */
function ServedBy({ phase }: { phase: PreviewPhase }): ReactNode {
  if (phase.kind !== "ready") return null;

  if (phase.served === "worker") {
    return (
      <Badge variant="success" data-testid="preview-served-by" className="font-mono text-[10px]">
        worker
      </Badge>
    );
  }

  return (
    <Badge variant="warning" data-testid="preview-served-by" className="gap-1 font-mono text-[10px]">
      <Server aria-hidden="true" className="size-3" />
      guest
    </Badge>
  );
}
