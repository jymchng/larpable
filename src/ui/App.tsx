import { useMemo } from "react";

import { describeEnvironment, INITIAL_ENVIRONMENT, statusLabel } from "../env/status";
import { detectSupport, type SupportReport } from "../env/support";

/**
 * Application shell.
 *
 * At this stage the shell is deliberately thin: it renders the browser
 * capability report and the environment status that the environment manager will
 * drive. Chat and preview panes exist so their layout is fixed early, and each
 * pane states the real reason it is empty rather than showing sample data.
 */
export function App() {
  const support = useMemo(() => detectSupport(), []);
  const environment = INITIAL_ENVIRONMENT;

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Larpable</span>
          <span className="brand-version">v{__APP_VERSION__}</span>
        </div>
        <p className="tagline">Websites, built inside a Linux machine in your browser.</p>
      </header>

      <main className="workspace">
        <section className="pane pane-agent" aria-labelledby="agent-heading">
          <h2 id="agent-heading" className="pane-heading">
            Agent
          </h2>
          <div className="pane-body">
            <p className="empty-title">The agent has nothing to work with yet.</p>
            <p className="empty-hint">
              Describe a website here once the Linux environment reports{" "}
              <code>{statusLabel("ready").toLowerCase()}</code>.
            </p>
          </div>
        </section>

        <section className="pane pane-preview" aria-labelledby="preview-heading">
          <h2 id="preview-heading" className="pane-heading">
            Preview
          </h2>
          <div className="pane-body">
            <p className="empty-title">No production build yet.</p>
            <p className="empty-hint">
              The preview renders the real <code>dist/</code> output built inside the guest,
              never a mock page.
            </p>
          </div>
        </section>
      </main>

      <section className="diagnostics" aria-labelledby="diagnostics-heading">
        <h2 id="diagnostics-heading" className="pane-heading">
          This browser
        </h2>
        <SupportList support={support} />
      </section>

      <footer className="status-bar" aria-live="polite">
        <span className="status-summary">{describeEnvironment(environment)}</span>
        <span className={`status-chip status-${environment.status}`}>
          {support.ok ? "Kernel can boot" : "Kernel cannot boot here"}
        </span>
      </footer>
    </div>
  );
}

function SupportList({ support }: { support: SupportReport }) {
  const checks = [
    {
      label: "WebAssembly JSPI",
      ok: support.probe.jspi,
      detail: support.probe.jspi ? "available" : "missing",
    },
    {
      label: "Cross-origin isolation",
      ok: support.probe.crossOriginIsolated,
      detail: support.probe.crossOriginIsolated ? "isolated" : "not isolated",
    },
    {
      label: "SharedArrayBuffer",
      ok: support.probe.sharedArrayBuffer,
      detail: support.probe.sharedArrayBuffer ? "available" : "missing",
    },
  ];

  return (
    <>
      <ul className="checks">
        {checks.map((check) => (
          <li key={check.label} className={check.ok ? "check check-ok" : "check check-bad"}>
            <span className="check-icon" aria-hidden="true">
              {check.ok ? "✓" : "✗"}
            </span>
            <span className="check-label">{check.label}</span>
            <span className="check-detail">{check.detail}</span>
            <span className="visually-hidden">{check.ok ? " (supported)" : " (unsupported)"}</span>
          </li>
        ))}
      </ul>
      {support.problems.length > 0 && (
        <ul className="problems">
          {support.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </>
  );
}
