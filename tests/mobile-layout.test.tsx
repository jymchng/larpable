/**
 * The phone layout, asserted where it can be: in the markup a browser receives, and in the
 * stylesheet that does the hiding.
 *
 * There is no DOM in this suite (every UI test here renders with `renderToStaticMarkup`), so the
 * division of labour is deliberate — and it matches where the decision actually lives:
 *
 * - **Markup**: `data-stage` on the panes' container, `data-pane` on each pane, two switcher
 *   buttons with `aria-pressed` and `aria-controls`, and 44 px target classes on the controls'
 *   shared component. Both panes are always present, because a streaming reply must survive the
 *   user looking at the preview, and because the desktop layout needs them.
 * - **Stylesheet**: the `@media (max-width: 1023.98px)` block that turns `data-stage` into
 *   `display: none`, the safe-area tokens, the iOS text-size guard, and the overscroll reset.
 * - **Browser**: `scripts/mobile-acceptance.ts` (`bun run acceptance:mobile`) — real presses at
 *   390 x 844 and 844 x 390, real rectangles for the targets, real `scrollWidth <= clientWidth`.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { summarizeDistro } from "../src/env/distro";
import { INITIAL_ENVIRONMENT, statusLabel } from "../src/env/status";
import { evaluateSupport } from "../src/env/support";
import type { LlmSettings } from "../src/llm/settings";
import { ChatPanel } from "../src/ui/chat-panel";
import { Dashboard } from "../src/ui/dashboard";
import { EnvironmentPanel } from "../src/ui/environment-panel";
import { initialChat } from "../src/ui/chat";
import { StageSwitcher } from "../src/ui/stage-switcher";
import { StatusBar } from "../src/ui/status-bar-view";
import type { HandsetFacts } from "../src/ui/mobile";
import { TOUCH_TARGET_BLOCK, TOUCH_TARGET_ICON, TOUCH_TARGET_MIN_PX } from "../src/ui/touch";

const root = resolve(import.meta.dirname, "..");
const globals = readFileSync(resolve(root, "src/ui/globals.css"), "utf8");
const indexHtml = readFileSync(resolve(root, "index.html"), "utf8");

const supported = evaluateSupport({
  crossOriginIsolated: true,
  jspi: true,
  sharedArrayBuffer: true,
});
const noJspi = evaluateSupport({ crossOriginIsolated: true, jspi: false, sharedArrayBuffer: true });

const distro = summarizeDistro([], null);

const settings: LlmSettings = { provider: "demo", model: "demo", apiKey: "" };

/** A complete, valid status input: the bar derives six segments from it and one of them has to
 *  be able to fail, so the shape is the real one rather than a placeholder. */
const STATUS_INPUT = {
  environment: INITIAL_ENVIRONMENT,
  project: { name: null, root: "/workspace" },
  build: { kind: "failed", summary: "TS2307: cannot find module" },
  netlify: { kind: "ok" },
  preview: { kind: "idle" },
} as const;

function dashboard(overrides: { stage?: "agent" | "preview"; preview?: boolean } = {}): string {
  return renderToStaticMarkup(
    <Dashboard
      version="9.9.9"
      support={supported}
      environment={INITIAL_ENVIRONMENT}
      distro={distro}
      statusBar={<StatusBar input={STATUS_INPUT} />}
      settings={<div data-testid="settings-slot" />}
      chat={
        <ChatPanel
          state={initialChat()}
          onSend={() => undefined}
          onStop={() => undefined}
          unavailableReason="Boot the Linux environment before asking the agent to build anything."
        />
      }
      {...(overrides.preview === true ? { preview: <div data-testid="preview-slot" /> } : {})}
      {...(overrides.stage === undefined ? {} : { initialStage: overrides.stage })}
    />,
  );
}

