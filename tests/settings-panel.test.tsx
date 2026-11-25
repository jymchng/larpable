/**
 * The settings panel's markup, and the three sentences that make the key's boundary visible.
 *
 * The panel is the only place a secret is typed, so the tests assert the *safety* surface
 * rather than the layout: a password field, one provider choice that needs nothing, a stated
 * destination for a key, and a problem sentence that names the fix.
 *
 * It is now the **body** of the provider popover, so the frame is not this component's job:
 * the dialog, its position, Escape, click-outside and the focus round-trip live in
 * `src/ui/components/popover.tsx` and are asserted in `tests/popover.test.ts` (the rules) and
 * `tests/app.test.tsx` (closed by default, and the open surface with these fields inside it).
 * A real click and a real Escape are measured in Chromium by `bun run acceptance:popover`.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PROVIDER_OPTIONS, defaultSettings, type LlmSettings } from "../src/llm/settings";
import { defaultPreviewSettings } from "../src/ui/preview-settings";
import { SettingsPanel, type PreviewFields } from "../src/ui/settings-panel";

function render(settings: LlmSettings, problem: string | null = null): string {
  return renderToStaticMarkup(
    <SettingsPanel settings={settings} onChange={() => undefined} problem={problem} />,
  );
}

/** The preview half, painted with whatever draft the test wants to see. */
function previewFields(overrides: Partial<PreviewFields> = {}): PreviewFields {
  const settings = defaultPreviewSettings();
  return {
    settings,
    draft: { port: String(settings.port), buildDirectory: settings.buildDirectory },
    setPort: () => undefined,
    setBuildDirectory: () => undefined,
    problem: null,
    ...overrides,
  };
}

function renderWithPreview(preview: PreviewFields, settings: LlmSettings = defaultSettings()): string {
  return renderToStaticMarkup(
    <SettingsPanel settings={settings} onChange={() => undefined} preview={preview} />,
  );
}

