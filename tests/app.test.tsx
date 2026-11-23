import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dashboard, DEBUG_POPOVER_ID } from "../src/ui/dashboard";
import { SettingsPanel } from "../src/ui/settings-panel";
import { defaultSettings } from "../src/llm/settings";
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
    environment: typeof INITIAL_ENVIRONMENT;
    boot: { busy: boolean; stage?: string | null; error?: string | null; onRetry: () => void };
  }> = {},
) {
  return renderToStaticMarkup(
    <Dashboard
      version="9.9.9"
      support={overrides.support ?? supported}
      environment={overrides.environment ?? INITIAL_ENVIRONMENT}
      distro={overrides.distro ?? summarizeDistro([debianAsset], null)}
      {...(overrides.boot === undefined ? {} : { boot: overrides.boot })}
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

  describe("the boot spinner beside the wordmark", () => {
    const onRetry = () => undefined;

    it("turns while the machine boots, with a name a screen reader can read", () => {
      const html = renderDashboard({
        environment: { ...INITIAL_ENVIRONMENT, status: "booting" },
        boot: { busy: true, stage: "runtime: Detecting JavaScript runtimes", error: null, onRetry },
      });

      expect(html).toContain('data-testid="boot-spinner"');
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-label="Starting Linux"');
      expect(html).toContain("animate-spin");
      // The stage the adapter reported is the tooltip, so the spinner is never a bare guess.
      expect(html).toContain('title="runtime: Detecting JavaScript runtimes"');
    });

    it("turns during the window before the adapter exists, because busy is real state", () => {
      const html = renderDashboard({
        boot: { busy: true, stage: "Creating the Linux machine", error: null, onRetry },
      });

      expect(html).toContain('data-testid="boot-spinner"');
      expect(html).toContain('title="Creating the Linux machine"');
    });

    it("is gone once the machine is ready: there is nothing left to wait for", () => {
      const html = renderDashboard({
        environment: { ...INITIAL_ENVIRONMENT, status: "ready", distro: "debian" },
        boot: { busy: false, stage: null, error: null, onRetry },
      });

      expect(html).not.toContain('data-testid="boot-spinner"');
      expect(html).not.toContain('data-testid="boot-failed"');
      expect(html).toContain(`Linux: ${statusLabel("ready")}`);
    });

    it("stops turning on a stopped machine, and does not offer to restart it", () => {
      const html = renderDashboard({
        environment: { ...INITIAL_ENVIRONMENT, status: "stopped" },
        boot: { busy: false, stage: null, error: null, onRetry },
      });

      expect(html).not.toContain('data-testid="boot-spinner"');
      expect(html).not.toContain('data-testid="boot-failed"');
    });

    it("becomes the machine's own error plus a retry when the boot failed", () => {
      const html = renderDashboard({
        environment: { ...INITIAL_ENVIRONMENT, status: "error", error: "the kernel worker exited with code 1" },
        boot: { busy: false, stage: null, error: "the kernel worker exited with code 1", onRetry },
      });

      expect(html).not.toContain('data-testid="boot-spinner"');
      expect(html).toContain('data-testid="boot-failed"');
      expect(html).toContain('role="alert"');
      expect(html).toContain("Linux failed to start");
      expect(html).toContain("the kernel worker exited with code 1");
      expect(html).toContain('aria-label="Retry starting Linux"');
    });

    it("shows no spinner on a browser that cannot boot, and no retry either", () => {
      const unsupported = evaluateSupport({
        crossOriginIsolated: false,
        jspi: false,
        sharedArrayBuffer: false,
      });
      const html = renderDashboard({
        support: unsupported,
        environment: { ...INITIAL_ENVIRONMENT, status: "booting" },
        boot: { busy: true, stage: null, error: null, onRetry },
      });

      expect(html).not.toContain('data-testid="boot-spinner"');
      expect(html).not.toContain('data-testid="boot-failed"');
      // The existing, honest answer is still there: the requirements dot and its count, which now
      // carry the verdict in words instead of repeating it in a second footer line.
      expect(html).toContain("this browser cannot boot the kernel");
    });

    it("draws no boot chrome when the dashboard was not given a boot action", () => {
      const html = renderDashboard();

      expect(html).not.toContain('data-testid="boot-spinner"');
      expect(html).not.toContain('data-testid="boot-failed"');
    });
  });

  it("says the kernel cannot boot when a requirement is missing, and why", () => {
    const unsupported = evaluateSupport({
      crossOriginIsolated: false,
      jspi: false,
      sharedArrayBuffer: false,
    });
    const html = renderDashboard({ support: unsupported });

    expect(html).toContain("this browser cannot boot the kernel");
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

  it("offers an accessible toggle for the debug popover", () => {
    const html = renderDashboard();

    expect(html).toContain('data-testid="diagnostics-toggle"');
    // Closed until asked for: the report is debugging, not product, and it is a popover now
    // rather than a sheet in the layout.
    expect(html).toMatch(/data-testid="diagnostics-toggle"[^>]*aria-expanded="false"/);
    expect(html).toContain(`aria-controls="${DEBUG_POPOVER_ID}"`);
    expect(html).toContain(`id="${DEBUG_POPOVER_ID}"`);
    // A real dialog, named by its own visible title: the semantics and the dismissal come from
    // `Popover` rather than from a second, hand-rolled implementation.
    expect(html).toMatch(new RegExp(`id="${DEBUG_POPOVER_ID}"[^>]*role="dialog"`));
    expect(html).toContain(`aria-labelledby="${DEBUG_POPOVER_ID}-heading"`);
    expect(html).toContain('aria-label="Close debug"');
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
        statusFacts={<div data-testid="injected-status-facts" />}
        settings={<div data-testid="injected-settings" />}
        chat={<div data-testid="injected-chat" />}
      />,
    );

    // The facts are inside the debug popover, which is header chrome: above the panes, but not
    // a band of its own across them.
    expect(html.indexOf('data-testid="injected-status-facts"')).toBeGreaterThan(
      html.indexOf(`id="${DEBUG_POPOVER_ID}"`),
    );
    expect(html.indexOf('data-testid="injected-status-facts"')).toBeLessThan(
      html.indexOf('data-testid="main-panes"'),
    );
    // Settings moved to the header's right edge (user request: "Put the Provider Settings under
    // Header at the most Right"), so they render above the panes rather than inside the agent one.
    expect(html.indexOf('data-testid="injected-settings"')).toBeGreaterThan(
      html.indexOf('data-testid="diagnostics-toggle"'),
    );
    expect(html.indexOf('data-testid="injected-settings"')).toBeLessThan(
      html.indexOf('data-testid="main-panes"'),
    );
    expect(html.indexOf('data-testid="injected-chat"')).toBeGreaterThan(
      html.indexOf('data-testid="injected-settings"'),
    );
  });

  it("puts the provider in a popover beside the Agent heading, closed until asked for", () => {
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

    // A disclosure, not a banner: one icon button with a name, a state and a target. The name
    // does not change with the state — `aria-expanded` carries it — so the control can be
    // asked for by the same words twice.
    expect(html).toContain('data-testid="settings-toggle"');
    expect(html).toContain('aria-label="Provider settings"');
    expect(html).toContain('title="Provider, model and API key"');
    expect(html).toMatch(/data-testid="settings-toggle"[^>]*aria-expanded="false"/);
    expect(html).toMatch(/data-testid="settings-toggle"[^>]*aria-controls="settings-region"/);
    // The cog carries the settings, and the settings start hidden but present.
    expect(html.indexOf('data-testid="settings-toggle"')).toBeLessThan(
      html.indexOf('data-testid="injected-settings"'),
    );
    expect(html).toMatch(/id="settings-region"[^>]*data-state="closed"/);
    expect(html).toMatch(/id="settings-region"[^>]*class="[^"]*\bhidden\b/);
    // A labelled dialog whose name comes from its own visible title, so the words are painted
    // once and announced once rather than twice through two wrappers.
    expect(html).toMatch(/id="settings-region"[^>]*role="dialog"/);
    expect(html).toMatch(/id="settings-region"[^>]*aria-labelledby="settings-region-heading"/);
    expect(html).toContain('id="settings-region-heading"');
    expect(html).toContain('aria-label="Close provider settings"');
    // The heading keeps naming the pane for a screen reader even where it is not painted.
    expect(html).toContain('id="agent-heading"');
  });

  it("renders the popover open, with the fields inside it, when it starts open", () => {
    const html = renderToStaticMarkup(
      <Dashboard
        version="9.9.9"
        support={supported}
        environment={INITIAL_ENVIRONMENT}
        distro={summarizeDistro([debianAsset], null)}
        settings={<SettingsPanel settings={defaultSettings()} onChange={() => undefined} />}
        chat={<div data-testid="injected-chat" />}
        initialSettingsOpen
      />,
    );

    expect(html).toMatch(/data-testid="settings-toggle"[^>]*aria-expanded="true"/);
    expect(html).toMatch(/id="settings-region"[^>]*data-state="open"/);
    expect(html).not.toMatch(/id="settings-region"[^>]*class="[^"]*\bhidden\b/);
    // The provider, model and key fields are unchanged, and they are *inside* the dialog.
    expect(html.indexOf('id="settings-region"')).toBeLessThan(
      html.indexOf('data-testid="settings-panel"'),
    );
    for (const testId of ["settings-provider-demo", "settings-model", "settings-key"]) {
      expect(html).toContain(`data-testid="${testId}"`);
    }
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
