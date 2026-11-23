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

import { Check, Cpu, FlaskConical, Loader2, Power, PowerOff, TriangleAlert, X } from "lucide-react";

import type { SelfTestResult } from "@/env/self-test";
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
  onBoot,
  onSelfTest,
  onShutdown,
}: EnvironmentPanelProps) {
  const ready = snapshot.status === "ready";

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

      <CardContent className="space-y-3">
        {!support.ok ? (
          <div
            data-testid="support-problems"
            role="alert"
            className="border-destructive/40 bg-destructive/10 space-y-2 rounded-lg border p-3"
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
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
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
      </CardContent>
    </Card>
  );
}

function SelfTestReport({ result }: { result: SelfTestResult }) {
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="self-test-report">
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
