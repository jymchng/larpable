/**
 * Provider, model and key: the one place the app is allowed to keep a secret.
 *
 * PRD §13 asks for settings for provider/model/key. The rules that matter are not the form:
 *
 * - **The key never leaves this browser.** `src/agent/session.ts` takes `secrets` and redacts
 *   them out of every tool result and out of the transcript, and the guest never sees them
 *   because nothing here is written into the project. This module's job is to make that
 *   boundary explicit: `serializeSettings` is what goes into `localStorage`, and
 *   `redactKey` is the only form in which a key may be *displayed* or logged.
 * - **A missing key is a state, not a crash.** `settingsProblem` answers the sentence the
 *   settings panel shows instead of constructing a provider that will fail on first use.
 * - **The Default provider needs nothing.** Without a key the app still works end to end (a real
 *   build in the guest, a real preview): the request goes to this app's own `/api/openrouter`,
 *   and the deployment's key is added there. That is the product's one answer, and it is why the
 *   panel no longer asks the user to choose between API vendors — see `PROVIDER_OPTIONS`.
 *
 * Model ids are free text on purpose: they change faster than this repository ships, and a
 * dropdown of stale ids would fail in a way that looks like our bug.
 */

import { AnthropicProvider } from "@/llm/anthropic";
import { createDemoProvider } from "@/llm/demo";
import { OpenAICompatibleProvider } from "@/llm/openai";
import type { LLMProvider } from "@/llm/types";
import { OPENROUTER_FREE_MODEL, OPENROUTER_PROXY_PATH } from "@/lib/openrouter-proxy";

export type ProviderKind = "demo" | "default" | "openai" | "anthropic";

export interface LlmSettings {
  provider: ProviderKind;
  /** Sent to the API verbatim. Ignored by the demo provider. */
  model: string;
  /**
   * The API key. Kept in this browser's `localStorage` only, never sent to the guest and
   * never rendered — the panel shows `redactKey()` of it.
   */
  apiKey: string;
}

export interface ProviderChoice {
  kind: ProviderKind;
  label: string;
  /** Prefilled when the user switches to this provider. */
  defaultModel: string;
  /**
   * The API root, when it is not the provider's own public one.
   *
   * The default choice points at the app's own origin (`/api/openrouter`), because its key is
   * the deployment's and must never reach the browser; the server in front of the app adds it
   * (`src/lib/openrouter-proxy.ts`). Empty for the providers that the browser calls directly.
   */
  baseUrl?: string;
  /** The provider id used in logs and errors, when it is not the kind. */
  id?: string;
  /** True when a key is required before the provider can run. */
  needsKey: boolean;
  /** One sentence: what this choice costs and where the traffic goes. */
  note: string;
}

export const PROVIDER_CHOICES: readonly ProviderChoice[] = [
  {
    kind: "demo",
    label: "Demo (no key)",
    defaultModel: "demo-1",
    needsKey: false,
    note: "A scripted conversation over the real tools: it writes files, builds and previews with no account and no network.",
  },
  {
    kind: "default",
    label: "Default",
    defaultModel: OPENROUTER_FREE_MODEL,
    baseUrl: OPENROUTER_PROXY_PATH,
    id: "openrouter",
    // No key in this browser: the deployment's key is added by the proxy in front of the app,
    // so a user with no account still gets a real model. The note says which provider that is.
    needsKey: false,
    note: "OpenRouter's free models (openrouter/free) through this app's /api/openrouter proxy, which adds the deployment's key — nothing secret is kept in your browser.",
  },
  {
    kind: "openai",
    label: "OpenAI",
    defaultModel: "gpt-4o-mini",
    needsKey: true,
    note: "Your key is sent to api.openai.com from this browser, and never to the guest.",
  },
  {
    kind: "anthropic",
    label: "Anthropic",
    defaultModel: "claude-sonnet-4-5",
    needsKey: true,
    note: "Your key is sent to api.anthropic.com from this browser, and never to the guest.",
  },
];

export const SETTINGS_STORAGE_KEY = "larpable.llm";

/**
 * The one kind the panel offers, and the one `defaultSettings()` selects.
 *
 * Named rather than written inline so the panel, the default and the fallback cannot drift apart:
 * "the default provider" is one fact in three places.
 */
export const DEFAULT_PROVIDER_KIND: ProviderKind = "default";

/**
 * The choices the settings panel paints: exactly one.
 *
 * The other three are still implemented and still *reachable* — `createProvider` builds them, and
 * `parseStoredSettings` keeps whichever one a browser already stored, because a stored OpenAI key
 * must not silently become a request to somebody else's API. What changed is the question: the
 * form no longer asks a person to pick an API vendor. The Default choice needs no account and no
 * key, so the other three were a decision with one right answer — and a row of buttons that only
 * ever invites the wrong answer.
 *
 * Kept as a separate export from `PROVIDER_CHOICES` (the catalogue) so the browser acceptance run
 * can still seed the demo provider into `localStorage` and get a deterministic conversation,
 * without the panel offering it to anyone.
 */
