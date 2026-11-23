import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, Cog, GripVertical, Terminal, TriangleAlert, X } from "lucide-react";

import type { DistroSummary } from "@/env/distro";
import type { EnvironmentSnapshot } from "@/env/status";
import { describeEnvironment } from "@/env/status";
import type { SupportReport } from "@/env/support";
import { Badge } from "@/ui/components/badge";
import { BootIndicator } from "@/ui/boot-indicator";
import { IconButton } from "@/ui/components/icon-button";
import { Popover } from "@/ui/components/popover";
import { StatusDot, type StatusTone } from "@/ui/components/status-dot";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { MIN_SPLIT, clampSplit, splitAfterKey, splitFromPointer } from "@/ui/split";
import { DEFAULT_STAGE, type PaneStage } from "@/ui/stage";
import { StageSwitcher } from "@/ui/stage-switcher";
import { useAppHeight } from "@/ui/use-app-height";
import { cn } from "@/lib/utils";

export interface DashboardProps {
  version: string;
  support: SupportReport;
  environment: EnvironmentSnapshot;
  distro: DistroSummary;
  /** The live boot card. Injected so the dashboard stays a pure function of its props. */
  environmentPanel?: ReactNode;
  /**
   * The agent conversation. Injected for the same reason as the boot card: the dashboard
   * renders a transcript without owning a provider, a session or a guest.
   */
  chat?: ReactNode;
  /**
   * The guest terminal. Injected for the same reason as the boot card: the dashboard
   * renders it without knowing there is a Linux machine behind it.
   */
  terminal?: ReactNode;
  /**
   * The preview pane. Injected for the same reason again: the dashboard shows whatever
   * state the container derived (no build, building, ready, failed) without owning a
   * guest connection or a service worker.
   */
  preview?: ReactNode;
  /**
   * The live status bar (§13): six facts, already derived. It sits under the header because
   * "is the machine ready / has the build passed" is about the whole window, not one pane.
   */
  statusBar?: ReactNode;
  /**
   * Provider/model/key settings. They are the *body* of the popover the cog opens — the
   * surface, its position, its dismissal and its focus behaviour belong to `Popover` here,
   * because they are about the pane's chrome rather than about a provider.
   */
  settings?: ReactNode;
  /** The starting split, in percent. A prop so a test can render a non-default layout. */
  initialSplit?: number;
  /**
   * Whether the provider popover is open on the first render. A prop for the same reason as
   * `initialSplit` and `initialStage`: the *closed* state is the one the markup tests would
   * otherwise only ever see, and the open surface (a labelled dialog with the fields inside it)
   * has to be assertable without a DOM. It is the initial value only — the cog owns it after.
   */
  initialSettingsOpen?: boolean;
  /**
   * The automatic boot: whether one is in flight, the stage it last reported, its failure text
   * and how to retry it. Only those three values are passed, because the *status* is already
   * here — `environment.status` — and the footer prints it, so a second copy could disagree.
   *
   * Present in the app, absent in tests that render the shell without one: the indicator is
   * chrome for a machine that is starting, and a dashboard with no boot action shows none.
   */
  boot?: {
    busy: boolean;
    stage?: string | null;
    error?: string | null;
    onRetry: () => void;
  };
  /**
   * The pane a phone opens on. A prop (and a `?pane=` link) so the layout is a pure function of
   * its inputs: the switcher's state lives here, but every branch of it can be rendered in a
   * static-markup test.
   */
  initialStage?: PaneStage;
}

/**
 * The presentational shell. It takes every value it shows as a prop, so it renders
 * identically in tests (no fetch, no VM) and can never display state the caller
 * did not supply.
 *
 * The split is resizable with a real separator: `role="separator"` with
 * `aria-orientation="vertical"`, arrow keys, Home/End, and a pointer drag. The arithmetic is
 * in `src/ui/split.ts` (clamped to 20-80 %) and the state lives here, because a layout
 * preference is not a fact about the machine and nothing else needs to read it.
 */
