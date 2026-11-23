/**
 * The debug popover: closed by default, named, and holding the facts that used to be a band.
 *
 * User request, the session after the machine learned to boot itself: "Put all the above in the
 * debug popover, change the debug information into a popover, make it more concise" \u2014 where
 * "the above" was the six facts the status bar painted across the window (Linux, runtime,
 * project, build, Netlify, preview).
 *
 * This is a *static-markup* test, which is the only layer this suite has for layout: the real
 * Escape / press-outside / focus behaviour belongs to `Popover` and is measured in Chromium by
 * `bun run acceptance:debug` and `bun run acceptance:popover`. What can be asserted here is the
 * thing a refactor would silently undo: the facts are *inside* the surface, there is no second
 * copy of them in the layout, and the controls the environment card owns are reachable there.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { summarizeDistro, type DistroAssetStatus } from "../src/env/distro";
import { INITIAL_ENVIRONMENT } from "../src/env/status";
import { evaluateSupport } from "../src/env/support";
import type { StatusInput } from "../src/ui/status-bar";
import { StatusFacts } from "../src/ui/status-bar-view";
import { Dashboard, DEBUG_POPOVER_ID } from "../src/ui/dashboard";
import { EnvironmentPanel } from "../src/ui/environment-panel";
import { NO_TERMINAL } from "../src/ui/terminal-connection";

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

/** The six facts, in the state the user quoted: everything up, nothing built or deployed yet. */
const FACTS: StatusInput = {
  environment: {
    status: "ready",
    runtime: "node (guest shim)",
    distro: "debian",
    cpus: 4,
    memoryMiB: 2048,
    error: null,
  },
  project: { name: null, root: "/workspace" },
  build: { kind: "none" },
  netlify: { kind: "unknown" },
  preview: { kind: "idle" },
  terminal: NO_TERMINAL,
};

function render(options: { support?: typeof supported; withPanel?: boolean } = {}): string {
  return renderToStaticMarkup(
    <Dashboard
      version="9.9.9"
      support={options.support ?? supported}
      environment={FACTS.environment}
      distro={summarizeDistro([debianAsset], null)}
      statusFacts={<StatusFacts input={FACTS} />}
      {...(options.withPanel === false
        ? {}
        : {
            environmentPanel: (
              <EnvironmentPanel
                support={options.support ?? supported}
                snapshot={FACTS.environment}
                stage={null}
                busy={false}
                selfTest={null}
                selfTestBusy={false}
                error={null}
                onBoot={() => undefined}
                onSelfTest={() => undefined}
                onShutdown={() => undefined}
                compact
              />
            ),
          })}
    />,
  );
}

/** Everything after the surface's opening tag, so "inside the popover" is not a guess. */
function surface(html: string): string {
  const start = html.indexOf(`id="${DEBUG_POPOVER_ID}"`);
  expect(start).toBeGreaterThan(-1);
  return html.slice(start);
}

describe("the debug popover", () => {
  it("is closed by default, hidden, and still in the DOM so aria-controls resolves", () => {
    const html = render();

    expect(html).toMatch(new RegExp(`id="${DEBUG_POPOVER_ID}"[^>]*data-state="closed"`));
    expect(html).toMatch(new RegExp(`id="${DEBUG_POPOVER_ID}"[^>]*class="[^"]*\\bhidden\\b`));
    expect(html).toMatch(/data-testid="diagnostics-toggle"[^>]*aria-expanded="false"/);
  });

  it("carries an accessible name from its own visible title", () => {
    const html = render();

    expect(html).toMatch(new RegExp(`id="${DEBUG_POPOVER_ID}"[^>]*role="dialog"`));
    expect(html).toContain(`aria-labelledby="${DEBUG_POPOVER_ID}-heading"`);
    expect(html).toContain(`id="${DEBUG_POPOVER_ID}-heading"`);
    expect(html).toContain(">Debug</h2>");
    // Not modal: the conversation behind it stays readable, and nothing is trapped.
    expect(html).toContain('aria-modal="false"');
  });

  it("holds all six facts, with no second copy in the layout", () => {
    const html = render();
    const panel = surface(html);

    for (const key of ["linux", "runtime", "project", "build", "netlify", "preview"]) {
      expect(panel).toContain(`data-testid="status-${key}"`);
      expect(panel).toContain(`data-value=`);
    }
    // The values the user quoted are the ones rendered from the same derivation.
    expect(panel).toContain('data-value="Ready"');
    expect(panel).toContain('data-value="node (guest shim)"');
    expect(panel).toContain('data-value="/workspace"');
    expect(panel).toContain('data-value="not validated"');
    // Exactly one list, and it is after the surface opens.
    expect(html.match(/data-testid="status-facts"/g)).toHaveLength(1);
    expect(html.indexOf('data-testid="status-facts"')).toBeGreaterThan(
      html.indexOf(`id="${DEBUG_POPOVER_ID}"`),
    );
    // Nothing of the old band survives outside the header.
    expect(html.indexOf('data-testid="status-facts"')).toBeLessThan(html.indexOf("</header>"));
    expect(html).not.toContain('data-testid="status-bar"');
  });

  it("keeps the Boot, self-test and Shut down controls reachable inside it", () => {
    const panel = surface(render());

    for (const testId of ["boot-button", "self-test-button", "shutdown-button"]) {
      expect(panel).toContain(`data-testid="${testId}"`);
    }
    // The compact card drops its framing, not its controls.
    expect(panel).toContain('data-testid="environment-panel" data-compact="true"');
  });

  it("states the requirements as one line, with the three checks in the detail", () => {
    const html = render();

    expect(html).toContain('data-testid="requirements-summary"');
    // One line: the count, not three tick rows.
    expect(html).toContain(">3/3 met<");
    expect(html).not.toContain("(supported)");
    expect(html).not.toContain("(unsupported)");
    // The per-check answers are not lost, they are in the line's tooltip and the dot's name.
    expect(html).toContain("WebAssembly JSPI: available");
    expect(html).toContain("Cross-origin isolation: isolated");
    expect(html).toContain("SharedArrayBuffer: available");
  });

  it("keeps the one-line requirement answer honest when a check is missing", () => {
    const partial = evaluateSupport({ crossOriginIsolated: false, jspi: true, sharedArrayBuffer: false });
    const panel = surface(render({ support: partial }));

    expect(panel).toContain(">1/3 met<");
    expect(panel).toContain("WebAssembly JSPI: available");
    expect(panel).toContain("Cross-origin isolation: not isolated");
    expect(panel).toContain("SharedArrayBuffer: missing");
    // The problems themselves are listed once, under the line, rather than repeated by the
    // compact boot card inside the same popover.
    expect(panel).toContain('data-testid="requirement-problems"');
    expect(panel).toContain("WebAssembly JSPI");
    expect(panel).not.toContain('data-testid="support-problems"');
  });

  it("shows the Linux image on one line, with the download state as its tone", () => {
    const panel = surface(render());

    expect(panel).toContain('data-testid="image-line"');
    expect(panel).toContain("Linux image");
    expect(panel).toContain("debian");
  });
});