export const PROVIDER_OPTIONS: readonly ProviderChoice[] = PROVIDER_CHOICES.filter(
  (choice) => choice.kind === DEFAULT_PROVIDER_KIND,
);

/** The choice that stands in when a stored kind is not in the catalogue at all. */
const FALLBACK_CHOICE = PROVIDER_CHOICES.find(
  (choice) => choice.kind === DEFAULT_PROVIDER_KIND,
) as ProviderChoice;

export function defaultSettings(): LlmSettings {
  const choice = FALLBACK_CHOICE;
  return { provider: choice.kind, model: choice.defaultModel, apiKey: "" };
}

export function choiceFor(kind: ProviderKind): ProviderChoice {
  return PROVIDER_CHOICES.find((choice) => choice.kind === kind) ?? FALLBACK_CHOICE;
}

/**
 * The sentence that stops a run, or null when the settings are runnable.
 *
 * Only two things are actually fatal: no model, and a provider that needs a key without one.
 * An unknown provider kind cannot reach here through the type, but a settings object restored
 * from `localStorage` can carry anything, so it is treated as the default provider rather than
 * crashing the app on boot.
 */
export function settingsProblem(settings: LlmSettings): string | null {
  const choice = choiceFor(settings.provider);
  if (settings.model.trim().length === 0) {
    return "Choose a model: the provider needs a model id and this field is empty.";
  }
  if (choice.needsKey && settings.apiKey.trim().length === 0) {
    // Only reachable for a kind a browser stored before the panel offered one choice, so the
    // sentence names the way out that the panel actually has: the Default provider.
    return `${choice.label} needs an API key. Add one, or switch to Default, which needs no account.`;
  }
  return null;
}

/**
 * A key as it may be shown: the last four characters, never the rest.
 *
 * `""` stays `""` (nothing to show), and a short key is masked entirely rather than printed
 * in full — "the last four characters" of a six-character string is most of it.
 */
export function redactKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= 8) return "…";
  return `…${trimmed.slice(-4)}`;
}

/** The provider the Default choice builds: same-origin proxy, deployment key added server-side. */
function defaultProvider(model: string): LLMProvider {
  // No key: the request goes to this app's own origin, and the proxy in front of it
  // (`src/lib/openrouter-proxy.ts`) adds the deployment's. Sending an empty bearer here
  // instead would be a header that means "authenticated as nobody".
  return new OpenAICompatibleProvider({
    apiKey: "",
    model,
    baseUrl: OPENROUTER_PROXY_PATH,
    id: "openrouter",
    // Free-tier models are rate limited hard; a shorter budget fails honestly instead of
    // holding a chat turn open for minutes.
    timeoutMs: 120_000,
  });
}

/** The provider these settings describe. Throws only when `settingsProblem` would have spoken. */
export function createProvider(settings: LlmSettings): LLMProvider {
  const model = settings.model.trim();
  switch (settings.provider) {
    case "demo":
      return createDemoProvider();
    case "default":
      return defaultProvider(model);
    case "openai":
      return new OpenAICompatibleProvider({ apiKey: settings.apiKey.trim(), model });
    case "anthropic":
      return new AnthropicProvider({ apiKey: settings.apiKey.trim(), model });
    default:
      // Unreachable through the type; kept so a restored object cannot crash the app. It gets the
      // Default provider, because that is the only choice the panel offers.
      return defaultProvider(choiceFor(settings.provider).defaultModel);
  }
}

/**
 * What is written to `localStorage`.
 *
 * Written by hand rather than by dropping the object in: a stored snapshot must not silently
 * acquire a field (a base URL, a token, a session id) just because someone widened
 * `LlmSettings` later. The key is included because the setting is useless without it, and it
 * is the one secret this app keeps — stated here and in the panel's own copy.
 */
export function serializeSettings(settings: LlmSettings): string {
  return JSON.stringify({ v: 1, provider: settings.provider, model: settings.model, apiKey: settings.apiKey });
}

/**
 * A settings object from whatever was in storage.
 *
 * Tolerant by design: a corrupt or older value falls back to the default provider instead of
 * throwing on boot. An unknown `provider` string is *not* trusted, because a typo in storage
 * would otherwise select a provider that does not exist.
 *
 * A kind that the panel no longer offers (`demo`, `openai`, `anthropic`) *is* kept: it was chosen
 * deliberately, and rewriting it to Default would send a stored key's owner to a different API
 * than the one they configured. The panel shows the choice in force even when it offers only the
 * Default one, so this state is visible rather than silent.
 */
export function parseStoredSettings(raw: string | null): LlmSettings {
  const fallback = defaultSettings();
  if (raw === null || raw.trim().length === 0) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) return fallback;
  const record = parsed as Record<string, unknown>;
  const kind = record.provider;
  const provider: ProviderKind =
    kind === "demo" || kind === "default" || kind === "openai" || kind === "anthropic"
      ? kind
      : fallback.provider;
  const model = typeof record.model === "string" && record.model.trim().length > 0 ? record.model : choiceFor(provider).defaultModel;
  const apiKey = typeof record.apiKey === "string" ? record.apiKey : "";
  return { provider, model, apiKey };
}