describe("the phone opens on one pane, with a switcher above it", () => {
  it("renders both panes and marks which stage is showing", () => {
    const html = dashboard();

    expect(html).toContain('data-testid="main-panes"');
    expect(html).toContain('data-stage="agent"');
    expect(html).toContain('data-pane="agent"');
    expect(html).toContain('data-pane="preview"');
    expect(html).toContain('id="agent-pane"');
    expect(html).toContain('id="preview-pane"');
  });

  it("keeps the other pane mounted, so a run keeps streaming while the preview is read", () => {
    // The CSS hides it; React does not unmount it. A conditional render would throw away the
    // chat's scroll position, the terminal's shell and any reply still arriving.
    expect(dashboard({ stage: "preview" })).toContain('data-testid="agent-pane"');
    expect(dashboard({ stage: "agent", preview: true })).toContain('data-testid="preview-slot"');
    expect(dashboard({ stage: "preview", preview: true })).toContain('data-testid="preview-slot"');
  });

  it("opens on the stage a link asked for", () => {
    expect(dashboard({ stage: "preview" })).toContain('data-stage="preview"');
    expect(dashboard({ stage: "agent" })).toContain('data-stage="agent"');
  });

  it("offers two pressed buttons that control the two panes", () => {
    const html = dashboard();

    expect(html).toContain('data-testid="stage-switcher"');
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Which pane to show"');
    expect(html).toContain('data-testid="stage-tab-agent"');
    expect(html).toContain('data-testid="stage-tab-preview"');
    // Pressed and unpressed, both announced, both pointing at a real element.
    expect(html).toMatch(/data-testid="stage-tab-agent"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-testid="stage-tab-preview"[^>]*aria-pressed="false"/);
    expect(html).toContain('aria-controls="agent-pane"');
    expect(html).toContain('aria-controls="preview-pane"');
    // The stage is visible in the markup, not only in the stylesheet.
    expect(html).toContain('data-selected="true"');
  });

  it("swaps which button is pressed when the stage changes", () => {
    const html = dashboard({ stage: "preview" });

    expect(html).toMatch(/data-testid="stage-tab-preview"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/data-testid="stage-tab-agent"[^>]*aria-pressed="false"/);
  });

  it("hands the tabs a 44 px target and hides itself from the laptop layout", () => {
    const html = renderToStaticMarkup(
      <StageSwitcher stage="agent" onChange={() => undefined} />,
    );

    expect(html).toContain("lg:hidden");
    // `max-lg:min-h-11` on both buttons: the block target constant, not a copy of it.
    expect(html.split(TOUCH_TARGET_BLOCK).length - 1).toBe(2);
    expect(TOUCH_TARGET_BLOCK).toBe("max-lg:min-h-11");
  });

  it("advertises a published build on the Preview tab without jumping panes", () => {
    const quiet = dashboard();
    expect(quiet).not.toContain('data-testid="stage-preview-ready"');

    const ready = dashboard({ preview: true });
    expect(ready).toContain('data-testid="stage-preview-ready"');
    expect(ready).toContain('aria-label="A build is published and ready to look at"');
    // Still on the agent stage: the dot exists so the app does *not* move under the user.
    expect(ready).toContain('data-stage="agent"');
  });

  it("drops the duplicate pane headings on a phone, keeping them for a screen reader", () => {
    const html = dashboard();

    // The switcher already names the visible pane; the `<h2>` returns at `lg`.
    expect(html).toMatch(/id="agent-heading"[^>]*class="[^"]*hidden[^"]*lg:block/);
    expect(html).toMatch(/id="preview-heading"[^>]*class="[^"]*hidden[^"]*lg:block/);
    // `aria-labelledby` may point at hidden content, so the pane keeps its name.
    expect(html).toContain('aria-labelledby="agent-heading"');
    expect(html).toContain('aria-labelledby="preview-heading"');
  });
});

describe("the stylesheet that does the hiding", () => {
  it("hides the pane the stage is not showing, below the laptop breakpoint only", () => {
    expect(globals).toContain("@media (max-width: 1023.98px)");
    expect(globals).toContain('[data-stage="agent"] > [data-pane]:not([data-pane="agent"])');
    expect(globals).toContain('[data-stage="preview"] > [data-pane]:not([data-pane="preview"])');
    expect(globals).toContain("display: none");
  });

  it("publishes the safe-area insets as tokens, with a 0px fallback", () => {
    for (const edge of ["top", "bottom", "left", "right"]) {
      expect(globals).toContain(`--safe-${edge}: env(safe-area-inset-${edge}, 0px);`);
    }
    // The shell actually spends them: the header and the footer are the two edges that matter.
    const shell = readFileSync(resolve(root, "src/ui/dashboard.tsx"), "utf8");
    expect(shell).toContain("pt-[max(0.5rem,var(--safe-top))]");
    expect(shell).toContain("pb-[max(0.5rem,var(--safe-bottom))]");
  });

  it("stops iOS inflating text and stops the page rubber-banding under the VM", () => {
    expect(globals).toContain("-webkit-text-size-adjust: 100%");
    expect(globals).toContain("text-size-adjust: 100%");
    expect(globals).toContain("overscroll-behavior: none");
    expect(globals).toContain("-webkit-tap-highlight-color: transparent");
  });

  it("asks the browser for the whole screen, notch included", () => {
    expect(indexHtml).toContain("viewport-fit=cover");
    expect(indexHtml).toContain("width=device-width");
    expect(indexHtml).toContain("interactive-widget=resizes-content");
    // The phone's own chrome is painted in the app's background colour.
    expect(indexHtml).toContain('name="theme-color"');
  });
});

describe("what a phone sees inside the panes", () => {
  it("gives the prompt box 16 px text, so iOS does not zoom the app when it is focused", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        state={initialChat()}
        onSend={() => undefined}
        onStop={() => undefined}
        unavailableReason={null}
      />,
    );

    expect(html).toContain("text-base");
    expect(html).toContain("sm:text-[12.5px]");
    // Enter on a phone's keyboard is a newline by default; the hint makes it "send".
    // (The legacy server renderer preserves the camelCase prop name; the DOM attribute is
    // lower-case, which is why this compares case-insensitively.)
    expect(html.toLowerCase()).toContain('enterkeyhint="send"');
    expect(html).toContain("min-h-[44px]");
  });

  it("collapses the status bar's words instead of scrolling the bar sideways", () => {
    const html = renderToStaticMarkup(
      <StatusBar
        input={{
          ...STATUS_INPUT,
          environment: { ...INITIAL_ENVIRONMENT, status: "ready" },
        }}
      />,
    );

    // The word is the third channel and the first to go; the value and the tooltip stay.
    expect(html).toContain("hidden sm:inline");
    expect(html).toContain(statusLabel("ready"));
    expect(html).toContain("max-w-[18ch] truncate");
    // The bar still wraps rather than overflowing.
    expect(html).toContain("flex-wrap");
  });
});

