/**
 * The pane's job is to be honest about four situations, and this file asserts the words and
 * the markup, not the wiring: a phase in, a control and a state out.
 *
 * Rendered with `renderToStaticMarkup` like the rest of the UI tests, because what matters is
 * what the browser receives — a disabled control, a real sandbox string, a URL with the build
 * in it — rather than an effect having run.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PREVIEW_IFRAME_SANDBOX } from "../src/preview/sandbox";
import { PREVIEW_PREFIX } from "../src/preview/routing";
import type { PreviewPhase } from "../src/preview/controller";
import {
  PreviewPane,
  PreviewToolbar,
  describeAppPreview,
  describePreviewPhase,
  mergePreviewStates,
  toAppPreviewState,
  toPreviewState,
} from "../src/ui/preview-pane";
import type { AppPreviewControl } from "../src/ui/use-app-preview";
import type { BuildControl } from "../src/ui/use-build";

function render(phase: PreviewPhase, available = true): string {
  return renderToStaticMarkup(
    <PreviewPane phase={phase} onRefresh={() => undefined} available={available} />,
  );
}

const ready: PreviewPhase = {
  kind: "ready",
  buildId: "build-mf3k2-1",
  url: `${PREVIEW_PREFIX}/build-mf3k2-1/`,
  files: 14,
  served: "worker",
  note: null,
};

describe("toPreviewState", () => {
  it("maps every phase onto a pane state, with no phase left out", () => {
    expect(toPreviewState({ kind: "idle" })).toEqual({ kind: "idle" });
    expect(toPreviewState({ kind: "starting", detail: "…" })).toEqual({
      kind: "building",
      buildId: null,
    });
    expect(toPreviewState({ kind: "publishing", buildId: "b-1", detail: "…" })).toEqual({
      kind: "building",
      buildId: "b-1",
    });
    expect(toPreviewState(ready)).toMatchObject({ kind: "ready", buildId: "build-mf3k2-1" });
    // A failure that never reached HTTP carries no status, rather than a made-up one.
    expect(toPreviewState({ kind: "failed", message: "no build" })).toEqual({
      kind: "error",
      status: null,
      message: "no build",
    });
  });
});

describe("describePreviewPhase", () => {
  it("says which build and how many files, not just \"ready\"", () => {
    expect(describePreviewPhase(ready)).toBe("Serving 14 files from the preview worker.");
  });

  it("names the guest as the server when the worker is not holding the build", () => {
    expect(
      describePreviewPhase({ ...ready, served: "guest", files: 1, note: "no worker" }),
    ).toBe("Serving from the guest on demand: 1 file.");
  });

  it("repeats the controller's own detail while it works", () => {
    expect(describePreviewPhase({ kind: "starting", detail: "Starting the guest's server…" })).toBe(
      "Starting the guest's server…",
    );
  });
});

describe("PreviewPane", () => {
  it("renders the iframe at the published build's URL with the product's sandbox", () => {
    const html = render(ready);

    expect(html).toContain(`src="${PREVIEW_PREFIX}/build-mf3k2-1/"`);
    expect(html).toContain(`sandbox="${PREVIEW_IFRAME_SANDBOX}"`);
    expect(html).toContain('data-build-id="build-mf3k2-1"');
    expect(html).toContain('data-testid="preview-iframe"');
  });

  it("offers a preview control and a status line before anything is published", () => {
    const html = render({ kind: "idle" });

    expect(html).toContain('data-testid="preview-build"');
    expect(html).toContain("Preview build");
    expect(html).toContain('data-testid="preview-status"');
    expect(html).toContain("No preview published yet.");
    // No iframe: there is no URL to point one at, and a blank frame is indistinguishable
    // from a site that renders nothing.
    expect(html).not.toContain("<iframe");
  });

  it("disables the control while there is no machine to ask", () => {
    const html = render({ kind: "idle" }, false);

    expect(html).toMatch(/data-testid="preview-build"[^>]*disabled/);
  });

  it("disables the control while a publish is already running", () => {
    for (const phase of [
      { kind: "starting", detail: "Starting the guest's server…" } as const,
      { kind: "publishing", buildId: "b-1", detail: "Reading 3 files out of the guest…" } as const,
    ]) {
      const html = render(phase);
      expect(html).toMatch(/data-testid="preview-build"[^>]*disabled/);
      expect(html).toContain('data-testid="preview-status"');
    }
  });

  it("shows the failure's own words instead of a blank pane", () => {
    const html = render({
      kind: "failed",
      message: "There is no build to preview: dist/ is empty or missing in the guest.",
    });

    expect(html).toContain("The preview could not load.");
    expect(html).toContain("There is no build to preview");
    // A null status is not printed as a number no server sent.
    expect(html).not.toContain("null —");
  });

  it("states that the guest is serving when the worker could not", () => {
    const html = render({ ...ready, served: "guest", note: "This browser has no worker." });

    expect(html).toContain('data-testid="preview-served-by"');
    expect(html).toContain("guest");
  });
});

describe("PreviewToolbar", () => {
  it("offers a rebuild once a build is published", () => {
    const html = renderToStaticMarkup(
      <PreviewToolbar phase={ready} onRefresh={() => undefined} available />,
    );

    expect(html).toContain("Rebuild preview");
    expect(html).not.toMatch(/data-testid="preview-build"[^>]*disabled/);
  });
});

/**
 * "Run the app" — the second way to fill this pane, for a project with a server and no
 * `dist/`. These assertions are the acceptance criterion in miniature: after `bun run start`
 * the iframe must point at a build id of the *app*, the toolbar must say which command
 * answered, and stopping must be offered rather than hidden.
 */
