/**
 * The environment card: boot the machine, watch it come up, and prove it works.
 *
 * Presentational on purpose — every value arrives as a prop, so the whole component
 * renders deterministically in tests and the unsupported-browser branch can be
 * exercised without an old browser.
 *
 * The unsupported branch shows the *actual* problems the support probe reported,
 * including the JSPI explanation with browser versions, and renders no boot button at
 * all: offering a button that cannot work is the silent failure PRD §5.3 forbids.
 */

import { Check, Cpu, FlaskConical, Info, Loader2, Power, PowerOff, TriangleAlert, X } from "lucide-react";

import type { SelfTestResult } from "@/env/self-test";
import { handsetNotes, type HandsetFacts } from "@/ui/mobile";
import type { EnvironmentSnapshot } from "@/env/status";
import { statusLabel } from "@/env/status";
import type { SupportReport } from "@/env/support";
import { Badge } from "@/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { IconButton } from "@/ui/components/icon-button";

export interface EnvironmentPanelProps {
  support: SupportReport;
  snapshot: EnvironmentSnapshot;
  stage: string | null;
  busy: boolean;
  selfTest: SelfTestResult | null;
  selfTestBusy: boolean;
  bootDurationMs?: number | null;
  error: string | null;
  /**
   * The device, when the caller knows it. Its notes are the *phone-specific* half of a boot
   * problem: which engine an iPhone can actually use, how much memory the guest needs, and the
   * one habit that keeps a mobile tab alive. Absent on a desktop render, which then shows the
   * plain support problems and nothing extra.
   */
  handset?: HandsetFacts;
  /**
   * Drop the card's framing and keep its controls.
   *
   * The panel is the body of the debug popover now (goal #33: "the environment card kept only
   * for the Boot / self-test / Shut down controls it owns"), so the title "Linux environment",
   * a description of Debian and the card's own border would be a third paragraph about the
   * machine in a surface that already says what it is. Everything a person *acts* on — the
   * status badges, the three icon buttons, the boot stage, the error and the self-test report —
   * stays exactly as it was.
   */
  compact?: boolean;
  onBoot: () => void;
  onSelfTest: () => void;
  onShutdown: () => void;
}

const STATUS_VARIANT = {
  idle: "muted",
  initializing: "warning",
  booting: "warning",
  ready: "success",
  error: "destructive",
  stopped: "muted",
} as const;

