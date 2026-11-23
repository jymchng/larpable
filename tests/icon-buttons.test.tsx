/**
 * Every button the user can press, checked for the two things an icon-only control can lose:
 * its *name* and its *target*.
 *
 * The change this file guards is a visual one — "replace the words with lucide pictograms" —
 * and a visual change is exactly the kind that quietly deletes an accessible name. So the first
 * test is a sweep, not a sample: it renders every surface that owns buttons, pulls each
 * `<button>` out of the markup, and asserts that
 *
 * - the accessible name (aria-label, else the text) is non-empty, and
 * - a button whose only content is a pictogram also carries a `title` (the mouse user's
 *   tooltip), a hit target of at least 32 px, and a visible focus ring.
 *
 * The one documented exception is `data-inline="true"`: the terminal's per-tab `×` lives inside
 * a single tab, where 32 px would make the strip taller than the thing it labels. It takes
 * WCAG 2.5.8's 24 px floor instead, and the sweep proves it is not below *that*.
 *
 * The per-surface tests then pin the *reversal*: a specific pictogram in a specific control, so
 * a later refactor cannot swap the hammer for a question mark in silence.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SupportReport } from "../src/env/support";
import type { EnvironmentSnapshot } from "../src/env/status";
import { ChatPanel } from "../src/ui/chat-panel";
import { beginTurn, initialChat, type ChatState } from "../src/ui/chat";
import { EnvironmentPanel } from "../src/ui/environment-panel";
import type { PreviewPhase } from "../src/preview/controller";
import { PreviewPane } from "../src/ui/preview-pane";
import { PREVIEW_PREFIX } from "../src/preview/routing";
import { SettingsPanel } from "../src/ui/settings-panel";
import { defaultSettings, type LlmSettings } from "../src/llm/settings";
import { TerminalPanel } from "../src/ui/terminal-panel";
import type { AppPreviewControl } from "../src/ui/use-app-preview";
import type { BuildControl } from "../src/ui/use-build";

/* ------------------------------------------------------------------ *
 * The sweep's machinery
 * ------------------------------------------------------------------ */

interface RenderedButton {
  /** The opening tag's attributes, as written. */
  attrs: string;
  /** Everything between the opening and closing tag. */
  inner: string;
}

function buttonsIn(html: string): RenderedButton[] {
  const found: RenderedButton[] = [];
  // Buttons never nest, so a non-greedy inner match is exact. `type="button"` inside the tag
  // cannot contain `>` either, which is why the attribute half is `[^>]*`.
  const pattern = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    found.push({ attrs: match[1] ?? "", inner: match[2] ?? "" });
  }
  return found;
}

function attribute(attrs: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match === null ? null : (match[1] ?? "");
}