describe("the handset notes in the boot card", () => {
  const iphone: HandsetFacts = {
    width: 390,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
    deviceMemoryGb: null,
    coarsePointer: true,
  };

  function panel(support: typeof supported, handset?: HandsetFacts): string {
    return renderToStaticMarkup(
      <EnvironmentPanel
        support={support}
        snapshot={INITIAL_ENVIRONMENT}
        stage={null}
        busy={false}
        selfTest={null}
        selfTestBusy={false}
        error={null}
        onBoot={() => undefined}
        onSelfTest={() => undefined}
        onShutdown={() => undefined}
        {...(handset === undefined ? {} : { handset })}
      />,
    );
  }

  it("shows nothing extra when the caller does not know the device", () => {
    expect(panel(noJspi)).not.toContain('data-testid="handset-notes"');
    expect(panel(supported)).not.toContain('data-testid="handset-notes"');
  });

  it("explains a phone failure in the phone's own terms, and says nothing is lost", () => {
    const html = panel(noJspi, iphone);

    expect(html).toContain('data-testid="handset-notes"');
    expect(html).toContain("every browser is Safari under the hood");
    expect(html).toContain("Nothing you have built is lost");
    expect(html).toContain('data-tone="warn"');
    // The support problems are still listed below it: the notes are an addition, not a filter.
    expect(html).toContain('data-testid="support-problems"');
  });

  it("asks a phone that can boot to keep the tab in front", () => {
    const html = panel(supported, iphone);

    expect(html).toContain('data-testid="handset-notes"');
    expect(html).toContain("suspends a backgrounded tab");
    expect(html).toContain('data-tone="info"');
  });

  it("does not repeat the desktop advice on a phone", () => {
    // The support report's own sentence says "Chrome/Edge 137+ … Safari 27+", which on iOS is
    // the wrong instruction; the note corrects it, and both are visible together.
    const html = panel(noJspi, iphone);
    expect(html).toContain("Chrome/Edge 137+");
    expect(html).toContain("Updating iOS is the only fix on this device");
  });
});

describe("the touch floor the components apply", () => {
  it("gives icon buttons 44 px below the laptop breakpoint", () => {
    const source = readFileSync(resolve(root, "src/ui/components/icon-button.tsx"), "utf8");
    expect(source).toContain("TOUCH_TARGET_ICON");
    expect(source).toContain("size-8");
    expect(TOUCH_TARGET_ICON).toBe("max-lg:size-11");
    expect(TOUCH_TARGET_MIN_PX).toBe(44);
  });

  it("gives every worded button a 44 px height on a phone", () => {
    const source = readFileSync(resolve(root, "src/ui/components/button.tsx"), "utf8");
    expect(source).toContain("max-lg:min-h-11");
    expect(source).toContain("size-9 max-lg:size-11");
  });
});
