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
 *
 * There are two ways to fill this pane, and they are different questions:
 *
 * - **"Preview build"** publishes a *finished* `dist/` (a static site, a Vite app). The bytes
 *   exist before the click, and the worker holds them afterwards.
 * - **"Run the app"** starts the project's own `scripts.start` and forwards each request to
 *   the guest (`src/ui/use-app-preview.ts`). It exists because a Next.js project has no
 *   `dist/` at all — `next start` renders per request — and no amount of publishing will make
 *   one appear. The second button is therefore not a convenience: without it the Next.js path
 *   the product promises (`bun create next-app` → `bun run build` → `bun run start`) has no
 *   way to reach the iframe.
 *
 * The viewport control is the third honest thing here: it sizes the *frame* and says so. It is
 * not a device emulator (no touch events, no device pixel ratio), and the status line spells
 * that out rather than letting a 390-px frame imply a phone.
 */

import {
  ExternalLink,
  Loader2,
  Maximize2,
  Minimize2,
  Monitor,
  Play,
  RotateCw,
  Server,
  Smartphone,
  Square,
  SquareTerminal,
  Tablet,
} from "lucide-react";
import { useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { PreviewPhase } from "@/preview/controller";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { PreviewPanel, previewUrlFor, type PreviewState } from "@/ui/preview-frame";
import type { AppPreviewControl, AppPreviewState } from "@/ui/use-app-preview";
import {
  VIEWPORTS,
  describeViewport,
  viewportFor,
  viewportStyle,
  type ViewportName,
  type ViewportPreset,
} from "@/ui/viewport";
import { cn } from "@/lib/utils";

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

/**
 * A running app as a pane state, or null when the app is not the thing to show.
 *
 * A *starting* app is `building` with no build id: the frame must not appear until the guest
 * has answered, because a URL that cannot answer is worse than a sentence that says so.
 */
export function toAppPreviewState(app: AppPreviewControl | undefined): PreviewState | null {
  if (app === undefined) return null;
  const state = app.state;
  switch (state.kind) {
    case "idle":
      return null;
    case "starting":
      return { kind: "building", buildId: null };
    case "running":
      return { kind: "ready", buildId: state.buildId, title: "App preview" };
    case "failed":
      return { kind: "error", status: null, message: state.message };
  }
}

/**
 * Which of the two previews the frame shows.
 *
 * A running app wins, because the user asked for it last and it is the only thing the guest
 * is serving. A *static* build still wins over a *failed* app: the build is real and already
 * published, and hiding it would turn "the app did not start" into "your site disappeared".
 * The app's own sentence stays on the toolbar in that case, so nothing is lost.
 */
export function mergePreviewStates(phase: PreviewPhase, app?: AppPreviewControl): PreviewState {
  const appState = toAppPreviewState(app);
  if (appState !== null && appState.kind === "ready") return appState;
  const staticState = toPreviewState(phase);
  if (staticState.kind !== "idle") return staticState;
  return appState ?? staticState;
}

/** What the toolbar says about the running app, in the app's own words where it has them. */
export function describeAppPreview(state: AppPreviewState | undefined): string | null {
  if (state === undefined) return null;
  switch (state.kind) {
    case "idle":
      return "No app running: \u201cRun the app\u201d starts the project\u2019s own start script.";
    case "starting":
      return state.message;
    case "running":
      return `\`${state.command}\` answered ${String(state.status)} on guest port ${String(state.port)}.`;
    case "failed":
      return state.message;
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
  /**
   * "Run the app": the other way to get a preview, for a project that has a *server*
   * (Next.js) and therefore no `dist/` to publish. Absent when a caller has no such control —
   * the pane then behaves exactly as it did before, which is what keeps the static path
   * untouched.
   */
  app?: AppPreviewControl;
  /** The viewport the pane opens at. A prop so a test can render the tablet/mobile frames. */
  initialViewport?: ViewportName;
  className?: string;
}

export function PreviewPane({
  phase,
  onRefresh,
  available,
  app,
  initialViewport = "desktop",
  className,
}: PreviewPaneProps) {
  const [viewport, setViewport] = useState<ViewportName>(initialViewport);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const state = mergePreviewStates(phase, app);
  const preset = viewportFor(viewport);
  const ready = state.kind === "ready";
  const url = state.kind === "ready" ? previewUrlFor(state.buildId) : null;

  const toggleFullscreen = () => {
    const element = containerRef.current;
    if (element === null || typeof document === "undefined") return;
    if (document.fullscreenElement === null) {
      void element.requestFullscreen?.().then(() => setFullscreen(true)).catch(() => setFullscreen(false));
    } else {
      void document.exitFullscreen?.().then(() => setFullscreen(false)).catch(() => undefined);
    }
  };

  return (
    <div ref={containerRef} data-testid="preview-pane" className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <PreviewPanel
        state={state}
        onReload={onRefresh}
        frameStyle={viewportStyle(preset)}
        toolbar={
          <PreviewToolbar
            phase={phase}
            onRefresh={onRefresh}
            available={available}
            app={app}
            viewport={preset}
            onViewport={setViewport}
            ready={ready}
            url={url}
            fullscreen={fullscreen}
            onFullscreen={toggleFullscreen}
          />
        }
      />
    </div>
  );
}

export interface PreviewToolbarProps {
  phase: PreviewPhase;
  onRefresh: () => void;
  available: boolean;
  app?: AppPreviewControl;
  viewport?: ViewportPreset;
  onViewport?: (name: ViewportName) => void;
  /** True when a frame is actually rendered: fullscreen and "open in a new tab" need a URL. */
  ready?: boolean;
  /** The preview URL, when there is one. */
  url?: string | null;
  fullscreen?: boolean;
  onFullscreen?: () => void;
}

export function PreviewToolbar({
  phase,
  onRefresh,
  available,
  app,
  viewport,
  onViewport,
  ready = phase.kind === "ready",
  url = phase.kind === "ready" ? previewUrlFor(phase.buildId) : null,
  fullscreen = false,
  onFullscreen,
}: PreviewToolbarProps) {
  const busy = phase.kind === "starting" || phase.kind === "publishing";
  const label = phase.kind === "ready" ? "Rebuild preview" : "Preview build";
  const appNote = describeAppPreview(app?.state);

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

      {app !== undefined ? <RunAppButton app={app} available={available} /> : null}

      {viewport !== undefined && onViewport !== undefined ? (
        <ViewportControl current={viewport} onChange={onViewport} />
      ) : null}

      <div className="ml-auto flex items-center gap-1">
        {url !== null ? (
          <Button asChild size="sm" variant="ghost" data-testid="preview-new-tab" className="gap-1.5">
            {/* A real link, not a window.open call: a popup that the browser blocks would
                look like a broken button, and the user's own middle-click works here. */}
            <a href={url} target="_blank" rel="noreferrer noopener">
              <ExternalLink aria-hidden="true" className="size-3.5" />
              New tab
            </a>
          </Button>
        ) : null}

        {onFullscreen !== undefined ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="preview-fullscreen"
            onClick={onFullscreen}
            disabled={!ready}
            title={ready ? "Fullscreen preview" : "Publish a build before going fullscreen"}
            className="gap-1.5"
          >
            {fullscreen ? (
              <Minimize2 aria-hidden="true" className="size-3.5" />
            ) : (
              <Maximize2 aria-hidden="true" className="size-3.5" />
            )}
            <span className="sr-only">{fullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
          </Button>
        ) : null}
      </div>

      <p
        data-testid="preview-status"
        // The controller's own words for why the guest is answering. It used to reach the DOM
        // nowhere at all, which made "served by the guest" an unexplained downgrade and hid
        // the reason a publish failed from both the user and the acceptance run.
        data-note={phase.kind === "ready" ? (phase.note ?? "") : ""}
        title={phase.kind === "ready" ? (phase.note ?? undefined) : undefined}
        aria-live="polite"
        className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11.5px]"
      >
        {describePreviewPhase(phase)}
        {appNote !== null ? (
          <span data-testid="preview-app-status" className="block truncate">
            {appNote}
          </span>
        ) : null}
        {viewport !== undefined ? (
          <span data-testid="preview-viewport-status" className="block truncate">
            {describeViewport(viewport)}
          </span>
        ) : null}
      </p>

      <ServedBy phase={phase} app={app} />
    </div>
  );
}

