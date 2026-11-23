import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Check, ChevronRight, GripVertical, Terminal, TriangleAlert, X } from "lucide-react";

import type { DistroSummary } from "@/env/distro";
import type { EnvironmentSnapshot } from "@/env/status";
import { describeEnvironment } from "@/env/status";
import type { SupportReport } from "@/env/support";
import { Badge } from "@/ui/components/badge";
import { StatusDot, type StatusTone } from "@/ui/components/status-dot";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { MIN_SPLIT, clampSplit, splitAfterKey, splitFromPointer } from "@/ui/split";
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
  /** Provider/model/key settings, shown above the conversation that uses them. */
  settings?: ReactNode;
  /** The starting split, in percent. A prop so a test can render a non-default layout. */
  initialSplit?: number;
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
  initialSplit = 50,
}: DashboardProps) {
  // Open by default: this report is why a boot button is disabled when it is, and
  // hiding that behind a collapsed panel would hide the explanation. The user
  // collapses it once they have read it.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(true);
  const [split, setSplit] = useState(() => clampSplit(initialSplit));
  const splitContainer = useRef<HTMLDivElement | null>(null);

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
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-3.5 rounded-[4px] bg-gradient-to-br from-primary via-chart-5 to-primary shadow-[0_0_18px_-2px] shadow-primary/60"
          />
          <span className="text-xs font-semibold tracking-[0.14em] uppercase">Larpable</span>
          <Badge variant="outline" className="font-mono text-[10px]">
            v{version}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs sm:text-[13px]">
          Websites, built inside a Linux machine in your browser.
        </p>
      </header>

      {statusBar}

      <main ref={splitContainer} className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section
          aria-labelledby="agent-heading"
          data-testid="agent-pane"
          data-basis={split.toFixed(2)}
          style={{ "--agent-basis": `${split.toFixed(2)}%` } as CSSProperties}
          className="flex min-h-0 flex-1 flex-col lg:flex-none lg:basis-[var(--agent-basis)]"
        >
          <h2
            id="agent-heading"
            className="text-muted-foreground border-b px-4 py-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-6"
          >
            Agent
          </h2>
          {settings}
          <div className="flex min-h-0 flex-1 flex-col">
            {chat}
            {terminal ? (
              <div className="flex min-h-0 flex-1 flex-col p-3">{terminal}</div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
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
          aria-labelledby="preview-heading"
          className="flex min-h-0 flex-1 flex-col lg:min-w-0"
        >
          <h2
            id="preview-heading"
            className="text-muted-foreground border-b px-4 py-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-6"
          >
            Preview
          </h2>
          {preview ? (
            <div className="flex min-h-0 flex-1 flex-col">{preview}</div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
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

      <section aria-labelledby="diagnostics-heading" className="border-t bg-card/40">
        <h2 id="diagnostics-heading" className="sr-only">
          This browser
        </h2>
        <button
          type="button"
          data-testid="diagnostics-toggle"
          aria-expanded={diagnosticsOpen}
          aria-controls="diagnostics-body"
          onClick={() => setDiagnosticsOpen((open) => !open)}
          className="text-muted-foreground hover:bg-muted/60 flex w-full items-center gap-2 border-b px-4 py-2.5 text-left text-[11px] font-semibold tracking-[0.1em] uppercase transition-colors sm:px-6"
        >
          <ChevronRight
            aria-hidden="true"
            className={cn("size-3.5 transition-transform", diagnosticsOpen && "rotate-90")}
          />
          This browser
          <StatusDot
            testId="requirements-status"
            tone={requirementsTone(passed)}
            label={`Requirements: ${String(passed)}/3 met`}
            className="ml-auto"
          />
        </button>

        {diagnosticsOpen && (
          <div id="diagnostics-body">
            <div className="grid gap-3 p-4 sm:p-6 lg:grid-cols-2">
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
              <ul className="text-muted-foreground space-y-1.5 px-4 pb-4 text-xs sm:px-6">
                {support.problems.map((problem) => (
                  <li key={problem} className="flex gap-2">
                    <X aria-hidden="true" className="text-destructive mt-0.5 size-3.5 shrink-0" />
                    <span>{problem}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <footer
        aria-live="polite"
        className="bg-muted/40 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t px-4 py-2 font-mono text-[11.5px] sm:px-6"
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
