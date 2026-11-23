/**
 * The preview pane, driven by the controller's phase.
 *
 * The split matters: `src/preview/controller.ts` decides *what happened*, `preview-frame.tsx`
 * knows how to draw a browser window and a failure, and this file is the one place that maps
 * one onto the other. Keeping the mapping here — not in the controller — means the controller
 * stays free of UI types and the acceptance run can assert phases instead of markup.
 *
 * This file also owns the pane's *browser* state, which is a reducer and not a pile of
 * `useState`s: what the frame has visited, what it was last told to load, and which device
 * preset sizes it. `src/ui/preview-browser.ts` holds that reducer, so back/forward/reload are
 * testable decisions rather than click handlers nobody can assert.
 *
 * Three behaviours in here are deliberately narrow:
 *
 * - **Back and forward are disabled at the start of every build**, because the pane's history is
 *   the list of paths the frame actually visited and a new build has exactly one. They are never
 *   wired to the browser's own arrows: this frame's session history belongs to the app's window,
 *   and hijacking it would break the Back button that gets the user out of the preview.
 * - **Reload reloads what is on screen.** It re-navigates the frame to the path it is showing
 *   (not to the build's root) and asks the caller to re-publish *that build id*, so a reload can
 *   never silently swap in a different build's bytes.
 * - **The address bar follows the frame, not the other way round.** A 500 ms read of
 *   `contentWindow.location` keeps the URL honest when the previewed site routes itself
 *   (`pushState`, a link, a hash), and it never writes back into the frame — see the note in
 *   `preview-frame.tsx` about the reload loop that would cause.
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
 * not a device emulator (no touch events, no device pixel ratio), and the toolbar spells that
 * out rather than letting a 390-px frame imply a phone.
 */

import {
  CircleStop,
  ExternalLink,
  Hammer,
  Loader2,
  Maximize2,
  Play,
  RotateCw,
  Server,
  Square,
  SquareTerminal,
} from "lucide-react";
import { useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";

import type { PreviewPhase } from "@/preview/controller";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { IconButton } from "@/ui/components/icon-button";
import { describeBuildProgress, type BuildStatus } from "@/ui/build-state";
import { PreviewPanel, previewUrlFor, type PreviewState } from "@/ui/preview-frame";
import {
  beginBrowser,
  canGoBack,
  canGoForward,
  currentPath,
  pathFromFrameUrl,
  previewBrowserReducer,
  readFrameUrl,
} from "@/ui/preview-browser";
import type { AppPreviewControl, AppPreviewState } from "@/ui/use-app-preview";
import type { BuildControl } from "@/ui/use-build";
import {
  viewportFor,
  viewportStyle,
  type ViewportName,
  type ViewportPreset,
} from "@/ui/viewport";
import { cn } from "@/lib/utils";

/** How often the address bar re-reads the frame's location. Cheap, and no faster than a eye. */
const OBSERVE_INTERVAL_MS = 500;

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
      return "No app running: “Run the app” starts the project’s own start script.";
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
  /**
   * Called when the user asks for the build in the guest to be published.
   *
   * The build id is passed on reload (`PreviewPanel`'s own reload control), so a reload
   * re-publishes the build that is on screen; a rebuild asks with no id, because "rebuild the
   * preview" means "whatever is in `dist/` now" and the controller can fingerprint that.
   */
  onRefresh: (buildId?: string) => void;
  /** False when there is no running machine to ask. */
  available: boolean;
  /**
   * "Run the app": the other way to get a preview, for a project that has a *server*
   * (Next.js) and therefore no `dist/` to publish. Absent when a caller has no such control —
   * the pane then behaves exactly as it did before, which is what keeps the static path
   * untouched.
   */
  app?: AppPreviewControl;
  /**
   * The build, when the caller has one: install + build inside the guest, with a status
   * sentence and a Cancel button. Absent for a caller with no build manager, and the pane
   * then behaves exactly as it did before — the publish button alone.
   */
  build?: BuildControl;
  /** The viewport the pane opens at. A prop so a test can render the tablet/mobile frames. */
  initialViewport?: ViewportName;
  className?: string;
}

