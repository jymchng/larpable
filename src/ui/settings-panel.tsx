/**
 * Everything a session lets the user choose, in one popover: the provider that thinks, and the
 * address and directory the previews work against.
 *
 * The provider half exists because the app is unusable without a provider choice and unusable
 * *safely* without a stated one: the key lives in this browser, is sent to one API origin, and
 * must never reach the guest. So the copy under the fields says all three, and the key field is
 * a password input whose value is only ever echoed back as `redactKey()`.
 *
 * The preview half is two fields and one fact: both guest servers are reached at `localhost`
 * — the kernel's own loopback, so the host is painted and never typed — on a port the user
 * chooses, serving a build directory the user names. `5173` and `dist` are the defaults, not
 * the only answers; `src/ui/preview-settings.ts` holds the rules that keep a half-typed number
 * from becoming a running server's address.
 *
 * It is now the **body** of a popover, not a band of its own: `Dashboard` wraps it in
 * `Popover` (a labelled dialog anchored to the cog, dismissed by Escape or a press outside,
 * with focus moved in on open and back to the cog on close). That is why this component paints
 * no border, no padding and no accessible name of its own — the surface owns the frame and
 * `aria-labelledby`s its own visible title, so the name "Provider settings" reaches a screen
 * reader exactly once instead of once per wrapper.
 *
 * The provider row offers **one** choice (`PROVIDER_OPTIONS`): Default. It needs no account and
 * no key, so the other three were a decision with one right answer — asking the question only
 * invited the wrong one. The choice *in force* is always painted, even when it is no longer
 * offered (a browser can still hold `demo`, `openai` or `anthropic` from before): a settings
 * panel that hid the setting it is actually using would be lying about the state, and the reset
 * control beside the fields is the way back to Default.
 */

import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";

import { IconButton } from "@/ui/components/icon-button";
import { Input } from "@/ui/components/input";
import { TOUCH_TARGET_BLOCK } from "@/ui/touch";
import { cn } from "@/lib/utils";
import {
  PROVIDER_OPTIONS,
  choiceFor,
  defaultSettings,
  redactKey,
  settingsProblem,
  type LlmSettings,
  type ProviderKind,
} from "@/llm/settings";
import {
  DEFAULT_BUILD_DIRECTORY,
  DEFAULT_PREVIEW_SETTINGS_PORT,
  PREVIEW_HOST,
  baseUrlFor,
} from "@/ui/preview-settings";
import type { PreviewSettingsControl } from "@/ui/use-preview-settings";

export interface SettingsPanelProps {
  settings: LlmSettings;
  onChange: (settings: LlmSettings) => void;
  /**
   * The preview's own two settings. Absent when the caller has no guest to point at (the panel
   * is a body, and a body that shows a port for a machine that is not there would be noise).
   */
  preview?: PreviewFields;
  /** Why a run cannot start right now (a machine that is not ready, for example). */
  problem?: string | null;
  className?: string;
}

/** Just enough of the preview control to paint the fields, for tests and static renders. */
export type PreviewFields = Pick<
  PreviewSettingsControl,
  "settings" | "draft" | "setPort" | "setBuildDirectory" | "setProd" | "problem"
>;