export function Dashboard({
  version,
  support,
  environment,
  distro,
  environmentPanel,
  chat,
  terminal,
  preview,
  statusBar,
  settings,
  boot,
  initialSplit = 50,
  initialStage = DEFAULT_STAGE,
  initialSettingsOpen = false,
}: DashboardProps) {
  // The browser report is debugging, not product: it starts closed at every width now that it
  // lives behind the `d` glyph in the header instead of occupying a band above the footer.
  const [debugOpen, setDebugOpen] = useState(false);
  const [split, setSplit] = useState(() => clampSplit(initialSplit));
  // Which pane a phone shows. Both panes stay mounted below, so a run keeps streaming while
  // the user looks at the preview; the media query in `globals.css` is what hides one of them.
  const [stage, setStage] = useState<PaneStage>(initialStage);
  // The provider is chosen once and then read by every turn, so it does not deserve a permanent
  // band across the conversation: it is a popover hanging off the cog in the pane's heading row,
  // closed until asked for. Closed by default is the phone's answer too, where four provider
  // buttons and two fields were the most expensive vertical space in the app.
  const [settingsOpen, setSettingsOpen] = useState(initialSettingsOpen);
  const splitContainer = useRef<HTMLDivElement | null>(null);
  // The wrapper around the cog and its popover: it is both the "not outside" test for a press
  // and the place focus returns to when the popover closes.
  const settingsAnchor = useRef<HTMLDivElement | null>(null);
  // Publishes `--app-height` (the visual viewport, keyboard included) for the shell to read.
  const visibleHeight = useAppHeight();

  const passed = [
    support.probe.jspi,
    support.probe.crossOriginIsolated,
    support.probe.sharedArrayBuffer,
  ].filter(Boolean).length;

  const startDrag = (event: { preventDefault(): void; clientX: number }) => {
    const element = splitContainer.current;
    if (element === null) return;
    event.preventDefault();
    const rect = element.getBoundingClientRect();
    const move = (pointer: PointerEvent) => {
      setSplit(splitFromPointer(pointer.clientX, rect.left, rect.width));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return (
    <div
      // `h-dvh` is the stylesheet's answer; a measured visual viewport (which on iOS shrinks
      // when the keyboard opens, and `dvh` often does not) replaces it once there is one.
      style={{ height: visibleHeight === null ? "100dvh" : `${String(visibleHeight)}px` }}
      className="bg-background text-foreground flex min-h-0 flex-col overflow-x-clip"
    >
      <header className="relative flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 pt-[max(0.5rem,var(--safe-top))] pb-2 sm:px-6 sm:py-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-3.5 rounded-[4px] bg-gradient-to-br from-primary via-chart-5 to-primary shadow-[0_0_18px_-2px] shadow-primary/60"
          />
          <span className="text-xs font-semibold tracking-[0.14em] uppercase">Larpable</span>
          {/* The machine starts itself, so the one thing a person needs to know in the first
              second is whether it is still starting. The spinner sits against the wordmark
              because that is where the eye already is; it disappears the moment there is
              nothing true to say (ready, stopped) and becomes an error + retry when the boot
              failed, rather than turning forever. */}
          {boot ? (
            <BootIndicator
              status={environment.status}
              supported={support.ok}
              busy={boot.busy}
              stage={boot.stage ?? null}
              error={boot.error ?? null}
              onRetry={boot.onRetry}
            />
          ) : null}
          <Badge variant="outline" className="font-mono text-[10px]">
            v{version}
          </Badge>
          {/*
            The browser report is a debugging aid, not a feature of the product: a person who
            wants to write a website should never have to scroll past three requirement rows and
            a boot card to find the prompt box. It lives behind a `d` in a circle beside the
            wordmark — the one glyph that means "diagnostics" without spending a word — and its
            content appears as a sheet under the header rather than in the layout, so opening it
            cannot reflow the panes underneath.
          */}
          <IconButton
            testId="diagnostics-toggle"
            label={debugOpen ? "Close the browser report" : "Debug: this browser"}
            hint="Requirements, the Linux image and the boot card"
            tone="nav"
            aria-expanded={debugOpen}
            aria-controls="diagnostics-body"
            onClick={() => setDebugOpen((open) => !open)}
            className="ml-1"
          >
            <DebugGlyph />
          </IconButton>
          {/* The count stays visible even when the sheet is closed: a red dot is the one thing
              here that changes what the user can do, so it must not be hidden behind a click. */}
          <StatusDot
            testId="requirements-status"
            tone={requirementsTone(passed)}
            label={`Requirements: ${String(passed)}/3 met`}
          />
        </div>
        {/* The tagline is the first thing a 360 px header can afford to lose: the panes below
            say what the product does far better than a sentence about it. */}
        <p className="text-muted-foreground hidden text-xs sm:block sm:text-[13px]">
          Websites, built inside a Linux machine in your browser.
        </p>

        {/*
          The sheet itself. Always in the DOM and hidden with a class when closed, so
          `aria-controls` points at something that exists and the requirement rows can be
          inspected (by a person or an acceptance run) without a click; `hidden` is what takes it
          out of the layout and out of the focus order, so a closed report cannot be tabbed into.
        */}
        <div
          id="diagnostics-body"
          role="region"
          aria-labelledby="diagnostics-heading"
          data-open={debugOpen ? "true" : "false"}
          className={cn(
            "bg-card absolute inset-x-2 top-full z-50 max-h-[min(70dvh,32rem)] overflow-y-auto rounded-lg border shadow-xl",
            debugOpen ? undefined : "hidden",
          )}
        >
          <div className="flex items-center justify-between gap-2 border-b px-4 py-1.5">
            <h2
              id="diagnostics-heading"
              className="text-muted-foreground text-[11px] font-semibold tracking-[0.1em] uppercase"
            >
              This browser
            </h2>
            <IconButton
              testId="diagnostics-close"
              label="Close the browser report"
              tone="muted"
              onClick={() => setDebugOpen(false)}
            >
              <X aria-hidden="true" />
            </IconButton>
          </div>

          <div className="grid gap-3 p-4 lg:grid-cols-2">
            {environmentPanel}
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Runtime requirements</CardTitle>
                <CardDescription>What unkernel needs before a kernel can boot.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <CheckRow
                  label="WebAssembly JSPI"
                  ok={support.probe.jspi}
                  detail={support.probe.jspi ? "available" : "missing"}
                />
                <CheckRow
                  label="Cross-origin isolation"
                  ok={support.probe.crossOriginIsolated}
                  detail={support.probe.crossOriginIsolated ? "isolated" : "not isolated"}
                />
                <CheckRow
                  label="SharedArrayBuffer"
                  ok={support.probe.sharedArrayBuffer}
                  detail={support.probe.sharedArrayBuffer ? "available" : "missing"}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Linux image</CardTitle>
                <CardDescription>{distro.detail}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      distro.state === "ready"
                        ? "success"
                        : distro.state === "error"
                          ? "destructive"
                          : "warning"
                    }
                  >
                    {distro.head}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          </div>

          {support.problems.length > 0 && (
            <ul className="text-muted-foreground space-y-1.5 px-4 pb-4 text-xs">
              {support.problems.map((problem) => (
                <li key={problem} className="flex gap-2">
                  <X aria-hidden="true" className="text-destructive mt-0.5 size-3.5 shrink-0" />
                  <span>{problem}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      {statusBar}

      <StageSwitcher stage={stage} onChange={setStage} previewReady={preview !== undefined} />

      <main
        ref={splitContainer}
        data-stage={stage}
        data-testid="main-panes"
        className="flex min-h-0 flex-1 flex-col lg:flex-row"
      >
        <section
          id="agent-pane"
          data-pane="agent"
          aria-labelledby="agent-heading"
          data-testid="agent-pane"
          data-basis={split.toFixed(2)}
          style={{ "--agent-basis": `${split.toFixed(2)}%` } as CSSProperties}
          className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-none lg:basis-[var(--agent-basis)]"
        >
          {/*
            The heading row is a strip of chrome, not a banner: `Agent` names the pane at `lg`
            (where both panes are visible and need naming) and the cog is the pane's one control.
            The cog is present at every width on purpose — below `lg` the heading is redundant
            because the stage switcher already says "Agent", but the *setting* would otherwise
            become unreachable on exactly the screens that need it most.
          */}
          <div className="flex items-center justify-between gap-2 border-b px-2 py-1 sm:px-6 sm:py-2.5">
            <h2
              id="agent-heading"
              className="text-muted-foreground hidden text-[11px] font-semibold tracking-[0.1em] uppercase lg:block"
            >
              Agent
            </h2>
            {settings ? (
              /*
                The cog and its popover are one wrapper, and the wrapper is the anchor: the
                surface is positioned against it (`top-full right-0`), a press inside it is not
                a dismissal (so clicking the cog toggles rather than closes-then-reopens), and
                focus returns to the cog when the popover closes from the keyboard. The label
                stays "Provider settings" in both states — `aria-expanded` is what says
                whether it is open, and a name that changes under a screen reader is a name
                that cannot be used twice.
              */
              <div ref={settingsAnchor} className="relative ml-auto flex items-center">
                <IconButton
                  testId="settings-toggle"
                  label="Provider settings"
                  hint="Provider, model and API key"
                  tone="nav"
                  aria-expanded={settingsOpen}
                  aria-controls="settings-region"
                  onClick={() => setSettingsOpen((open) => !open)}
                >
                  <Cog aria-hidden="true" />
                </IconButton>
                <Popover
                  id="settings-region"
                  title="Provider settings"
                  open={settingsOpen}
                  onClose={() => setSettingsOpen(false)}
                  anchorRef={settingsAnchor}
                >
                  {settings}
                </Popover>
              </div>
            ) : null}
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {chat}
            {terminal ? (
              <div className="flex min-h-0 flex-1 flex-col p-2 sm:p-3">{terminal}</div>
            ) : (
              <div className="flex max-h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-6 py-8 text-center">
                <Terminal aria-hidden="true" className="text-muted-foreground/60 size-6" />
                <p className="text-sm font-medium">The agent has nothing to work with yet.</p>
                <p className="text-muted-foreground max-w-[42ch] text-[13px]">
                  Describe a website here once the Linux environment reports ready.
                </p>
              </div>
            )}
          </div>
        </section>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the agent and preview panes"
          aria-valuenow={Math.round(split)}
          aria-valuemin={MIN_SPLIT}
          aria-valuemax={100 - MIN_SPLIT}
          data-testid="split-handle"
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(event) => {
            const next = splitAfterKey(split, event.key, { shift: event.shiftKey });
            if (next === null) return;
            event.preventDefault();
            setSplit(next);
          }}
          className="group hidden w-1.5 cursor-col-resize items-center justify-center border-x bg-border/40 transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 lg:flex"
        >
          <GripVertical aria-hidden="true" className="text-muted-foreground/70 size-3" />
          <span className="sr-only">Drag or use the arrow keys to resize</span>
        </div>

        <section
          id="preview-pane"
          data-pane="preview"
          aria-labelledby="preview-heading"
          className="flex min-h-0 min-w-0 flex-1 flex-col lg:min-w-0"
        >
          <h2
            id="preview-heading"
            className="text-muted-foreground hidden border-b px-4 py-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-6 lg:block"
          >
            Preview
          </h2>
          {preview ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{preview}</div>
          ) : (
            /*
              `min-h-0 overflow-y-auto`, not a bare `flex-1`: in landscape at 844 x 390 the panes
              are 196 px tall, and this empty state is ~163 px of padding and copy. Without the
              min-height override the flex item refuses to shrink, the section grows past its
              parent, and because `body` is `overflow: hidden` the explanation below the fold was
              clipped and unreachable rather than scrolled — measured as a 574 px document in a
              390 px window.
            */
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 overflow-y-auto px-6 py-8 text-center">
              <TriangleAlert aria-hidden="true" className="text-muted-foreground/60 size-6" />
              <p className="text-sm font-medium">No production build yet.</p>
              <p className="text-muted-foreground max-w-[42ch] text-[13px]">
                The preview renders the real <code className="font-mono">dist/</code> output built
                inside the guest, never a mock page.
              </p>
            </div>
          )}
        </section>
      </main>

      <footer
        aria-live="polite"
        className="bg-muted/40 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-3 pt-2 pb-[max(0.5rem,var(--safe-bottom))] font-mono text-[11.5px] sm:px-6"
      >
        <span className="text-muted-foreground">{describeEnvironment(environment)}</span>
        <Badge variant={support.ok ? "success" : "destructive"}>
          {support.ok ? "Kernel can boot" : "Kernel cannot boot here"}
        </Badge>
      </footer>
    </div>
  );
}

/**
 * The `d` in a circle: diagnostics.
 *
 * Drawn rather than borrowed, because no icon set ships a letter-in-a-circle for an arbitrary
 * letter and the letter is the whole point: `d` has meant "debugger" since `dbx`, while a cog
 * would say "settings" — which is what the agent pane's cog already says, two hundred pixels
 * away. Hand-drawn SVG for the same reason the app uses `lucide` everywhere else: it inherits
 * `currentColor` and the button's size class, so a theme or a density change moves it too.
 */
function DebugGlyph(): ReactNode {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9.25" />
      <text
        x="12"
        y="12"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="12"
        fontWeight="600"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fill="currentColor"
        stroke="none"
      >
        d
      </text>
    </svg>
  );
}

/**
 * How many of the three requirements are met, as a dot colour.
 *
 * Exported so the rule is testable on its own: 3 → green, 1-2 → amber (partly there, which
 * is a warning and not a success). The dot is not the only place the answer lives: opening
 * the diagnostics panel lists each of the three requirements by name with
 * `available`/`missing`, and the dot's label and tooltip spell out the count.
 */
export function requirementsTone(passed: number): StatusTone {
  if (passed >= 3) return "green";
  if (passed > 0) return "amber";
  return "red";
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      {ok ? (
        <Check aria-hidden="true" className="text-success size-3.5" />
      ) : (
        <X aria-hidden="true" className="text-destructive size-3.5" />
      )}
      <span>{label}</span>
      <span className={cn("ml-auto font-mono text-[11px]", ok ? "text-success" : "text-destructive")}>
        {detail}
      </span>
      <span className="sr-only">{ok ? "(supported)" : "(unsupported)"}</span>
    </div>
  );
}