export function EnvironmentPanel({
  support,
  snapshot,
  stage,
  busy,
  selfTest,
  selfTestBusy,
  bootDurationMs,
  error,
  handset,
  compact = false,
  onBoot,
  onSelfTest,
  onShutdown,
}: EnvironmentPanelProps) {
  const ready = snapshot.status === "ready";
  // Computed here rather than passed in so the wording cannot drift between callers, and only
  // when the caller said which device it is: a desktop has nothing to gain from either note.
  const notes = handset === undefined ? [] : handsetNotes(support, handset);

  const content = (
    <>
        {notes.length > 0 && (
          <ul data-testid="handset-notes" className="space-y-1.5 text-[11.5px]">
            {notes.map((note) => (
              <li
                key={note.text}
                data-tone={note.tone}
                className={
                  note.tone === "warn"
                    ? "flex gap-2 rounded-md border border-warning/30 bg-warning/10 p-2"
                    : "text-muted-foreground flex gap-2 p-2"
                }
              >
                <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                <span>{note.text}</span>
              </li>
            ))}
          </ul>
        )}

        {!support.ok ? (
          // In compact mode the popover's Requirements section already lists these problems
          // (with the same wording, from the same report), so the card does not say them twice.
          compact ? null : (
          <div
            data-testid="support-problems"
            role="alert"
            className="border-destructive/40 bg-destructive/10 space-y-1 rounded-lg border p-2"
          >
            <p className="text-destructive flex items-center gap-2 text-sm font-medium">
              <TriangleAlert aria-hidden="true" className="size-4" />
              This browser cannot boot Linux
            </p>
            <ul className="text-muted-foreground space-y-1.5 text-xs">
              {support.problems.map((problem) => (
                <li key={problem} className="flex gap-2">
                  <X aria-hidden="true" className="text-destructive mt-0.5 size-3.5 shrink-0" />
                  <span>{problem}</span>
                </li>
              ))}
            </ul>
            {support.simulated && (
              <p className="text-muted-foreground text-[11px] italic">
                Simulated probe (dev only): this run pretends JSPI is missing so the
                unsupported path can be checked in a browser that has it.
              </p>
            )}
          </div>
          )
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1">
              <Badge data-testid="env-status" variant={STATUS_VARIANT[snapshot.status]}>
                {statusLabel(snapshot.status)}
              </Badge>
              {snapshot.distro && (
                <Badge data-testid="env-distro" variant="outline" className="font-mono text-[10px]">
                  {snapshot.distro}
                </Badge>
              )}
              {snapshot.cpus !== null && (
                <Badge data-testid="env-cpus" variant="outline" className="font-mono text-[10px]">
                  {snapshot.cpus} CPU{snapshot.cpus === 1 ? "" : "s"}
                </Badge>
              )}
              {snapshot.memoryMiB !== null && (
                <Badge data-testid="env-memory" variant="outline" className="font-mono text-[10px]">
                  {snapshot.memoryMiB} MiB
                </Badge>
              )}
              {ready && bootDurationMs != null && (
                <Badge
                  data-testid="boot-duration"
                  variant="outline"
                  className="font-mono text-[10px]"
                >
                  booted in {(bootDurationMs / 1000).toFixed(1)} s
                </Badge>
              )}
            </div>

            {/* Three pictograms, because this row is read once and then recognised: a green
                power arrow for "boot", a flask for "prove it", a red one for "stop". The words
                are the accessible name and the tooltip, not painted text (see icon-button.tsx). */}
            <div className="flex flex-wrap items-center gap-1.5">
              <IconButton
                testId="boot-button"
                label={busy ? "Booting…" : "Boot Linux"}
                hint="Boot a Debian machine from WebAssembly in this tab"
                tone="run"
                onClick={onBoot}
                disabled={busy || ready || snapshot.status === "booting"}
              >
                {busy ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Power aria-hidden="true" />
                )}
              </IconButton>
              <IconButton
                testId="self-test-button"
                label={selfTestBusy ? "Checking…" : "Run self-test"}
                hint="Prove the guest answers and the workspace round-trips"
                onClick={onSelfTest}
                disabled={!ready || selfTestBusy}
              >
                {selfTestBusy ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <FlaskConical aria-hidden="true" />
                )}
              </IconButton>
              <IconButton
                testId="shutdown-button"
                label="Shut down"
                hint="Stop the guest and end every shell attached to it"
                tone="stop"
                onClick={onShutdown}
                disabled={!ready || busy}
              >
                <PowerOff aria-hidden="true" />
              </IconButton>
            </div>

            {stage && (
              <p data-testid="boot-stage" className="text-muted-foreground font-mono text-[11px]">
                {stage}
              </p>
            )}

            {error && (
              <p
                data-testid="boot-error"
                role="alert"
                className="text-destructive rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs"
              >
                {error}
              </p>
            )}

            {selfTest && <SelfTestReport result={selfTest} />}
          </>
        )}
    </>
  );

  if (compact) {
    // No card, no header, no description: the popover's own "Machine" caption says what this
    // is, and the controls are the reason it is here.
    return (
      <div data-testid="environment-panel" data-compact="true" className="space-y-1.5">
        {content}
      </div>
    );
  }

  return (
    <Card data-testid="environment-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Cpu aria-hidden="true" className="size-4" />
          Linux environment
        </CardTitle>
        <CardDescription>
          A real Debian machine, booted from WebAssembly in this tab. Nothing runs on a server.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-1.5">{content}</CardContent>
    </Card>
  );
}

function SelfTestReport({ result }: { result: SelfTestResult }) {
  return (
    <div className="space-y-1 rounded-lg border p-2" data-testid="self-test-report">
      <p
        data-testid="self-test-summary"
        className={result.ok ? "text-success text-sm font-medium" : "text-destructive text-sm font-medium"}
      >
        {result.ok ? "The guest answered and the workspace round-trips." : "The guest failed a check."}{" "}
        <span className="text-muted-foreground font-mono text-[11px]">{result.durationMs} ms</span>
      </p>
      <ul className="space-y-1.5">
        {result.steps.map((step) => (
          <li key={step.name} className="flex gap-2 text-[13px]">
            {step.ok ? (
              <Check aria-hidden="true" className="text-success mt-0.5 size-3.5 shrink-0" />
            ) : (
              <X aria-hidden="true" className="text-destructive mt-0.5 size-3.5 shrink-0" />
            )}
            <span className="min-w-0">
              <span className="font-medium">{step.label}</span>{" "}
              <span
                data-testid={`self-test-${step.name}`}
                className="text-muted-foreground font-mono text-[11px] break-words"
              >
                {step.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {result.uname && (
        <p className="text-muted-foreground font-mono text-[11px] break-words" data-testid="uname-output">
          {result.uname}
        </p>
      )}
    </div>
  );
}
