/**
 * Provider, model and key — three fields and the boundary they sit on.
 *
 * The panel exists because the app is unusable without a provider choice and unusable *safely*
 * without a stated one: the key lives in this browser, is sent to one API origin, and must
 * never reach the guest. So the copy under the fields says all three, and the key field is a
 * password input whose value is only ever echoed back as `redactKey()`.
 *
 * The demo choice is first and needs nothing, which is the product's real default: a person
 * with no account can boot Linux, paint a site, build it and see it in the preview. That is
 * not a fallback — it is the path the acceptance run uses, so it has to be first-class here.
 */

import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";

import { IconButton } from "@/ui/components/icon-button";
import { Input } from "@/ui/components/input";
import { TOUCH_TARGET_BLOCK } from "@/ui/touch";
import { cn } from "@/lib/utils";
import {
  PROVIDER_CHOICES,
  choiceFor,
  defaultSettings,
  redactKey,
  settingsProblem,
  type LlmSettings,
  type ProviderKind,
} from "@/llm/settings";

export interface SettingsPanelProps {
  settings: LlmSettings;
  onChange: (settings: LlmSettings) => void;
  /** Why a run cannot start right now (a machine that is not ready, for example). */
  problem?: string | null;
  className?: string;
}

export function SettingsPanel({ settings, onChange, problem, className }: SettingsPanelProps): ReactNode {
  const choice = choiceFor(settings.provider);
  const settingsIssue = settingsProblem(settings);
  const issue = settingsIssue ?? problem ?? null;

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
    <section
      data-testid="settings-panel"
      aria-label="Provider settings"
      className={cn("space-y-2 border-b px-3 py-2", className)}
    >
      <fieldset className="space-y-1.5">
        <legend className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase">
          Provider
        </legend>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_CHOICES.map((candidate) => {
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

      <div className="flex flex-wrap items-end gap-2">
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
          : "The demo provider runs a scripted conversation over the real tools: no key, no account, no network."}
      </p>

      {issue !== null ? (
        <p data-testid="settings-problem" className="text-destructive text-[11.5px]">
          {issue}
        </p>
      ) : null}

      {/* A pictogram with the sentence as its accessible name: the reset is rare and
          reversible, so it costs no words in a panel that is mostly fields. */}
      <IconButton
        testId="settings-reset"
        label="Reset to the demo provider"
        hint="Reset the provider, model and key to the demo defaults"
        onClick={() => onChange(defaultSettings())}
      >
        <RotateCcw aria-hidden="true" />
      </IconButton>
    </section>
  );
}
