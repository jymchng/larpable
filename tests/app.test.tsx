import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dashboard } from "../src/ui/dashboard";
import { EnvironmentPanel } from "../src/ui/environment-panel";
import { PreviewPane } from "../src/ui/preview-pane";
import { summarizeDistro, type DistroAssetStatus } from "../src/env/distro";
import { describeEnvironment, INITIAL_ENVIRONMENT, statusLabel } from "../src/env/status";
import { applySupportSimulation, evaluateSupport } from "../src/env/support";

const supported = evaluateSupport({
  crossOriginIsolated: true,
  jspi: true,
  sharedArrayBuffer: true,
});

const debianAsset: DistroAssetStatus = {
  entry: {
    name: "debian",
    file: "debian.erofs",
    size: 72_593_408,
    sha256: "d5894fa27ee868108c56c8a635d122687937c741f26535296e7b61b5e2c2f5e8",
    image: "debian-13.7-a6bb4b5e547bc28a",
  },
  url: "/distros/debian.erofs",
  present: true,
  bytes: 72_593_408,
};

function renderDashboard(
  overrides: Partial<{
    support: typeof supported;
    distro: ReturnType<typeof summarizeDistro>;
  }> = {},
) {
  return renderToStaticMarkup(
    <Dashboard
      version="9.9.9"
      support={overrides.support ?? supported}
      environment={INITIAL_ENVIRONMENT}
      distro={overrides.distro ?? summarizeDistro([debianAsset], null)}
    />,
  );
}

describe("Dashboard", () => {
  it("renders the brand, both panes and the browser capability report", () => {
    const html = renderDashboard();

    expect(html).toContain("Larpable");
    expect(html).toContain("v9.9.9");
    expect(html).toContain("Agent");
    expect(html).toContain("Preview");
    expect(html).toContain("WebAssembly JSPI");
    expect(html).toContain("Cross-origin isolation");
  });

  it("starts from an idle environment instead of claiming a running one", () => {
    expect(renderDashboard()).toContain(`Linux: ${statusLabel("idle")}`);
  });

  it("says the kernel cannot boot when a requirement is missing, and why", () => {
    const unsupported = evaluateSupport({
      crossOriginIsolated: false,
      jspi: false,
      sharedArrayBuffer: false,
    });
    const html = renderDashboard({ support: unsupported });

    expect(html).toContain("Kernel cannot boot here");
    expect(html).toContain("WebAssembly JSPI");
    expect(html).toContain("Chrome/Edge 137+");
  });

  it("offers the fetch command when the Linux image is absent", () => {
    const html = renderDashboard({
      distro: summarizeDistro([{ ...debianAsset, present: false, bytes: null }], null),
    });

    expect(html).toContain("not downloaded");
    expect(html).toContain("bun run fetch:distros");
  });

  it("shows the image size when it is actually served", () => {
    expect(renderDashboard()).toContain("69.2 MiB");
  });

  it("puts the guest terminal in the agent pane when one is supplied", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        version="9.9.9"
        support={supported}
        environment={INITIAL_ENVIRONMENT}
        distro={summarizeDistro([debianAsset], null)}
        terminal={<div data-testid="terminal-slot">shell</div>}
      />,
    );

    expect(html).toContain('data-testid="terminal-slot"');
    // The placeholder is what a dashboard with no terminal shows, not both at once.
    expect(html).not.toContain("The agent has nothing to work with yet.");
  });

  it("puts the preview pane in the preview section when one is supplied", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        version="9.9.9"
        support={supported}
        environment={INITIAL_ENVIRONMENT}
        distro={summarizeDistro([debianAsset], null)}
        preview={
          <PreviewPane
            phase={{
              kind: "ready",
              buildId: "build-mf3k2-1",
              url: "/__preview__/build-mf3k2-1/",
              files: 14,
              served: "worker",
              note: null,
            }}
            onRefresh={() => undefined}
            available
          />
        }
      />,
    );

    // A supplied pane is a real frame, not the placeholder that promises one.
    expect(html).toContain('data-testid="preview-iframe"');
    expect(html).toContain('data-build-id="build-mf3k2-1"');
    expect(html).not.toContain("No production build yet.");
  });

  it("offers an accessible toggle for the browser report", () => {
    const html = renderDashboard();

    expect(html).toContain('data-testid="diagnostics-toggle"');
    // Closed until asked for: the report is debugging, not product, and it no longer
    // occupies a band above the footer.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="diagnostics-body"');
    expect(html).toContain('id="diagnostics-body"');
  });

  it("shows the requirement count as a green dot, not a sentence in the toolbar", () => {
    const html = renderDashboard();

    expect(html).toContain('data-testid="requirements-status"');
    expect(html).toContain('data-tone="green"');
    // The words are still there for a screen reader and a tooltip…
    expect(html).toContain('aria-label="Requirements: 3/3 met"');
    expect(html).toContain('title="Requirements: 3/3 met"');
    // …but nothing is painted between the toggle's label and the dot.
    expect(html).not.toContain("3/3 requirements");
    expect(html).not.toContain(">3/3<");
  });

  it("paints the dot amber while requirements are partly met, and red when none are", () => {
    const partial = evaluateSupport({
      crossOriginIsolated: false,
      jspi: true,
      sharedArrayBuffer: false,
    });
    const partialHtml = renderDashboard({ support: partial });
    expect(partialHtml).toContain('data-tone="amber"');
    expect(partialHtml).toContain('aria-label="Requirements: 1/3 met"');

    const none = evaluateSupport({
      crossOriginIsolated: false,
      jspi: false,
      sharedArrayBuffer: false,
    });
    const noneHtml = renderDashboard({ support: none });
    expect(noneHtml).toContain('data-tone="red"');
    expect(noneHtml).toContain('aria-label="Requirements: 0/3 met"');
  });
});