export function PreviewPane({
  phase,
  onRefresh,
  available,
  app,
  build,
  initialViewport = "desktop",
  className,
}: PreviewPaneProps) {
  // One reducer for the browser bits: history, what the frame was told to load, and the device.
  const [browser, dispatch] = useReducer(previewBrowserReducer, initialViewport, beginBrowser);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const state = mergePreviewStates(phase, app);
  const preset = viewportFor(browser.viewport);
  const ready = state.kind === "ready";
  const buildId = state.kind === "ready" ? state.buildId : null;
  const url = buildId === null ? null : previewUrlFor(buildId);
  const path = currentPath(browser.history);

  // A different build is a different document: its root, and its own history. Without this the
  // address bar would keep claiming `/about` from the previous build.
  useEffect(() => {
    dispatch({ type: "reset" });
  }, [buildId]);

  const observe = useCallback(() => {
    if (buildId === null) return;
    const observed = pathFromFrameUrl(readFrameUrl(frameRef.current), buildId);
    if (observed !== null) dispatch({ type: "visit", path: observed });
  }, [buildId]);

  // A previewed site can navigate itself — a link, `pushState`, a hash — and none of those fire
  // an event the parent can hear. Reading the frame's location on a slow timer is what keeps
  // the address bar from lying; `onLoad` covers full document loads without the wait.
  useEffect(() => {
    if (!ready || buildId === null) return;
    const timer = setInterval(observe, OBSERVE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ready, buildId, observe]);

  const toggleFullscreen = () => {
    const element = containerRef.current;
    if (element === null || typeof document === "undefined") return;
    if (document.fullscreenElement === null) {
      void element.requestFullscreen?.().catch(() => undefined);
    } else {
      void document.exitFullscreen?.().catch(() => undefined);
    }
  };

  return (
    <div
      ref={containerRef}
      data-testid="preview-pane"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <PreviewPanel
        state={state}
        onReload={(id) => {
          dispatch({ type: "reload" });
          onRefresh(id ?? undefined);
        }}
        toolbar={
          <PreviewToolbar
            phase={phase}
            onRefresh={() => onRefresh()}
            available={available}
            app={app}
            ready={ready}
            url={url}
            onFullscreen={toggleFullscreen}
          />
        }
        strip={build !== undefined ? <BuildStrip build={build} /> : null}
        frameStyle={viewportStyle(preset)}
        path={path}
        framePath={browser.navigation.path}
        reloads={browser.navigation.nonce}
        canGoBack={canGoBack(browser.history)}
        canGoForward={canGoForward(browser.history)}
        onBack={() => dispatch({ type: "back" })}
        onForward={() => dispatch({ type: "forward" })}
        viewport={preset}
        onViewport={(name) => dispatch({ type: "viewport", name })}
        frameRef={frameRef}
        onFrameLoad={observe}
      />
    </div>
  );
}

/**
 * Install + build, as one control with one status sentence.
 *
 * The pane used to have only "Preview build", which publishes whatever `dist/` already holds
 * — so a user with no build had a button that could only fail. This strip is the other half:
 * it runs the guest's install and build (through `src/ui/build-controller.ts`, the same object
 * the agent's tools use) and says what happened in the manager's own words.
 *
 * The two buttons are never both shown: a run in flight offers Cancel, and only Cancel. A
 * disabled button states why, from `build.problem`, which is derived from the machine's own
 * status rather than from a guess.
 */
function BuildStrip({ build }: { build: BuildControl }): ReactNode {
  const { status } = build;
  const running = status.kind === "running";
  const disabled = build.busy || build.problem !== null;

  return (
    <div
      data-testid="preview-build-strip"
      data-kind={status.kind}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-1.5"
    >
      <IconButton
        testId="preview-install-build"
        label={status.kind === "ok" ? "Rebuild" : "Install & build"}
        hint={
          build.problem ??
          "Run bun install and bun run build inside the guest, then publish the result"
        }
        tone="run"
        onClick={build.run}
        disabled={disabled}
      >
        {running ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <Hammer aria-hidden="true" />
        )}
      </IconButton>

      {build.busy ? (
        <IconButton
          testId="preview-cancel-build"
          label="Cancel the build"
          hint="Stop the install or build running in the guest"
          tone="stop"
          onClick={build.cancel}
        >
          <CircleStop aria-hidden="true" />
        </IconButton>
      ) : null}

      <p
        data-testid="preview-build-status"
        aria-live="polite"
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-[11.5px]",
          status.kind === "failed" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {describeBuildProgress(status)}
      </p>

      {build.problem !== null ? (
        <span data-testid="preview-build-problem" className="text-muted-foreground text-[11.5px]">
          {build.problem}
        </span>
      ) : null}
    </div>
  );
}

