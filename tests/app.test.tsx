import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { App } from "../src/ui/App";
import { describeEnvironment, INITIAL_ENVIRONMENT, statusLabel } from "../src/env/status";

describe("App shell", () => {
  it("renders the brand, both panes and the browser capability report", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Larpable");
    expect(html).toContain("Agent");
    expect(html).toContain("Preview");
    expect(html).toContain("WebAssembly JSPI");
    expect(html).toContain("Cross-origin isolation");
  });

  it("starts from an idle environment instead of claiming a running one", () => {
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain(`Linux: ${statusLabel("idle")}`);
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