function appControl(
  state: AppPreviewControl["state"],
  calls: { run?: () => void; stop?: () => void } = {},
): AppPreviewControl {
  return {
    state,
    run: calls.run ?? (() => undefined),
    stop: calls.stop ?? (() => undefined),
  };
}

function renderApp(app: AppPreviewControl, phase: PreviewPhase = { kind: "idle" }, available = true): string {
  return renderToStaticMarkup(
    <PreviewPane phase={phase} onRefresh={() => undefined} available={available} app={app} />,
  );
}

describe("PreviewPane with a running app", () => {
  it("points the frame at the app's own build id and stops offering to start it", () => {
    const html = renderApp(
      appControl({ kind: "running", buildId: "app-mf3k2", port: 3000, command: "bun run start", status: 200 }),
    );

    expect(html).toContain(`src="${PREVIEW_PREFIX}/app-mf3k2/"`);
    expect(html).toContain('data-testid="preview-stop-app"');
    expect(html).not.toContain('data-testid="preview-run-app"');
    // The only way out is to stop it: offering "Run the app" while one is running would
    // spawn a second server on the same port.
    expect(html).toContain("Stop app");
  });

  it("says which command answered and on which port, instead of just \"running\"", () => {
    const html = renderApp(
      appControl({ kind: "running", buildId: "app-1", port: 3000, command: "bun run start", status: 200 }),
    );

    expect(html).toContain("`bun run start` answered 200 on guest port 3000.");
  });

  it("shows a start in progress as a placeholder with the hook's own words, not a blank frame", () => {
    const html = renderApp(appControl({ kind: "starting", message: "Starting `bun run start` in the guest on port 3000…" }));

    expect(html).not.toContain("<iframe");
    expect(html).toContain("Building the site…");
    expect(html).toMatch(/data-testid="preview-run-app"[^>]*disabled/);
  });

  it("offers to run it again after a failure and keeps the reason", () => {
    const html = renderApp(
      appControl({ kind: "failed", message: "package.json has no `start` script, so there is no app to run." }),
    );

    expect(html).toContain("Run the app again");
    expect(html).toContain("package.json has no `start` script");
    expect(html).not.toContain("<iframe");
  });

  it("keeps a published static build on screen when the app fails to start", () => {
    // The build is real; an app that failed must not make it look gone. The failure is still
    // on the status line, so nothing is hidden.
    const merged = mergePreviewStates(ready, appControl({ kind: "failed", message: "next start exited" }));

    expect(merged).toMatchObject({ kind: "ready", buildId: "build-mf3k2-1" });
    const html = renderApp(appControl({ kind: "failed", message: "next start exited" }), ready);
    expect(html).toContain(`src="${PREVIEW_PREFIX}/build-mf3k2-1/"`);
    expect(html).toContain("next start exited");
  });

  it("lets the running app win over an older published build", () => {
    expect(
      mergePreviewStates(ready, appControl({ kind: "running", buildId: "app-9", port: 3000, command: "bun run start", status: 200 })),
    ).toMatchObject({ kind: "ready", buildId: "app-9" });
  });

  it("maps every app state, with none left out", () => {
    expect(toAppPreviewState(undefined)).toBeNull();
    expect(toAppPreviewState(appControl({ kind: "idle" }))).toBeNull();
    expect(toAppPreviewState(appControl({ kind: "starting", message: "…" }))).toEqual({
      kind: "building",
      buildId: null,
    });
    expect(
      toAppPreviewState(appControl({ kind: "running", buildId: "app-2", port: 3000, command: "c", status: 200 })),
    ).toMatchObject({ kind: "ready", buildId: "app-2" });
    expect(toAppPreviewState(appControl({ kind: "failed", message: "no start" }))).toEqual({
      kind: "error",
      status: null,
      message: "no start",
    });
  });

  it("describes an idle app without pretending one is running", () => {
    expect(describeAppPreview({ kind: "idle" })).toBe(
      "No app running: “Run the app” starts the project’s own start script.",
    );
    expect(describeAppPreview(undefined)).toBeNull();
  });

  it("keeps the old toolbar when there is no app control at all", () => {
    // Callers without a `useAppPreview` (and the acceptance run's static page) are unchanged.
    const html = render(ready);

    expect(html).not.toContain('data-testid="preview-run-app"');
    expect(html).not.toContain('data-testid="preview-stop-app"');
    expect(html).not.toContain('data-testid="preview-app-status"');
  });
});

