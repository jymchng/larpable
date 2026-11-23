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
  it("says nothing for a published preview: the frame is the message", () => {
    // Removed on request: "Serving 3 files from the preview worker." — a file count nobody acts
    // on, and the served-by badge that followed it is gone too (only the `guest` fallback keeps
    // one).
    expect(describePreviewPhase(ready)).toBe("");
    expect(
      describePreviewPhase({ ...ready, served: "guest", files: 1, note: "no worker" }),
    ).toBe("");
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

  it("offers publishing through the bar's reload arrow with no idle sentence", () => {
    const html = render({ kind: "idle" });

    // The toolbar's own publish button was removed on request; the circling arrow beside the
    // address bar is the publish control now, so it must be live before the first build lands.
    expect(html).not.toContain('data-testid="preview-build"');
    expect(html).toMatch(/data-testid="preview-reload"(?![^>]*disabled)/);
    // The idle sentence was removed on request, so there is no status row to read either.
    expect(html).not.toContain("No preview published yet.");
    expect(html).not.toContain('data-testid="preview-status"');
    // No iframe: there is no URL to point one at, and a blank frame is indistinguishable
    // from a site that renders nothing.
    expect(html).not.toContain("<iframe");
  });

  it("disables publishing while there is no machine to ask", () => {
    const html = render({ kind: "idle" }, false);

    expect(html).toMatch(/data-testid="preview-reload"[^>]*disabled/);
  });

  it("disables publishing while one is already running", () => {
    for (const phase of [
      { kind: "starting", detail: "Starting the guest's server…" } as const,
      { kind: "publishing", buildId: "b-1", detail: "Reading 3 files out of the guest…" } as const,
    ]) {
      const html = render(phase);
      expect(html).toMatch(/data-testid="preview-reload"[^>]*disabled/);
      // "Starting the guest's server…" / "Reading 3 files out of the guest…" are toasts now
      // (user request: "ALL NOTIFICATIONS SHOULD BE TOASTS IN APPROPRIATE COLORS"), so there is
      // no status line in the pane to read — and nothing for a screenshot to quote.
      expect(html).not.toContain('data-testid="preview-status"');
      expect(html).not.toContain(phase.detail);
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

  it("states that the guest is serving, as an attribute rather than a badge", () => {
    const html = render({ ...ready, served: "guest", note: "This browser has no worker." });

    // The controller's answer is still readable — as the attribute the acceptance run reads. The
    // warning-coloured `guest` badge was removed on request: in dev mode the guest answers every
    // request, so it was the pane complaining about the mode the Prod switch exists to provide.
    expect(html).toContain('data-served="guest"');
    expect(html).not.toContain('data-testid="preview-served-by"');
  });

  it("says nothing about the worker, because the worker is the normal answer", () => {
    // Removed on request: a green `worker` badge and the row that held it appeared the moment a
    // build was published, stating the expected outcome in the colour reserved for news. The
    // controller's answer is still readable — as an attribute, not as a badge or a sentence.
    const html = render(ready);

    expect(html).not.toContain('data-testid="preview-served-by"');
    expect(html).not.toContain('data-testid="preview-toolbar"');
    expect(html).not.toContain(">worker<");
    expect(html).toContain('data-served="worker"');
  });
});

describe("PreviewToolbar", () => {
  // The row exists for one answer only now — the app server — so a guest-served build (which is
  // every dev preview) renders no row at all. What is worth asserting is that the controls that
  // used to live in that row are somewhere real, and that the row does not come back for the two
  // cases it was removed from.
  const guest: PreviewPhase = { ...ready, served: "guest", note: "This browser has no worker." };

  it("has no publish button of its own any more", () => {
    // Removed on request: the circling arrow in the browser bar publishes, and a second green
    // button in this row was the same job in a different place.
    const html = render(guest);

    expect(html).not.toContain('data-testid="preview-build"');
    expect(html).not.toContain("Rebuild preview");
    // The arrow that does the job is in the chrome, and it is enabled whenever a build *can* be
    // published — which is what makes it a publish control and not only a reload.
    expect(html).toContain('data-testid="preview-reload"');
    expect(html).not.toContain('data-testid="preview-toolbar"');
  });

  it("has handed the device control to the browser chrome", () => {
    // The three presets used to live here, in the same row as "Preview build". They are a
    // browser's device toolbar now (`preview-chrome.tsx`), so the pane has one place that
    // sizes the frame and states the size, not two.
    const html = render(guest);

    expect(html).toContain('data-testid="preview-viewports"');
    expect(html).not.toContain('data-testid="preview-toolbar"');
  });

  it("renders no row at all when the worker holds the build", () => {
    // The badge went, and the div went with it (user request): a bordered strip with nothing in
    // it would still cost the pane a row of height.
    expect(renderToStaticMarkup(<PreviewToolbar phase={ready} />)).toBe("");
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
    // No "Run the app" control and no stop control exist any more (both removed with the
    // toolbar's publish button on request), so nothing can spawn a second server on that port.
    expect(html).not.toContain('data-testid="preview-run-app"');
    expect(html).not.toContain('data-testid="preview-stop-app"');
  });

  it("says which command answered and on which port, in the toast rather than the pane", () => {
    const running = appControl({
      kind: "running",
      buildId: "app-1",
      port: 3000,
      command: "bun run start",
      status: 200,
    });
    const html = renderApp(running);

    // The sentence is still the app's own words, and still exact — it is now a success toast
    // (`notifications.ts`), which is the version visible from the other pane as well.
    expect(describeAppPreview(running.state)).toBe("`bun run start` answered 200 on guest port 3000.");
    expect(html).not.toContain("answered 200");
    // What the pane keeps is the fact: the badge that says the bytes come from the app.
    expect(html).toContain('data-testid="preview-served-by"');
    expect(html).toContain(">app<");
  });

  it("shows a start in progress as a placeholder with the hook's own words, not a blank frame", () => {
    const html = renderApp(appControl({ kind: "starting", message: "Starting `bun run start` in the guest on port 3000…" }));

    expect(html).not.toContain("<iframe");
    expect(html).toContain("Building the site…");
    // The button that used to carry this state's disabled attribute is gone (removed on request).
    expect(html).not.toContain('data-testid="preview-run-app"');
  });

  it("keeps the failure's own reason on the status line", () => {
    const html = renderApp(appControl({ kind: "failed", message: "No `start` script in package.json." }));

    expect(html).not.toContain('data-testid="preview-run-app"');
    expect(html).toContain("No `start` script in package.json.");
    expect(html).not.toContain("<iframe");
  });

  it("keeps a published static build on screen when the app fails to start", () => {
    // The build is real; an app that failed must not make it look gone. The failure is still
    // on the status line, so nothing is hidden.
    const merged = mergePreviewStates(ready, appControl({ kind: "failed", message: "next start exited" }));

    expect(merged).toMatchObject({ kind: "ready", buildId: "build-mf3k2-1" });
    const html = renderApp(appControl({ kind: "failed", message: "next start exited" }), ready);
    expect(html).toContain(`src="${PREVIEW_PREFIX}/build-mf3k2-1/"`);
    // The failure is announced by a danger toast rather than printed in the pane's row, so the
    // build stays on screen *and* the reason is not lost: it is the toast's sentence.
    expect(html).not.toContain("next start exited");
    expect(describeAppPreview({ kind: "failed", message: "next start exited" })).toBe("next start exited");
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
    expect(describeAppPreview({ kind: "idle" })).toBeNull();
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

  it("shows the hammer in the device row and says nothing before the first build", () => {
    const html = renderWithBuild(control());

    // The sentence ("No build has run yet.") was removed on request, and the strip is not
    // rendered for a silent phase; the hammer is in the device row with the width buttons.
    expect(html).not.toContain("No build has run yet.");
    expect(html).toContain("Install &amp; build");
    expect(html).toContain('data-testid="preview-viewports"');
    expect(html).not.toContain('data-testid="preview-cancel-build"');
  });

  it("points an empty pane at the hammer, and only when the hammer is on screen", () => {
    // User request: "when there is no preview show that there is no preview and a hint to click on
    // the Hammer button". The hint is `PreviewPane`'s to write, because this is the file that
    // renders the hammer — `PreviewPanel` owns the chrome, not the build manager.
    const withHammer = renderToStaticMarkup(
      <PreviewPane phase={{ kind: "idle" }} onRefresh={() => undefined} available build={control()} />,
    );

    expect(withHammer).toContain('data-kind="idle"');
    expect(withHammer).toContain("No preview yet.");
    expect(withHammer).toContain("Click the hammer above");
    expect(withHammer).toContain("Install &amp; build");

    // A caller with no build control has no hammer, so the placeholder must not name one.
    const withoutHammer = renderToStaticMarkup(
      <PreviewPane phase={{ kind: "idle" }} onRefresh={() => undefined} available />,
    );

    expect(withoutHammer).toContain("No preview yet.");
    expect(withoutHammer).not.toContain("Click the hammer above");
    expect(withoutHammer).not.toContain('data-testid="preview-install-build"');
  });

  it("shows the run's stage as a toast, and Cancel instead of a second start", () => {
    const html = renderWithBuild(control({ status: { kind: "running", stage: "building" }, busy: true }));

    // "Building the site in the guest…" is an info toast now; the row it used to occupy is gone.
    expect(html).not.toContain("Building the site in the guest");
    expect(html).not.toContain('data-testid="preview-build-strip"');
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

  it("turns the hammer into Rebuild after a success, which the toast announces", () => {
    const html = renderWithBuild(control({ status: { kind: "ok", id: "build-3", durationMs: 4200 } }));

    // The success sentence ("Build build-3 succeeded in 4.2 s.") is a green toast now; the pane
    // keeps no receipt for it, because the frame appearing *is* the receipt.
    expect(html).not.toContain("succeeded in 4.2 s.");
    expect(html).not.toContain('data-testid="preview-build-strip"');
    expect(html).toContain("Rebuild");
  });

  it("disables the button and keeps the reason in its tooltip, not in a line of its own", () => {
    const problem = "The Linux machine is stopped, so the build has nowhere to run yet.";
    const html = renderWithBuild(control({ problem }));

    expect(html).toMatch(/data-testid="preview-install-build"[^>]*disabled/);
    // The sentence is announced as a toast (it is the machine's state) and, for a mouse user who
    // asks the button itself, in its `title` — never laid out a third time above the frame
    // (user request: "DO NOT DUPLICATE: YOU ALREADY HAVE A TOAST").
    expect(html).not.toContain('data-testid="preview-build-problem"');
    expect(html).not.toContain('data-testid="preview-build-strip"');
    expect(html).toContain(`title="${problem}"`);
  });
});
