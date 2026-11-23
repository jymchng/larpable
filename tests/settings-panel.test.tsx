/**
 * The settings panel's markup, and the three sentences that make the key's boundary visible.
 *
 * The panel is the only place a secret is typed, so the tests assert the *safety* surface
 * rather than the layout: a password field, a demo option that needs nothing, a stated
 * destination for the key, and a problem sentence that names the fix.
 *
 * It is now the **body** of the provider popover, so the frame is not this component's job:
 * the dialog, its position, Escape, click-outside and the focus round-trip live in
 * `src/ui/components/popover.tsx` and are asserted in `tests/popover.test.ts` (the rules) and
 * `tests/app.test.tsx` (closed by default, and the open surface with these fields inside it).
 * A real click and a real Escape are measured in Chromium by `bun run acceptance:popover`.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PROVIDER_CHOICES, defaultSettings, type LlmSettings } from "../src/llm/settings";
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
  it("offers every provider, with the demo one first and selected by default", () => {
    const html = render(defaultSettings());
    for (const choice of PROVIDER_CHOICES) {
      expect(html).toContain(`data-testid="settings-provider-${choice.kind}"`);
    }
    expect(html).toContain('data-testid="settings-provider-demo" data-selected="true"');
    expect(html.indexOf("Demo (no key)")).toBeLessThan(html.indexOf("OpenAI"));
    expect(html).toContain('data-testid="settings-provider-openai" data-selected="false"');
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

  it("needs nothing for the demo: the key field is disabled and says why", () => {
    const html = render(defaultSettings());
    expect(html).toContain('type="password"');
    expect(html).toMatch(/data-testid="settings-key"[^>]*disabled=""/);
    expect(html).toContain("not needed for the demo");
    expect(html).toMatch(/data-testid="settings-model"[^>]*disabled=""/);
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
    expect(html).toContain("switch to Demo to build without an account");
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

  it("offers one click back to the no-account path", () => {
    const html = render({ provider: "openai", model: "gpt-4o-mini", apiKey: "sk-test-1234abcd" });
    expect(html).toContain('data-testid="settings-reset"');
    expect(html).toContain("Reset to the demo provider");
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
