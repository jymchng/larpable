import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Dashboard } from "../src/ui/dashboard";
import { summarizeDistro, type DistroAssetStatus } from "../src/env/distro";
import { describeEnvironment, INITIAL_ENVIRONMENT, statusLabel } from "../src/env/status";
import { evaluateSupport } from "../src/env/support";

const supported = evaluateSupport({
  crossOriginIsolated: true,
  jspi: true,
  sharedArrayBuffer: true,
});

const alpineAsset: DistroAssetStatus = {
  entry: {
    name: "alpine",
    file: "alpine.erofs",
    size: 4_046_848,
    sha256: "02460df31c14772659bb347a651693ac9aaa7a8c2477f05e4e5e4d5c756dd567",
    image: "alpine-3.24.4-e0d59c37c0882d76",
  },
  url: "/distros/alpine.erofs",
  present: true,
  bytes: 4_046_848,
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
      distro={overrides.distro ?? summarizeDistro([alpineAsset], null)}
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
      distro: summarizeDistro([{ ...alpineAsset, present: false, bytes: null }], null),
    });

    expect(html).toContain("not downloaded");
    expect(html).toContain("bun run fetch:distros");
  });

  it("shows the image size when it is actually served", () => {
    expect(renderDashboard()).toContain("3.9 MiB");
  });
});

describe("describeEnvironment", () => {
  it("reports only the values the environment actually has", () => {
    expect(describeEnvironment(INITIAL_ENVIRONMENT)).toBe("Linux: Not started");
  });

  it("includes distro, runtime, resources and error once known", () => {
    const summary = describeEnvironment({
      status: "ready",
      distro: "alpine 3.24",
      runtime: "bun 1.4.5",
      cpus: 2,
      memoryMiB: 512,
      error: null,
    });

    expect(summary).toBe(
      "Linux: Ready | Distro: alpine 3.24 | Runtime: bun 1.4.5 | CPUs: 2 | Memory: 512 MiB",
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