/**
 * Desktop / tablet / mobile, as a segmented control of real buttons.
 *
 * `aria-pressed` and not a `<select>`: there are three choices, they are visible at once, and
 * the current one has to be readable by a screen reader — a select would work too, but a
 * segmented control is what every device toolbar in every devtool looks like.
 */
function ViewportControl({
  current,
  onChange,
}: {
  current: ViewportPreset;
  onChange: (name: ViewportName) => void;
}): ReactNode {
  const ICONS: Readonly<Record<ViewportName, ReactNode>> = {
    desktop: <Monitor aria-hidden="true" className="size-3.5" />,
    tablet: <Tablet aria-hidden="true" className="size-3.5" />,
    mobile: <Smartphone aria-hidden="true" className="size-3.5" />,
  };

  return (
    <div
      data-testid="preview-viewports"
      role="group"
      aria-label="Preview viewport"
      className="border-border flex items-center overflow-hidden rounded-md border"
    >
      {VIEWPORTS.map((preset) => {
        const selected = preset.name === current.name;
        return (
          <button
            key={preset.name}
            type="button"
            data-testid={`preview-viewport-${preset.name}`}
            data-selected={selected ? "true" : "false"}
            aria-pressed={selected}
            title={describeViewport(preset)}
            onClick={() => onChange(preset.name)}
            className={cn(
              "flex h-7 items-center gap-1 px-1.5 font-mono text-[10.5px] transition-colors",
              selected ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/60",
            )}
          >
            {ICONS[preset.name]}
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The one control that runs `next start` — or whatever `scripts.start` is.
 *
 * The label switches to "Run the app again" after a failure, because the hook reads
 * `package.json` first and reports what it found: a project with no `start` script must not
 * have a button that can only fail silently.
 */
function RunAppButton({ app, available }: { app: AppPreviewControl; available: boolean }): ReactNode {
  if (app.state.kind === "running") {
    return (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        data-testid="preview-stop-app"
        onClick={app.stop}
        className="gap-1.5"
      >
        <Square aria-hidden="true" className="size-3.5" />
        Stop app
      </Button>
    );
  }

  const starting = app.state.kind === "starting";
  const failed = app.state.kind === "failed";

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      data-testid="preview-run-app"
      onClick={app.run}
      // A device that is booting has nothing to run yet, and a start in flight must not be
      // started twice: both would spawn a second server on the same port.
      disabled={!available || starting}
      className="gap-1.5"
    >
      {starting ? (
        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
      ) : (
        <SquareTerminal aria-hidden="true" className="size-3.5" />
      )}
      {failed ? "Run the app again" : "Run the app"}
    </Button>
  );
}

/** How the bytes reach the iframe, stated rather than implied. */
function ServedBy({
  phase,
  app,
}: {
  phase: PreviewPhase;
  app?: AppPreviewControl;
}): ReactNode {
  if (app?.state.kind === "running") {
    return (
      <Badge variant="success" data-testid="preview-served-by" className="gap-1 font-mono text-[10px]">
        <SquareTerminal aria-hidden="true" className="size-3" />
        app
      </Badge>
    );
  }

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
