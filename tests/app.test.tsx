import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dashboard } from "../src/ui/dashboard";
import { EnvironmentPanel } from "../src/ui/environment-panel";
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

  it("offers an accessible toggle for the browser report", () => {
    const html = renderDashboard();

    expect(html).toContain('data-testid="diagnostics-toggle"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="diagnostics-body"');
    expect(html).toContain('id="diagnostics-body"');
    expect(html).toContain("3/3 requirements");
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