export function SettingsPanel({
  settings,
  onChange,
  preview,
  problem,
  className,
}: SettingsPanelProps): ReactNode {
  const choice = choiceFor(settings.provider);
  const settingsIssue = settingsProblem(settings);
  const issue = settingsIssue ?? problem ?? null;

  // The offered choices, plus the one in force when it is not among them: see the header. The
  // active kind is first so the painted row never looks like "nothing is selected".
  const offered = PROVIDER_OPTIONS.some((candidate) => candidate.kind === settings.provider)
    ? PROVIDER_OPTIONS
    : [choice, ...PROVIDER_OPTIONS];

  const selectProvider = (kind: ProviderKind) => {
    const next = choiceFor(kind);
    onChange({
      provider: kind,
      // Switching provider keeps the key only when it is the same kind; otherwise a key for
      // one API would be sent to another, which is the worst possible "helpful" behaviour.
      apiKey: kind === settings.provider ? settings.apiKey : "",
      model: kind === settings.provider && settings.model.trim().length > 0 ? settings.model : next.defaultModel,
    });
  };

  return (
    <div data-testid="settings-panel" className={cn("space-y-1.5", className)}>
      <fieldset className="space-y-1">
        <legend className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
          Provider
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {offered.map((candidate) => {
            const selected = candidate.kind === settings.provider;
            return (
              <button
                key={candidate.kind}
                type="button"
                data-testid={`settings-provider-${candidate.kind}`}
                data-selected={selected ? "true" : "false"}
                aria-pressed={selected}
                onClick={() => selectProvider(candidate.kind)}
                className={cn(
                  "min-h-[32px] rounded-md border px-2 py-1 font-mono text-[11px] transition-colors",
                  // A provider choice is a tap target on a phone like any other control: the
                  // 32 px that suits a dense desktop row is 12 px short of a fingertip.
                  TOUCH_TARGET_BLOCK,
                  selected
                    ? "border-primary bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-muted/60",
                )}
              >
                {candidate.label}
              </button>
            );
          })}
        </div>
        <p data-testid="settings-provider-note" className="text-muted-foreground text-[11px]">
          {choice.note}
        </p>
      </fieldset>

      <div className="flex flex-wrap items-end gap-1.5">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
            Model
          </span>
          <Input
            data-testid="settings-model"
            value={settings.model}
            disabled={settings.provider === "demo"}
            onChange={(event) => onChange({ ...settings, model: event.target.value })}
            placeholder={choice.defaultModel}
            className="font-mono text-[12px]"
          />
        </label>

        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
            API key
          </span>
          <Input
            data-testid="settings-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={settings.apiKey}
            disabled={!choice.needsKey}
            onChange={(event) => onChange({ ...settings, apiKey: event.target.value })}
            placeholder={
              choice.needsKey
                ? "sk-…"
                : choice.kind === "default"
                  ? // Stated, not implied: the Default option's key is the deployment's and is
                    // added by the proxy, so an empty field is correct here.
                    "not needed — the deployment's key is added by /api/openrouter"
                  : "not needed for the demo"
            }
            className="font-mono text-[12px]"
          />
        </label>
      </div>

      <p data-testid="settings-storage-note" className="text-muted-foreground text-[11px]">
        {choice.needsKey
          ? `The key is kept in this browser only${settings.apiKey.trim().length > 0 ? ` (shown as ${redactKey(settings.apiKey)})` : ""}, sent to the provider's API from this page, and never to the guest or into your project files.`
          : choice.kind === "default"
            ? "Nothing secret is kept in this browser: the request goes to this app's own /api/openrouter, which adds the deployment's key on the server, so there is no account and no key to manage."
            : "The demo provider runs a scripted conversation over the real tools: no key, no account, no network."}
      </p>

      {preview !== undefined ? (
        <fieldset className="space-y-1 border-t pt-1.5">
          <legend className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
            Preview
          </legend>
          <div className="flex flex-wrap items-end gap-1.5">
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                Base URL
              </span>
              <div className="flex items-center gap-1">
                {/* Painted, not typed. A guest server is reachable on the kernel's own loopback
                    and nowhere else, so a host field would be a field whose every other value
                    fails with a socket error — which teaches the user the product is broken. */}
                <Input
                  data-testid="settings-host"
                  aria-label="Host"
                  aria-readonly="true"
                  readOnly
                  value={`http://${PREVIEW_HOST}`}
                  onChange={() => undefined}
                  className="text-muted-foreground w-[8.5rem] font-mono text-[12px]"
                />
                <span aria-hidden="true" className="text-muted-foreground font-mono text-[12px]">
                  :
                </span>
                <Input
                  data-testid="settings-port"
                  aria-label="Port"
                  inputMode="numeric"
                  value={preview.draft.port}
                  onChange={(event) => preview.setPort(event.target.value)}
                  placeholder={String(DEFAULT_PREVIEW_SETTINGS_PORT)}
                  spellCheck={false}
                  className="w-16 font-mono text-[12px]"
                />
              </div>
            </div>

            <label className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
                Build directory
              </span>
              <Input
                data-testid="settings-build-directory"
                value={preview.draft.buildDirectory}
                onChange={(event) => preview.setBuildDirectory(event.target.value)}
                placeholder={DEFAULT_BUILD_DIRECTORY}
                spellCheck={false}
                className="font-mono text-[12px]"
              />
            </label>

            {/* Prod, beside the two fields it modifies. A checkbox and not a two-button mode
                selector: it is one bit, the label says what it turns on, and the note below says
                what each state does. `TOUCH_TARGET_BLOCK` keeps the label a fingertip tall on a
                phone without stretching the row on a desktop. */}
            <label
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1",
                TOUCH_TARGET_BLOCK,
                preview.settings.prod ? "border-primary bg-primary/10" : "border-input",
              )}
            >
              <input
                data-testid="settings-prod"
                type="checkbox"
                checked={preview.settings.prod}
                onChange={(event) => preview.setProd(event.target.checked)}
                aria-label="Prod: build the project and serve its output statically"
                className="accent-primary size-3.5"
              />
              <span className="text-[11px] font-semibold">Prod</span>
            </label>
          </div>

          {/* The fields and the switch are one sentence: what the currently-useful settings
              actually do. It quotes the *last valid* pair, not the draft, because that is what
              the preview would do right now. */}
          <p data-testid="settings-preview-note" className="text-muted-foreground text-[11px]">
            {preview.settings.prod
              ? `The preview reads ${preview.settings.buildDirectory}/ out of the guest and serves it statically on ${baseUrlFor(preview.settings)}.`
              : `The preview runs the project's dev or start script in the guest and shows what it serves on ${baseUrlFor(preview.settings)} \u2014 no build of the preview's own, and nothing for you to start in the terminal.`}
          </p>

          {preview.problem !== null ? (
            <p data-testid="settings-preview-problem" className="text-destructive text-[11.5px]">
              {preview.problem}
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {issue !== null ? (
        <p data-testid="settings-problem" className="text-destructive text-[11.5px]">
          {issue}
        </p>
      ) : null}

      {/* A pictogram with the sentence as its accessible name: the reset is rare and
          reversible, so it costs no words in a panel that is mostly fields. */}
      <IconButton
        testId="settings-reset"
        label="Reset to the default provider"
        hint="Reset the provider, model and key to the defaults"
        onClick={() => onChange(defaultSettings())}
      >
        <RotateCcw aria-hidden="true" />
      </IconButton>
    </div>
  );
}