export interface PreviewToolbarProps {
  phase: PreviewPhase;
  onRefresh: () => void;
  available: boolean;
  app?: AppPreviewControl;
  /** True when a frame is actually rendered: fullscreen and "open in a new tab" need a URL. */
  ready?: boolean;
  /** The preview URL, when there is one. */
  url?: string | null;
  onFullscreen?: () => void;
}

/**
 * The pane's own controls: publish, run the app, the status sentence, the served-by badge.
 *
 * It is deliberately *not* the browser chrome. Tabs, arrows, the address bar and the device
 * toolbar belong to `preview-chrome.tsx`, because those are a browser's words for a browser's
 * controls; this row is the app talking about what it did.
 */
export function PreviewToolbar({
  phase,
  onRefresh,
  available,
  app,
  ready = phase.kind === "ready",
  url = phase.kind === "ready" ? previewUrlFor(phase.buildId) : null,
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
      {/* Publish is the pane's primary action, so its pictogram is green: play to publish the
          first build, a circling arrow to publish again. The words are the accessible name. */}
      <IconButton
        testId="preview-build"
        label={label}
        hint={
          available
            ? "Publish the finished dist/ and show it in the frame"
            : "Boot the machine before publishing a build"
        }
        tone="run"
        onClick={onRefresh}
        disabled={!available || busy}
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : phase.kind === "ready" ? (
          <RotateCw aria-hidden="true" />
        ) : (
          <Play aria-hidden="true" />
        )}
      </IconButton>

      {app !== undefined ? <RunAppButton app={app} available={available} /> : null}

      <div className="ml-auto flex items-center gap-1">
        {url !== null ? (
          // A real link, not a window.open call: a popup that the browser blocks would look
          // like a broken button, and the user's own middle-click works here.
          <Button asChild size="icon" variant="ghost" data-testid="preview-new-tab" className="size-8">
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label="Open the preview in a new tab"
              title="Open the preview in a new tab"
              className="text-muted-foreground hover:text-foreground"
            >
              <ExternalLink aria-hidden="true" className="size-4" />
            </a>
          </Button>
        ) : null}

        {onFullscreen !== undefined ? (
          <IconButton
            testId="preview-fullscreen"
            label="Fullscreen"
            hint={ready ? "Fullscreen preview" : "Publish a build before going fullscreen"}
            tone="muted"
            onClick={onFullscreen}
            disabled={!ready}
          >
            <Maximize2 aria-hidden="true" />
          </IconButton>
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
      </p>

      <ServedBy phase={phase} app={app} />
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
      // A square in red: this ends a server, so it must not look like the green run control
      // next to it. The words live in the accessible name ("Stop app").
      <IconButton
        testId="preview-stop-app"
        label="Stop app"
        hint="Stop the project's own start script and its server"
        tone="stop"
        onClick={app.stop}
      >
        <Square aria-hidden="true" />
      </IconButton>
    );
  }

  const starting = app.state.kind === "starting";
  const failed = app.state.kind === "failed";

  return (
    <IconButton
      testId="preview-run-app"
      // The name says which question the button answers: a first run reads the project's
      // `scripts.start`, so a project without one is told why rather than silently failing.
      label={failed ? "Run the app again" : "Run the app"}
      hint={
        available
          ? "Start the project's own start script and forward its requests to the guest"
          : "Boot the machine before running the app"
      }
      tone="run"
      onClick={app.run}
      // A device that is booting has nothing to run yet, and a start in flight must not be
      // started twice: both would spawn a second server on the same port.
      disabled={!available || starting}
    >
      {starting ? (
        <Loader2 aria-hidden="true" className="animate-spin" />
      ) : (
        <SquareTerminal aria-hidden="true" />
      )}
    </IconButton>
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

/** Kept for callers that used the old name; the levels live in `build-state.ts`. */
export type { BuildStatus };
