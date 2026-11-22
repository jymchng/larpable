/**
 * Browser capability detection for the unkernel environment.
 *
 * unkernel runs a real Linux kernel compiled to WebAssembly, which needs two
 * things from the host browser:
 *
 * 1. **JSPI** (`WebAssembly.Suspending`) — task switches in the guest kernel
 *    suspend and resume host promises. Without it the kernel cannot boot.
 * 2. **Cross-origin isolation** (`SharedArrayBuffer`) — needed for the worker
 *    transport and for SMP (several CPUs, one shared memory).
 *
 * Detecting this up front lets the UI explain exactly what is missing instead of
 * failing somewhere inside a 10 MB boot.
 */

export interface SupportProbe {
  /** `globalThis.crossOriginIsolated` */
  crossOriginIsolated: boolean;
  /** `typeof WebAssembly.Suspending === "function"` */
  jspi: boolean;
  /** `typeof SharedArrayBuffer === "function"` */
  sharedArrayBuffer: boolean;
}

export interface SupportReport {
  /** True when the environment can boot with the worker transport and SMP. */
  ok: boolean;
  /** Human-readable, actionable description of every missing capability. */
  problems: string[];
  probe: SupportProbe;
  /** True when the report was produced by the dev-only simulation below, never by the browser. */
  simulated?: boolean;
}

export function evaluateSupport(probe: SupportProbe): SupportReport {
  const problems: string[] = [];

  if (!probe.jspi) {
    problems.push(
      "This browser lacks WebAssembly JSPI (WebAssembly.Suspending). unkernel needs it to boot; use Chrome/Edge 137+, Firefox 153+, or Safari 27+.",
    );
  }

  if (!probe.crossOriginIsolated) {
    problems.push(
      "This page is not cross-origin isolated, so SharedArrayBuffer is unavailable; the worker transport and multi-CPU guests are disabled. Serve the app with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.",
    );
  }

  if (!probe.sharedArrayBuffer) {
    problems.push(
      "SharedArrayBuffer is unavailable in this context, so the guest must run on the page thread.",
    );
  }

  return { ok: problems.length === 0, problems, probe };
}

declare const WebAssembly: { Suspending?: unknown } & typeof globalThis.WebAssembly;

/** Probe the current browser. Never throws: every field is a plain boolean. */
export function detectSupport(): SupportReport {
  const sharedArrayBuffer = typeof globalThis.SharedArrayBuffer === "function";

  return evaluateSupport({
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    jspi: typeof WebAssembly.Suspending === "function",
    sharedArrayBuffer,
  });
}

/**
 * Dev-only: make the unsupported-browser path reachable on a browser that *is*
 * supported.
 *
 * The failure this path prevents (a spinner forever because JSPI is missing) is only
 * observable on an old browser, which CI does not have — so `?simulateSupport=no-jspi`
 * substitutes a probe with JSPI missing and the real rendering path runs against it.
 * The report is marked `simulated`, the UI says so, and the production build ignores
 * the parameter entirely, so it can never make a real browser look supported.
 */
export function applySupportSimulation(
  report: SupportReport,
  search: string,
  dev: boolean,
): SupportReport {
  if (!dev) return report;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (params.get("simulateSupport") !== "no-jspi") return report;

  return { ...evaluateSupport({ ...report.probe, jspi: false }), simulated: true };
}