describe("describeEnvironment", () => {
  it("reports only the values the environment actually has", () => {
    expect(describeEnvironment(INITIAL_ENVIRONMENT)).toBe("Linux: Not started");
  });

  it("includes distro, runtime, resources and error once known", () => {
    const summary = describeEnvironment({
      status: "ready",
      distro: "debian 13.7",
      runtime: "bun 1.4.5",
      cpus: 2,
      memoryMiB: 512,
      error: null,
    });

    expect(summary).toBe(
      "Linux: Ready | Distro: debian 13.7 | Runtime: bun 1.4.5 | CPUs: 2 | Memory: 512 MiB",
    );
  });

  it("surfaces the error text when the environment failed", () => {
    const summary = describeEnvironment({
      ...INITIAL_ENVIRONMENT,
      status: "error",
      error: "JSPI missing",
    });

    expect(summary).toBe("Linux: Error | Error: JSPI missing");
  });
});

describe("Dashboard §13 layout", () => {
  it("renders the injected status bar, settings and conversation where they belong", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        version="9.9.9"
        support={supported}
        environment={INITIAL_ENVIRONMENT}
        distro={summarizeDistro([debianAsset], null)}
        statusBar={<div data-testid="injected-status-bar" />}
        settings={<div data-testid="injected-settings" />}
        chat={<div data-testid="injected-chat" />}
      />,
    );

    // The bar is about the whole window, so it sits under the header and above the panes.
    expect(html.indexOf('data-testid="injected-status-bar"')).toBeLessThan(
      html.indexOf('data-testid="agent-pane"'),
    );
    // Settings are part of the agent pane: they are the provider the conversation uses.
    expect(html.indexOf('data-testid="injected-settings"')).toBeGreaterThan(
      html.indexOf('data-testid="agent-pane"'),
    );
    expect(html.indexOf('data-testid="injected-chat"')).toBeGreaterThan(
      html.indexOf('data-testid="injected-settings"'),
    );
  });

  it("puts the provider behind a cog beside the Agent heading, closed until asked for", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        version="9.9.9"
        support={supported}
        environment={INITIAL_ENVIRONMENT}
        distro={summarizeDistro([debianAsset], null)}
        settings={<div data-testid="injected-settings" />}
        chat={<div data-testid="injected-chat" />}
      />,
    );

    // A disclosure, not a banner: one icon button with a name, a state and a target.
    expect(html).toContain('data-testid="settings-toggle"');
    expect(html).toContain('aria-label="Provider settings"');
    expect(html).toContain('title="Provider, model and API key"');
    expect(html).toMatch(/data-testid="settings-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/data-testid="settings-toggle"[^>]*aria-controls="settings-region"/);
    // The cog carries the settings, and the settings start hidden but present.
    expect(html.indexOf('data-testid="settings-toggle"')).toBeLessThan(
      html.indexOf('data-testid="injected-settings"'),
    );
    expect(html).toMatch(/id="settings-region" class="hidden"/);
    // The heading keeps naming the pane for a screen reader even where it is not painted.
    expect(html).toContain('id="agent-heading"');
  });

  it("offers a real separator with the split's own bounds announced", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        version="9.9.9"
        support={supported}
        environment={INITIAL_ENVIRONMENT}
        distro={summarizeDistro([debianAsset], null)}
        initialSplit={63}
      />,
    );

    expect(html).toContain('data-testid="split-handle"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuenow="63"');
    expect(html).toContain('aria-valuemin="20"');
    expect(html).toContain('aria-valuemax="80"');
    // The width lives in a custom property the pane's flex-basis reads, so a drag is one number.
    expect(html).toContain("--agent-basis:63.00%");
    expect(html).toContain('data-basis="63.00"');
  });

  it("clamps a stored split outside the usable band", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        version="9.9.9"
        support={supported}
        environment={INITIAL_ENVIRONMENT}
        distro={summarizeDistro([debianAsset], null)}
        initialSplit={4}
      />,
    );

    expect(html).toContain('aria-valuenow="20"');
  });
});
