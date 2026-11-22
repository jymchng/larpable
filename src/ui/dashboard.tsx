import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Terminal, TriangleAlert, X } from "lucide-react";

import type { DistroSummary } from "@/env/distro";
import type { EnvironmentSnapshot } from "@/env/status";
import { describeEnvironment } from "@/env/status";
import type { SupportReport } from "@/env/support";
import { Badge } from "@/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { cn } from "@/lib/utils";

export interface DashboardProps {
  version: string;
  support: SupportReport;
  environment: EnvironmentSnapshot;
  distro: DistroSummary;
  /** The live boot card. Injected so the dashboard stays a pure function of its props. */
  environmentPanel?: ReactNode;
  /**
   * The guest terminal. Injected for the same reason as the boot card: the dashboard
   * renders it without knowing there is a Linux machine behind it.
   */
  terminal?: ReactNode;
}

/**
 * The presentational shell. It takes every value it shows as a prop, so it renders
 * identically in tests (no fetch, no VM) and can never display state the caller
 * did not supply.
 */
export function Dashboard({
  version,
  support,
  environment,
  distro,
  environmentPanel,
  terminal,
}: DashboardProps) {
  // Open by default: this report is why a boot button is disabled when it is, and
  // hiding that behind a collapsed panel would hide the explanation. The user
  // collapses it once they have read it.
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(true);
  const passed = [
    support.probe.jspi,
    support.probe.crossOriginIsolated,
    support.probe.sharedArrayBuffer,
  ].filter(Boolean).length;

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

      <main className="grid min-h-0 flex-1 grid-cols-1 divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
        <section aria-labelledby="agent-heading" className="flex min-h-0 flex-col">
          <h2
            id="agent-heading"
            className="text-muted-foreground border-b px-4 py-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-6"
          >
            Agent
          </h2>
          {terminal ? (
            <div className="flex min-h-0 flex-1 flex-col p-3">{terminal}</div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
              <Terminal aria-hidden="true" className="text-muted-foreground/60 size-6" />
              <p className="text-sm font-medium">The agent has nothing to work with yet.</p>
              <p className="text-muted-foreground max-w-[42ch] text-[13px]">
                Describe a website here once the Linux environment reports ready.
              </p>
            </div>
          )}
        </section>

        <section aria-labelledby="preview-heading" className="flex min-h-0 flex-col">
          <h2
            id="preview-heading"
            className="text-muted-foreground border-b px-4 py-2.5 text-[11px] font-semibold tracking-[0.1em] uppercase sm:px-6"
          >
            Preview
          </h2>
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center">
            <TriangleAlert aria-hidden="true" className="text-muted-foreground/60 size-6" />
            <p className="text-sm font-medium">No production build yet.</p>
            <p className="text-muted-foreground max-w-[42ch] text-[13px]">
              The preview renders the real <code className="font-mono">dist/</code> output built
              inside the guest, never a mock page.
            </p>
          </div>
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
          <Badge
            variant={passed === 3 ? "success" : "warning"}
            className="ml-auto font-mono text-[10px] normal-case"
          >
            {passed}/3 requirements
          </Badge>
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