/** The text a screen reader would read out of the button's own content. */
function textOf(inner: string): string {
  return inner
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function accessibleName(button: RenderedButton): string {
  const labelled = attribute(button.attrs, "aria-label");
  if (labelled !== null && labelled.trim().length > 0) return labelled.trim();
  return textOf(button.inner);
}

function isIconOnly(button: RenderedButton): boolean {
  return textOf(button.inner).length === 0;
}

/** `size-8`, `size-9`, `size-11` — the 32 px floor and the two sizes above it. */
function hasHitTarget(attrs: string): boolean {
  const className = attribute(attrs, "class") ?? "";
  return /\bsize-(8|9|10|11|12)\b/.test(className);
}

function hasInlineFloor(attrs: string): boolean {
  const className = attribute(attrs, "class") ?? "";
  return /\bsize-(6|7)\b/.test(className);
}

/* ------------------------------------------------------------------ *
 * The surfaces
 * ------------------------------------------------------------------ */

const support: SupportReport = {
  ok: true,
  problems: [],
  probe: { crossOriginIsolated: true, jspi: true, sharedArrayBuffer: true },
};

const idleSnapshot: EnvironmentSnapshot = {
  status: "idle",
  runtime: null,
  distro: null,
  cpus: null,
  memoryMiB: null,
  error: null,
};

const readySnapshot: EnvironmentSnapshot = {
  status: "ready",
  runtime: "bun 1.4.5",
  distro: "debian",
  cpus: 4,
  memoryMiB: 2048,
  error: null,
};

const readyPhase: PreviewPhase = {
  kind: "ready",
  buildId: "build-mf3k2-1",
  url: `${PREVIEW_PREFIX}/build-mf3k2-1/`,
  files: 14,
  served: "worker",
  note: null,
};

function appControl(state: AppPreviewControl["state"]): AppPreviewControl {
  return { state, run: () => undefined, stop: () => undefined };
}

function buildControl(overrides: Partial<BuildControl> = {}): BuildControl {
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

function environment(snapshot: EnvironmentSnapshot, busy = false): string {
  return renderToStaticMarkup(
    <EnvironmentPanel
      support={support}
      snapshot={snapshot}
      stage={busy ? "rooting…" : null}
      busy={busy}
      selfTest={null}
      selfTestBusy={false}
      bootDurationMs={null}
      error={null}
      onBoot={() => undefined}
      onSelfTest={() => undefined}
      onShutdown={() => undefined}
    />,
  );
}

function chat(state: ChatState): string {
  return renderToStaticMarkup(
    <ChatPanel state={state} onSend={() => undefined} onStop={() => undefined} unavailableReason={null} />,
  );
}

function preview(
  app?: AppPreviewControl,
  phase: PreviewPhase = readyPhase,
  build?: BuildControl,
): string {
  return renderToStaticMarkup(
    <PreviewPane
      phase={phase}
      onRefresh={() => undefined}
      available
      onFullscreen={() => undefined}
      {...(app === undefined ? {} : { app })}
      {...(build === undefined ? {} : { build })}
    />,
  );
}

function settings(value: LlmSettings): string {
  return renderToStaticMarkup(
    <SettingsPanel settings={value} onChange={() => undefined} problem={null} />,
  );
}

function terminal(ready: boolean): string {
  return renderToStaticMarkup(
    <TerminalPanel
      ready={ready}
      cwd="/workspace"
      openShell={null}
      unavailableReason={null}
    />,
  );
}

/** Every surface, each rendered in the states that change its buttons. */
const SURFACES: ReadonlyArray<{ name: string; html: string }> = [
  { name: "chat, idle", html: chat(initialChat()) },
  {
    name: "chat, running",
    html: chat(beginTurn(initialChat(), "build me a site", "user-1")),
  },
  { name: "environment, idle", html: environment(idleSnapshot) },
  { name: "environment, booting", html: environment({ ...idleSnapshot, status: "booting" }, true) },
  { name: "environment, ready", html: environment(readySnapshot) },
  { name: "preview, idle", html: preview(undefined, { kind: "idle" }) },
  { name: "preview, ready", html: preview(appControl({ kind: "idle" })) },
  {
    name: "preview, app running",
    html: preview(
      appControl({
        kind: "running",
        buildId: "build-mf3k2-1",
        port: 3000,
        command: "bun run start",
        status: 200,
      }),
    ),
  },
  {
    name: "preview, app failed",
    html: preview(appControl({ kind: "failed", message: "no scripts.start in package.json" })),
  },
  { name: "preview, with a build control", html: preview(appControl({ kind: "idle" }), readyPhase, buildControl()) },
  {
    name: "preview, building",
    html: preview(
      appControl({ kind: "idle" }),
      readyPhase,
      buildControl({ busy: true, status: { kind: "running", step: "installing", detail: "npm install" } }),
    ),
  },
  { name: "settings, demo", html: settings(defaultSettings()) },
  {
    name: "settings, keyed",
    html: settings({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test-1234abcd" }),
  },
  { name: "terminal, waiting for the guest", html: terminal(false) },
  { name: "terminal, ready", html: terminal(true) },
];

/* ------------------------------------------------------------------ *
 * The sweep
 * ------------------------------------------------------------------ */

describe("every rendered button", () => {
  it("has a non-empty accessible name, on every surface and in every state", () => {
    const nameless: string[] = [];
    let seen = 0;

    for (const surface of SURFACES) {
      const buttons = buttonsIn(surface.html);
      seen += buttons.length;
      expect(buttons.length, `${surface.name} rendered no buttons at all`).toBeGreaterThan(0);

      for (const button of buttons) {
        if (accessibleName(button).length === 0) {
          nameless.push(`${surface.name}: ${button.attrs.slice(0, 120)}`);
        }
      }
    }

    // A guard against the sweep silently testing nothing, which is how these tests rot.
    expect(seen).toBeGreaterThan(20);
    expect(nameless).toEqual([]);
  });

  it("gives every icon-only button a tooltip, a 32 px target and a visible focus ring", () => {
    const problems: string[] = [];

    for (const surface of SURFACES) {
      for (const button of buttonsIn(surface.html)) {
        if (!isIconOnly(button)) continue;

        const label = accessibleName(button);
        const title = attribute(button.attrs, "title");
        const inline = attribute(button.attrs, "data-inline") === "true";
        const className = attribute(button.attrs, "class") ?? "";
        const key = `${surface.name} [${label}]`;

        if (title === null || title.trim().length === 0) problems.push(`${key}: no title`);
        if (inline ? !hasInlineFloor(button.attrs) : !hasHitTarget(button.attrs)) {
          problems.push(`${key}: target too small (${inline ? "inline" : "standalone"})`);
        }
        if (!className.includes("focus-visible:ring")) problems.push(`${key}: no focus ring`);
      }
    }

    expect(problems).toEqual([]);
  });
});

/*
 * A tooltip is allowed to say *more* than the name ("Back" -> "Back to the previous page in
 * this build"), because the name is what a screen reader announces and the tooltip is where the
 * "why" lives. What it may not be is absent: that is the check above, and it is the one that
 * matters, because a pictogram with no tooltip is a riddle for a mouse user.
 */

/* ------------------------------------------------------------------ *
 * The reversal, per surface
 * ------------------------------------------------------------------ */

function buttonMarkup(html: string, testId: string): string {
  const button = buttonsIn(html).find(
    (candidate) => attribute(candidate.attrs, "data-testid") === testId,
  );
  expect(button, `no button with data-testid="${testId}"`).toBeDefined();
  return `${button?.attrs ?? ""}>${button?.inner ?? ""}`;
}

describe("the chat box", () => {
  it("sends with a paper plane and stops with a red octagon", () => {
    const idle = chat(initialChat());
    expect(buttonMarkup(idle, "chat-send")).toContain("lucide-send");
    expect(attribute(buttonMarkup(idle, "chat-send"), "aria-label")).toBe("Send the prompt");

    const running = chat(beginTurn(initialChat(), "build me a site", "user-1"));
    const stop = buttonMarkup(running, "chat-stop");
    expect(stop).toContain("lucide-circle-stop");
    expect(stop).toContain('data-tone="stop"');
    expect(stop).toContain("text-destructive");
    expect(attribute(stop, "aria-label")).toBe("Stop the run");
  });
});

describe("the environment card", () => {
  it("boots with a green power arrow, proves itself with a flask, stops with a red power-off", () => {
    const html = environment(idleSnapshot);

    const boot = buttonMarkup(html, "boot-button");
    expect(boot).toContain("lucide-power");
    expect(boot).toContain('data-tone="run"');
    expect(boot).toContain("text-success");
    expect(attribute(boot, "aria-label")).toBe("Boot Linux");

    expect(buttonMarkup(html, "self-test-button")).toContain("lucide-flask-conical");

    const shutdown = buttonMarkup(html, "shutdown-button");
    expect(shutdown).toContain("lucide-power-off");
    expect(shutdown).toContain('data-tone="stop"');
    expect(attribute(shutdown, "aria-label")).toBe("Shut down");
  });

  it("turns the boot icon into a spinner while it is working, rather than an enabled arrow", () => {
    const booting = buttonMarkup(environment({ ...idleSnapshot, status: "booting" }, true), "boot-button");
    expect(booting).toContain("lucide-loader-2");
    expect(booting).toContain("animate-spin");
    expect(attribute(booting, "aria-label")).toBe("Booting…");
    expect(booting).toMatch(/disabled=""/);
  });
});

describe("the preview pane", () => {
  it("publishes with the hammer and shows a green tone, not a worded button", () => {
    const html = preview(appControl({ kind: "idle" }), readyPhase, buildControl());
    const build = buttonMarkup(html, "preview-install-build");

    expect(build).toContain("lucide-hammer");
    expect(build).toContain('data-tone="run"');
    // The name is entity-escaped in the markup, so it is decoded before it is compared: what
    // a screen reader announces is "Install & build", not "Install &amp; build".
    expect(textOf(attribute(build, "aria-label") ?? "")).toBe("Install & build");
  });

  it("runs the app with a terminal and stops it with a red square", () => {
    const idle = preview(appControl({ kind: "idle" }));
    expect(buttonMarkup(idle, "preview-run-app")).toContain("lucide-square-terminal");
    expect(attribute(buttonMarkup(idle, "preview-run-app"), "aria-label")).toBe("Run the app");

    const failed = preview(appControl({ kind: "failed", message: "no start script" }));
    expect(attribute(buttonMarkup(failed, "preview-run-app"), "aria-label")).toBe("Run the app again");

    const running = preview(
      appControl({
        kind: "running",
        buildId: "build-mf3k2-1",
        port: 3000,
        command: "bun run start",
        status: 200,
      }),
    );
    const stop = buttonMarkup(running, "preview-stop-app");
    expect(stop).toContain("lucide-square");
    expect(stop).not.toContain("lucide-square-terminal");
    expect(stop).toContain('data-tone="stop"');
  });

  it("publishes again with a circling arrow once a build is on screen", () => {
    const html = preview(appControl({ kind: "idle" }));
    expect(buttonMarkup(html, "preview-build")).toContain("lucide-rotate-cw");
  });
});

describe("the browser chrome", () => {
  it("uses the browser's own arrows, with the reload's circling arrow between them", () => {
    const html = preview(appControl({ kind: "idle" }));

    expect(buttonMarkup(html, "preview-back")).toContain("lucide-arrow-left");
    expect(buttonMarkup(html, "preview-forward")).toContain("lucide-arrow-right");
    expect(buttonMarkup(html, "preview-reload")).toContain("lucide-rotate-cw");
    expect(attribute(buttonMarkup(html, "preview-back"), "data-tone")).toBe("nav");
  });

  it("sizes the frame with a monitor, a tablet and a phone, and keeps the pressed state", () => {
    const html = preview(appControl({ kind: "idle" }));

    expect(buttonMarkup(html, "preview-viewport-desktop")).toContain("lucide-monitor");
    expect(buttonMarkup(html, "preview-viewport-tablet")).toContain("lucide-tablet");
    const mobile = buttonMarkup(html, "preview-viewport-mobile");
    expect(mobile).toContain("lucide-smartphone");
    // The state a screen reader needs survives the loss of the painted word.
    expect(attribute(mobile, "aria-pressed")).toBe("false");
    expect(attribute(buttonMarkup(html, "preview-viewport-desktop"), "aria-pressed")).toBe("true");
    expect(attribute(mobile, "aria-label")).toBe("Mobile");
  });
});

describe("the settings panel", () => {
  it("resets to the demo with a circling arrow and the sentence as its name", () => {
    const html = settings({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test-1234abcd" });
    const reset = buttonMarkup(html, "settings-reset");

    expect(reset).toContain("lucide-rotate-ccw");
    expect(attribute(reset, "aria-label")).toBe("Reset to the demo provider");
    expect(reset).toContain('data-tone="muted"');
  });
});

describe("the terminal's own chrome", () => {
  it("copies, pastes, cuts and clears with clipboard pictograms", () => {
    const html = terminal(true);

    expect(buttonMarkup(html, "terminal-copy")).toContain("lucide-copy");
    expect(buttonMarkup(html, "terminal-paste")).toContain("lucide-clipboard-paste");
    expect(buttonMarkup(html, "terminal-cut")).toContain("lucide-scissors");
    expect(buttonMarkup(html, "terminal-clear")).toContain("lucide-trash-2");
    expect(buttonMarkup(html, "terminal-new-shell")).toContain("lucide-plus");
  });

  it("keeps the destructive pair red even on the dark screen, and says why in the tooltip", () => {
    const html = terminal(true);

    for (const testId of ["terminal-cut", "terminal-clear"]) {
      const markup = buttonMarkup(html, testId);
      expect(markup, testId).toContain("text-red-300");
      expect(attribute(markup, "data-tone"), testId).toBe("stop");
    }
    // "Cut" cannot remove a line from a shell's scrollback, and the tooltip says so.
    expect(attribute(buttonMarkup(html, "terminal-cut"), "title")).toContain("cannot be removed");
  });
});
