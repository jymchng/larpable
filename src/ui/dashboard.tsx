import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Cog, GripVertical, Terminal, TriangleAlert } from "lucide-react";

import type { DistroSummary } from "@/env/distro";
import type { EnvironmentSnapshot } from "@/env/status";
import { describeEnvironment } from "@/env/status";
import type { SupportReport } from "@/env/support";
import { Badge } from "@/ui/components/badge";
import { BootIndicator } from "@/ui/boot-indicator";
import { IconButton } from "@/ui/components/icon-button";
import { Popover } from "@/ui/components/popover";
import { StatusDot, type StatusTone } from "@/ui/components/status-dot";
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
  /**
   * The live boot card. Injected so the dashboard stays a pure function of its props. It lives
   * inside the debug popover, compact: the Boot / self-test / Shut down controls it owns stay
   * reachable there, and the card's introductory copy (a paragraph about Debian) does not.
   */
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
   * The seven machine facts (§13): Linux, runtime, project, build, Netlify, preview, terminal —
   * already derived by `StatusFacts`. They are the body of the debug popover, not a band under the
   * header (user request: "Put all the above in the debug popover … make it more concise"):
   * a row of six cells spent a line of height on facts a person reads when something is wrong.
   * Nothing else in the layout repeats them.
   */
  statusFacts?: ReactNode;
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
   * here — `environment.status` — and the debug popover's Status section prints it, so a second
   * copy could disagree.
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
  statusFacts,
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
  // The `d` and its popover: the trigger is the anchor for dismissal and for focus returning,
  // while the *surface* hangs off the header (which is `relative`) so it can align to the
  // window's edge instead of to a button that sits 120 px from it.
  const debugAnchor = useRef<HTMLDivElement | null>(null);
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
      className="bg-background text-foreground flex min-h-0 flex-col overflow-x-clip pb-[max(0.35rem,var(--safe-bottom))]"
    >
      <header className="relative flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b px-1.5 pt-[max(0.35rem,var(--safe-top))] pb-1 sm:px-2.5 sm:py-1">
        <div className="flex items-center gap-1.5">
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
          {/*
            The machine report is a debugging aid, not a feature of the product: a person who
            wants to write a website should never have to scroll past requirement rows and a
            boot card to find the prompt box. It lives behind a `d` in a circle beside the
            wordmark — the one glyph that means "diagnostics" without spending a word — and
            since the user asked for it to *be* a popover it is a real one: Escape, a press
            outside, focus in on open and focus back to this button are `Popover`'s job, and a
            hand-rolled sheet could only reimplement them.
          */}
          <div ref={debugAnchor} className="ml-1 flex items-center">
            <IconButton
              testId="diagnostics-toggle"
              // One name in both states: `aria-expanded` says whether it is open, and a name
              // that changes under a screen reader cannot be asked for twice.
              label="Debug: this browser"
              hint="Status, requirements, the Linux image and the boot controls"
              tone="nav"
              aria-expanded={debugOpen}
              aria-controls={DEBUG_POPOVER_ID}
              onClick={() => setDebugOpen((open) => !open)}
            >
              <DebugGlyph />
            </IconButton>
          </div>
        </div>
        {/* The tagline is the first thing a 360 px header can afford to lose: the panes below
            say what the product does far better than a sentence about it. */}
        <p className="text-muted-foreground hidden text-xs sm:block sm:text-[13px]">
          Websites, built inside a Linux machine in your browser.
        </p>

        {/*
          The popover is a child of the header, not of the trigger. The header is `relative` and
          spans the window, so `right-0` puts the surface's right edge at the window's edge and
          its 22rem width still fits 390 px; anchored to the `d` itself it would hang off the
          left. `anchorRef` still points at the `d` alone, so a press on the trigger is not a
          dismissal and focus returns to the control that opened it. The surface is always in
          the DOM (hidden when closed), so `aria-controls` always names something that exists.
        */}
        <Popover
          id={DEBUG_POPOVER_ID}
          title="Debug"
          open={debugOpen}
          onClose={() => setDebugOpen(false)}
          anchorRef={debugAnchor}
        >
          <div className="space-y-1.5">
            <DebugSection label="Status">
              {/*
               * Two statements, then the facts list.
               *
               * The sentence (`Linux: Ready | Distro: debian | …`) is the shape the user
               * quoted when they asked for it here — "Linux: Ready | Distro: debian | Runtime:
               * node (guest shim) | CPUs: 2 | Memory: 1024 MiB … put all these into the debug
               * popover" — so it is rendered for real rather than only living in the shell's
               * `sr-only` live region. It overlaps the facts list below on purpose: the list
               * adds the four facts the sentence has never carried (project, build, Netlify,
               * preview) and a dot per fact, and a reader who wants the whole status in one
               * glance gets it from one line instead of assembling five rows.
               *
               * The verdict is the other half: "Kernel can boot" used to be a `Badge` in the
               * footer band, and the requirement count alone cannot say it (3/3 met *implies*
               * it, which is not the same as saying it).
               */}
              <EnvironmentVerdict
                sentence={describeEnvironment(environment)}
                support={support}
              />
              {statusFacts}
            </DebugSection>
            <DebugSection label="Requirements">
              <RequirementsLine support={support} passed={passed} />
              {/* The problems, and only when there are some: with everything met the line
                  above is the whole answer, and with something missing this is where the
                  support probe's own explanation (browser versions included) is spelled out. */}
              {support.problems.length > 0 && (
                <ul data-testid="requirement-problems" className="space-y-1 pt-1">
                  {support.problems.map((problem) => (
                    <li key={problem} className="text-muted-foreground flex gap-1.5 text-[11.5px]">
                      <TriangleAlert
                        aria-hidden="true"
                        className="text-destructive mt-0.5 size-3 shrink-0"
                      />
                      <span>{problem}</span>
                    </li>
                  ))}
                </ul>
              )}
            </DebugSection>
            <DebugSection label="Linux image">
              <ImageLine distro={distro} />
            </DebugSection>
            {environmentPanel ? (
              <DebugSection label="Machine">{environmentPanel}</DebugSection>
            ) : null}
            {/*
             * Which build this is — the one thing the header used to carry that nothing else on
             * the surface says. The support verdict used to sit beside it, in words ("Kernel can
             * boot"), and that was the same statement as the requirements count two sections
             * above with a green dot beside it: one fact, two places. The verdict is now the
             * count's own title and its failure wording, where the probe's problems are listed.
             */}
            <div
              data-testid="debug-footer"
              className="text-muted-foreground flex items-center justify-end border-t pt-1 font-mono text-[10.5px]"
            >
              <span data-testid="app-version">v{version}</span>
            </div>
          </div>
        </Popover>
        {/* The cog, at the header's right edge. `ml-auto` is what pins it there: the header is
            `flex flex-wrap`, so the trigger takes the remaining space on the first row and the
            popover hangs off it (`top-full right-0`) with its right edge on the window's. The
            wrapper is the anchor — a press on the cog is not a dismissal, so it toggles instead
            of closing then reopening, and focus returns to it when the surface closes. */}
        {settings ? (
          <div ref={settingsAnchor} className="relative ml-auto flex items-center">
            <IconButton
              testId="settings-toggle"
              label="Settings"
              hint="Provider, model and key; preview port and build directory"
              tone="nav"
              aria-expanded={settingsOpen}
              aria-controls="settings-region"
              onClick={() => setSettingsOpen((open) => !open)}
            >
              <Cog aria-hidden="true" />
            </IconButton>
            <Popover
              id="settings-region"
              title="Settings"
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              anchorRef={settingsAnchor}
            >
              {settings}
            </Popover>
          </div>
        ) : null}
      </header>

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
            The heading row is a strip of chrome, not a banner: `Agent` names the pane at `lg`,
            where both panes are visible and need naming. The cog that used to sit here moved to
            the header (user request: "Put the Provider Settings under Header at the most Right"):
            a setting is about the whole app rather than about this pane, and the header has a
            right edge that a per-pane heading row does not.
          */}
          <div className="hidden items-center justify-between gap-1.5 border-b px-1.5 py-0.5 sm:px-2 sm:py-0.5 lg:flex">
            <h2
              id="agent-heading"
              className="text-muted-foreground hidden text-[11px] font-semibold tracking-[0.1em] uppercase lg:block"
            >
              Agent
            </h2>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {chat}
            {terminal ? (
              <div className="flex min-h-0 flex-1 flex-col p-1 sm:p-1.5">{terminal}</div>
            ) : (
              <div className="flex max-h-full min-h-0 flex-1 flex-col items-center justify-center gap-1 overflow-y-auto px-2 py-2 text-center">
                <Terminal aria-hidden="true" className="text-muted-foreground/60 size-6" />
                <p className="text-sm font-medium">The agent has nothing to work with yet.</p>
                <p className="text-muted-foreground max-w-[42ch] text-[12px]">
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
            className="text-muted-foreground hidden border-b px-2 py-0.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-4 lg:block"
          >
            Preview
          </h2>
          {preview ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">{preview}</div>
          ) : null}
        </section>
      </main>

      {/*
       * The footer band is gone (user request: "put all these into the debug popover"), but its
       * sentence is not: boot progress is the one status a screen reader has to hear without
       * opening anything, so it stays in the DOM as a polite live region. `sr-only` is what
       * keeps it out of the layout while leaving it announced, and `data-testid` is what lets
       * the acceptance scripts read the same text a person's assistive tech gets — one stable
       * selector instead of a CSS path into chrome that keeps moving.
       */}
      <span data-testid="environment-summary" aria-live="polite" className="sr-only">
        {describeEnvironment(environment)}
      </span>
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
 * The id the `d` trigger's `aria-controls` names and the popover's surface carries.
 *
 * Exported because an acceptance run and a static-markup test both have to point at the same
 * string: a hand-copied id in a script is a check that passes after the surface was renamed.
 */
export const DEBUG_POPOVER_ID = "diagnostics-popover";

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

/** The one-line requirements answer, plus the detail a single line cannot paint. */
export function requirementsSummary(support: SupportReport): string {
  const checks: readonly { label: string; ok: boolean; good: string; bad: string }[] = [
    { label: "WebAssembly JSPI", ok: support.probe.jspi, good: "available", bad: "missing" },
    {
      label: "Cross-origin isolation",
      ok: support.probe.crossOriginIsolated,
      good: "isolated",
      bad: "not isolated",
    },
    {
      label: "SharedArrayBuffer",
      ok: support.probe.sharedArrayBuffer,
      good: "available",
      bad: "missing",
    },
  ];
  const passed = checks.filter((check) => check.ok).length;
  const detail = checks
    .map((check) => `${check.label}: ${check.ok ? check.good : check.bad}`)
    .join(" · ");
  return `Requirements: ${String(passed)}/3 met — ${detail}`;
}

/**
 * Requirements as one line.
 *
 * Three rows with a tick, a label and a status each was the largest block in the report for the
 * common case where all three pass. The line still says the count, and `requirementsSummary`
 * carries every check's name and result into the row's `title` and the dot's accessible label —
 * so the facts are one hover away rather than one row taller. When something *is* missing the
 * boot card below spells each problem out in full, which is where a person acts on it.
 */
function RequirementsLine({ support, passed }: { support: SupportReport; passed: number }) {
  const detail = requirementsSummary(support);
  return (
    <div
      data-testid="requirements-summary"
      title={detail}
      className="flex min-w-0 items-center gap-1.5 text-[11.5px]"
    >
      {/*
       * The dot that used to sit beside the `d` in the header (user request: "put the green dot
       * status in the debug popover"). It is the same component, the same tone rule and the same
       * accessible name — the count is the one status whose *colour* matters at a glance, and the
       * popover is where a person looks when they want to know why it is not green.
       */}
      <StatusDot
        testId="requirements-status"
        tone={requirementsTone(passed)}
        label={`Requirements: ${String(passed)}/3 met`}
      />
      <span className="font-mono">{passed}/3 met</span>
      {/* The verdict itself ("Kernel can boot" / "this browser cannot boot the kernel") is the
          Support row at the top of the Status section: one owner, so a failing browser reads it
          once instead of twice in the same popover. */}
      {support.simulated && (
        <span className="text-muted-foreground italic">(simulated probe)</span>
      )}
    </div>
  );
}

/**
 * The environment sentence and the support verdict, as the two labelled rows that replaced the
 * footer band and the header's `Kernel can boot` badge.
 *
 * Both were always-visible chrome: the footer printed the sentence under the panes and the badge
 * sat beside the wordmark. Neither is product chrome — a person writing a website does not need
 * to know the CPU count — so both live here now, in the same `<dl>` shape as the facts list
 * below them (user request: "Linux: Ready | Distro: debian | Runtime: node (guest shim) |
 * CPUs: 2 | Memory: 1024 MiB / Kernel can boot -> put all these into the debug popover").
 *
 * The sentence is *also* the shell's `sr-only` live region (`environment-summary`), and that is
 * not a duplicate to be tidied away: the row is what an eye reads once the popover is open, the
 * live region is what a screen reader hears while it is closed, and a boot failure has to be
 * announced without anyone pressing anything. Two copies, in the two places that answer two
 * questions \u2014 and no third: the row carries no `title`, because the `dd` below wraps rather
 * than truncating, so a native tooltip could only repeat what is already on screen (and would
 * put a third copy of the sentence in the markup, which is the count
 * `tests/debug-popover.test.tsx` uses to prove nothing else is rendering it).
 *
 * The verdict's wording is the footer's own ("Kernel can boot" / "this browser cannot boot the
 * kernel"), kept verbatim so the same sentence a person learned in the old layout still answers
 * the same question.
 */
function EnvironmentVerdict({ sentence, support }: { sentence: string; support: SupportReport }) {
  return (
    <dl data-testid="environment-verdict" className="font-mono text-[11px] leading-tight">
      <div data-testid="environment-sentence" className="flex min-w-0 gap-1.5">
        <dt className="text-muted-foreground w-[4.75rem] shrink-0">Environment</dt>
        {/* `break-words`, not `truncate`: the sentence is the whole status, so a narrow popover
            wraps it rather than hiding the memory figure behind an ellipsis. */}
        <dd className="text-foreground min-w-0 flex-1 break-words">{sentence}</dd>
      </div>
      <div
        data-testid="support-verdict"
        data-ok={support.ok ? "true" : "false"}
        className="flex min-w-0 gap-1.5"
      >
        <dt className="text-muted-foreground w-[4.75rem] shrink-0">Support</dt>
        <dd
          className={cn(
            "min-w-0 flex-1",
            support.ok ? "text-emerald-300" : "text-destructive",
          )}
        >
          {support.ok ? "Kernel can boot" : "this browser cannot boot the kernel"}
        </dd>
      </div>
    </dl>
  );
}

/** The Linux image on one line: what it is called, and what the downloader knows about it. */
function ImageLine({ distro }: { distro: DistroSummary }) {
  return (
    <div
      data-testid="image-line"
      title={distro.detail}
      className="flex min-w-0 items-center gap-1.5 text-[11.5px]"
    >
      <Badge
        className="shrink-0 font-mono text-[10px]"
        variant={
          distro.state === "ready" ? "success" : distro.state === "error" ? "destructive" : "warning"
        }
      >
        {distro.head}
      </Badge>
      <span className="text-muted-foreground min-w-0 flex-1 truncate">{distro.detail}</span>
    </div>
  );
}

/** A named block inside the debug popover: one caption, then the thing it names. */
function DebugSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h3 className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
        {label}
      </h3>
      {children}
    </div>
  );
}