describe("SettingsPanel", () => {
  it("offers one provider — Default — and it is the one selected", () => {
    const html = render(defaultSettings());
    expect(html).toContain('data-testid="settings-provider-default" data-selected="true"');
    // The other three are hidden: one right answer is not a question. They stay implemented (a
    // stored choice is honoured, see `parseStoredSettings`) but they are not offered.
    for (const kind of ["demo", "openai", "anthropic"]) {
      expect(html).not.toContain(`data-testid="settings-provider-${kind}"`);
      expect(html).not.toContain(`data-selected="false" data-testid="settings-provider-${kind}"`);
    }
    expect(PROVIDER_OPTIONS.map((choice) => choice.kind)).toEqual(["default"]);
    expect(html).not.toContain("OpenAI");
    expect(html).not.toContain("Anthropic");
  });

  it("still paints a stored choice it no longer offers, rather than hiding the state", () => {
    // A browser that chose the demo provider before the panel offered one choice keeps it; a
    // panel that painted no pressed button would be hiding the setting actually in force.
    const html = render({ provider: "demo", model: "demo-1", apiKey: "" });
    expect(html).toContain('data-testid="settings-provider-demo" data-selected="true"');
    expect(html).toContain('data-testid="settings-provider-default" data-selected="false"');
  });

  it("is a body, not a surface: the dialog above it owns the frame and the name", () => {
    const html = render(defaultSettings());
    expect(html).toContain('data-testid="settings-panel"');
    // One name for one thing. The popover's own title is the dialog's accessible name; a
    // second `aria-label` here would make a screen reader announce "Provider settings" twice
    // and could disagree with the heading.
    expect(html).not.toContain('aria-label="Provider settings"');
    expect(html).not.toContain('role="dialog"');
    // The surface paints the border and the padding now.
    expect(html).not.toContain("border-b");
  });

  it("needs nothing for Default: the key field is disabled and says where the key comes from", () => {
    const html = render(defaultSettings());
    expect(html).toContain('type="password"');
    expect(html).toMatch(/data-testid="settings-key"[^>]*disabled=""/);
    // The placeholder is HTML-escaped (`&#x27;` for the apostrophe), so assert around it.
    expect(html).toContain("not needed \u2014 the deployment");
    expect(html).toContain("key is added by /api/openrouter");
    // The model is the user's: a free-model id is a default, not a constant.
    expect(html).not.toMatch(/data-testid="settings-model"[^>]*disabled=""/);
    // And the note says the boundary, not the demo's scripted conversation.
    expect(html).toContain("Nothing secret is kept in this browser");
    expect(html).not.toContain("scripted conversation");
  });

  it("disables the model field only for the demo, whose model id is not a choice", () => {
    const html = render({ provider: "demo", model: "demo-1", apiKey: "" });
    expect(html).toMatch(/data-testid="settings-model"[^>]*disabled=""/);
    expect(html).toContain("not needed for the demo");
  });

  it("states where a key goes, and what it never reaches", () => {
    const html = render({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test-1234abcd" });
    expect(html).toContain('data-testid="settings-storage-note"');
    expect(html).toContain("kept in this browser only");
    expect(html).toContain("never to the guest or into your project files");
    // Only the redacted tail may be *echoed*, never the whole key as text.
    expect(html).toContain("(shown as …abcd)");
  });

  it("says what is missing instead of failing on first use", () => {
    const html = render({ provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "" });
    expect(html).toContain('data-testid="settings-problem"');
    expect(html).toContain("Anthropic needs an API key.");
    expect(html).toContain("switch to Default, which needs no account");
  });

  it("shows the caller's problem only when the settings themselves are runnable", () => {
    const runnable: LlmSettings = { provider: "demo", model: "demo-1", apiKey: "" };
    expect(render(runnable, "The Linux machine is not started yet.")).toContain(
      "The Linux machine is not started yet.",
    );
    expect(
      render({ provider: "openai", model: "gpt-4o-mini", apiKey: "" }, "The Linux machine is not started yet."),
    ).not.toContain("The Linux machine is not started yet.");
  });

  it("offers one click back to the defaults", () => {
    const html = render({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test-1234abcd" });
    expect(html).toContain('data-testid="settings-reset"');
    expect(html).toContain("Reset to the default provider");
  });

  it("says nothing about a preview it was not given", () => {
    // The panel is a body, and a body that painted a port for a machine that is not there would
    // be a field the user could change with no effect.
    const html = render(defaultSettings());
    expect(html).not.toContain('data-testid="settings-port"');
    expect(html).not.toContain('data-testid="settings-build-directory"');
  });
});

describe("SettingsPanel: the preview half", () => {
  it("shows the base URL with a host that cannot be typed, and the default port beside it", () => {
    const html = renderWithPreview(previewFields());

    // The host is painted, not offered: the guest answers on its own loopback and nowhere else.
    expect(html).toMatch(/data-testid="settings-host"[^>]*readonly/);
    expect(html).toContain("http://localhost");
    expect(html).not.toMatch(/data-testid="settings-host"[^>]*onChange/);
    // The port is the user's, and it defaults to Vite's.
    expect(html).toMatch(/data-testid="settings-port"[^>]*value="5173"/);
    expect(html).toMatch(/data-testid="settings-port"[^>]*inputmode="numeric"/i);
    expect(html).not.toMatch(/data-testid="settings-port"[^>]*readonly/);
  });

  it("lets the user name the build directory, and defaults to `dist`", () => {
    const html = renderWithPreview(previewFields());
    expect(html).toMatch(/data-testid="settings-build-directory"[^>]*value="dist"/);
    expect(html).not.toMatch(/data-testid="settings-build-directory"[^>]*readonly/);
  });

  it("says what the pair means in the guest, in the settings actually in use", () => {
    const html = renderWithPreview(
      previewFields({
        settings: { port: 8080, buildDirectory: "build", prod: true },
        draft: { port: "80", buildDirectory: "build" },
      }),
    );
    // The sentence quotes the last *valid* pair, not the half-typed draft: that is what a
    // server would be started with right now.
    expect(html).toContain('data-testid="settings-preview-note"');
    expect(html).toContain("http://localhost:8080");
    expect(html).toContain("build/ out of the guest and serves it statically");
    expect(html).not.toContain("http://localhost:80<");
  });

  it("says the preview starts the project itself when Prod is off", () => {
    const html = renderWithPreview(
      previewFields({
        settings: { port: 5173, buildDirectory: "dist", prod: false },
        draft: { port: "5173", buildDirectory: "dist" },
      }),
    );
    // Prod off means the pane's reload arrow runs the project's own script; the user is not
    // asked to start it themselves any more.
    expect(html).toContain("runs the project&#x27;s dev or start script in the guest");
    expect(html).toContain("http://localhost:5173");
    expect(html).not.toContain("start it in the terminal");
  });

  it("shows a half-typed port and the reason it is not used yet", () => {
    const html = renderWithPreview(
      previewFields({
        draft: { port: "5173x", buildDirectory: "dist" },
        problem: "The port must be a number between 1 and 65535.",
      }),
    );
    expect(html).toMatch(/data-testid="settings-port"[^>]*value="5173x"/);
    expect(html).toContain('data-testid="settings-preview-problem"');
    expect(html).toContain("The port must be a number between 1 and 65535.");
  });

  it("says nothing when the draft is usable", () => {
    expect(renderWithPreview(previewFields())).not.toContain(
      'data-testid="settings-preview-problem"',
    );
  });
});