describe("build strip", () => {
  function control(overrides: Partial<BuildControl> = {}): BuildControl {
    return {
      status: { kind: "none" },
      busy: false,
      problem: null,
      run: () => undefined,
      cancel: () => undefined,
      port: null,
      ...overrides,
    };
  }

  function renderWithBuild(build: BuildControl): string {
    return renderToStaticMarkup(
      <PreviewPane phase={ready} onRefresh={() => undefined} available build={build} />,
    );
  }

  it("is absent when the caller has no build, so the old pane is unchanged", () => {
    const html = render(ready);

    expect(html).not.toContain('data-testid="preview-build-strip"');
    expect(html).not.toContain('data-testid="preview-install-build"');
  });

  it("says no build has run yet, and offers the button that fixes it", () => {
    const html = renderWithBuild(control());

    expect(html).toContain('data-testid="preview-build-strip"');
    expect(html).toContain("No build has run yet.");
    expect(html).toContain("Install &amp; build");
    expect(html).not.toContain('data-testid="preview-cancel-build"');
  });

  it("shows the run's stage and cancel instead of a second start", () => {
    const html = renderWithBuild(control({ status: { kind: "running", stage: "building" }, busy: true }));

    expect(html).toContain("Building the site in the guest");
    expect(html).toContain('data-testid="preview-cancel-build"');
    // One control for one run: the start button is disabled while it is in flight.
    expect(html).toMatch(/data-testid="preview-install-build"[^>]*disabled/);
  });

  it("states a failure in the manager's own words, and offers a rebuild", () => {
    const html = renderWithBuild(
      control({ status: { kind: "failed", summary: "src/main.ts(3,1): error TS2322" } }),
    );

    expect(html).toContain("The build failed: src/main.ts(3,1): error TS2322");
    expect(html).toContain("text-destructive");
    expect(html).toContain("Install &amp; build");
  });

  it("labels a successful build with its id and duration, and says Rebuild", () => {
    const html = renderWithBuild(control({ status: { kind: "ok", id: "build-3", durationMs: 4200 } }));

    expect(html).toContain("Build build-3 succeeded in 4.2 s.");
    expect(html).toContain("Rebuild");
  });

  it("disables the button and prints why when the machine cannot build", () => {
    const problem = "The Linux machine is stopped, so the build has nowhere to run yet.";
    const html = renderWithBuild(control({ problem }));

    expect(html).toMatch(/data-testid="preview-install-build"[^>]*disabled/);
    expect(html).toContain('data-testid="preview-build-problem"');
    expect(html).toContain(problem);
  });
});
