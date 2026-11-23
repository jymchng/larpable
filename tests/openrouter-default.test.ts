/**
 * The "Default" provider: one deployment key, never in the browser.
 *
 * Two promises are tested here, and neither is about a form:
 *
 * 1. **the key stays server-side.** It is read from a non-`VITE_` variable, and the only thing
 *    that ever carries it is the proxy rule's `headers` — so a test can assert the header string
 *    exists on the rule and that nothing else in the settings/provider layer mentions it;
 * 2. **the option routes where it claims.** OpenRouter's OpenAI-compatible endpoint, the free
 *    model id, and the same-origin `/api/openrouter` path in front of it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { OpenAICompatibleProvider } from "../src/llm/openai";
import { PROVIDER_CHOICES, createProvider, choiceFor, defaultSettings, parseStoredSettings, settingsProblem, serializeSettings } from "../src/llm/settings";
import {
  OPENROUTER_API_ORIGIN,
  OPENROUTER_FREE_MODEL,
  OPENROUTER_KEY_VARIABLE,
  OPENROUTER_PROXY_PATH,
  describeOpenRouterProxy,
  isOpenRouterConfigured,
  openRouterProxy,
} from "../src/lib/openrouter-proxy";

const KEY = "sk-or-v1-test-key-not-a-real-secret";

describe("the proxy rule", () => {
  it("forwards /api/openrouter to OpenRouter's OpenAI-compatible endpoint", () => {
    const rule = openRouterProxy({});

    expect(rule.target).toBe(OPENROUTER_API_ORIGIN);
    expect(rule.target).toBe("https://openrouter.ai/api/v1");
    expect(rule.changeOrigin).toBe(true);
    expect(rule.secure).toBe(true);
    expect(rule.rewrite(`${OPENROUTER_PROXY_PATH}/chat/completions`)).toBe("/chat/completions");
    // Only the prefix is rewritten: the rest of the path is the upstream's business.
    expect(rule.rewrite(`${OPENROUTER_PROXY_PATH}/models`)).toBe("/models");
  });

  it("adds the key as an authorization header, from the non-VITE variable", () => {
    const rule = openRouterProxy({ [OPENROUTER_KEY_VARIABLE]: KEY });

    expect(rule.headers.authorization).toBe(`Bearer ${KEY}`);
    // A `VITE_` variable would be inlined into the bundle by Vite; this one must not be.
    expect(OPENROUTER_KEY_VARIABLE.startsWith("VITE_")).toBe(false);
  });

  it("sends no authorization header when no key is configured", () => {
    // The proxy is installed anyway, so the failure is OpenRouter's own 401 rather than a 404
    // from our router — and a browser cannot sneak its own key through the path.
    expect(openRouterProxy({}).headers).not.toHaveProperty("authorization");
    expect(openRouterProxy({ [OPENROUTER_KEY_VARIABLE]: "   " }).headers).not.toHaveProperty(
      "authorization",
    );
  });

  it("trims a key pasted with a trailing newline, which is how keys usually arrive", () => {
    const rule = openRouterProxy({ [OPENROUTER_KEY_VARIABLE]: `${KEY}\n` });
    expect(rule.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("reports whether a key is set without ever printing it", () => {
    expect(isOpenRouterConfigured({ [OPENROUTER_KEY_VARIABLE]: KEY })).toBe(true);
    expect(isOpenRouterConfigured({})).toBe(false);

    const described = describeOpenRouterProxy({ [OPENROUTER_KEY_VARIABLE]: KEY });
    expect(described).toContain(OPENROUTER_PROXY_PATH);
    expect(described).toContain(OPENROUTER_API_ORIGIN);
    expect(described).not.toContain(KEY);
  });
});

describe("the Default provider choice", () => {
  it("is offered in the panel, after the demo that needs nothing", () => {
    const kinds = PROVIDER_CHOICES.map((choice) => choice.kind);

    expect(kinds[0]).toBe("demo");
    expect(kinds).toContain("default");
  });

  it("routes to the proxy path with the free model and needs no browser key", () => {
    const choice = choiceFor("default");

    expect(choice.label).toBe("Default");
    expect(choice.defaultModel).toBe(OPENROUTER_FREE_MODEL);
    expect(choice.defaultModel).toBe("openrouter/free");
    expect(choice.baseUrl).toBe(OPENROUTER_PROXY_PATH);
    expect(choice.needsKey).toBe(false);
    expect(choice.note).toContain("openrouter");
  });

  it("is runnable with no key, unlike the providers that need one", () => {
    expect(settingsProblem({ provider: "default", model: OPENROUTER_FREE_MODEL, apiKey: "" })).toBeNull();
    // The same empty key stops OpenAI, which proves the rule is per-provider and not disabled.
    expect(settingsProblem({ provider: "openai", model: "gpt-4o-mini", apiKey: "" })).not.toBeNull();
  });

  it("builds an OpenAI-compatible provider against the same-origin proxy", () => {
    const provider = createProvider({ provider: "default", model: OPENROUTER_FREE_MODEL, apiKey: "" });

    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(provider.model).toBe("openrouter/free");
    expect(provider.id).toBe("openrouter");
  });

  it("survives a round trip through localStorage", () => {
    const stored = serializeSettings({ provider: "default", model: "openrouter/free", apiKey: "" });

    expect(parseStoredSettings(stored)).toEqual({
      provider: "default",
      model: "openrouter/free",
      apiKey: "",
    });
    // An unknown provider is still not trusted; a typo in storage must not select nothing.
    expect(parseStoredSettings(JSON.stringify({ provider: "opnrouter", model: "x" })).provider).toBe(
      defaultSettings().provider,
    );
  });
});

describe("the browser's own request", () => {
  it("sends no authorization header when there is no key, so the proxy is the only source", async () => {
    const sent: Record<string, string> = {};
    const provider = new OpenAICompatibleProvider({
      apiKey: "",
      model: "openrouter/free",
      baseUrl: "/api/openrouter",
      fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
          sent[name.toLowerCase()] = value;
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await provider.generate([], []);

    expect(sent).not.toHaveProperty("authorization");
    expect(sent["content-type"]).toBe("application/json");
  });
});

describe("the wiring nobody can see in a unit test", () => {
  it("is actually installed by vite.config.ts, for both the dev and preview servers", () => {
    // A grep-shaped assertion, deliberately: the proxy rule is only useful if the server config
    // mentions it, and deleting the wiring must fail something.
    const config = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(config).toContain("openRouterProxy");
    expect(config).toContain("loadEnv");
    expect((config.match(/proxy:/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("documents the variable in .env.example, which is committed", () => {
    const example = readFileSync(resolve(process.cwd(), ".env.example"), "utf8");

    expect(example).toContain(OPENROUTER_KEY_VARIABLE);
    // The warning that makes the naming decision stick.
    expect(example).toContain("NOT `VITE_`-prefixed");
  });
});

describe("a failure that is a web page, not an API answer", () => {
  it("names the deployment gap instead of printing the HTML body", async () => {
    // Measured in production before netlify/functions/openrouter.ts existed: a POST to
    // /api/openrouter/chat/completions came back as Netlify's own 404 page, and the chat panel
    // printed that page — kilobytes of markup — as "the model could not be reached".
    const provider = new OpenAICompatibleProvider({
      apiKey: "",
      model: OPENROUTER_FREE_MODEL,
      baseUrl: OPENROUTER_PROXY_PATH,
      fetch: (async () =>
        new Response("<!DOCTYPE html><html><head><title>Page not found</title></head></html>", {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        })) as typeof fetch,
    });

    const error = await provider.generate([], []).then(
      () => null,
      (cause: unknown) => cause as { message: string },
    );

    expect(error).not.toBeNull();
    expect(error?.message).toContain("HTTP 404");
    expect(error?.message).toContain("HTML page instead of JSON");
    expect(error?.message).toContain(OPENROUTER_PROXY_PATH);
    // The remedy, and none of the page itself.
    expect(error?.message).toContain("netlify/functions/openrouter.ts");
    expect(error?.message).not.toContain("<!DOCTYPE");
    expect(error?.message).not.toContain("<html");
  });

  it("still quotes a JSON error, because OpenRouter's own words are the useful part", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "sk-test",
      model: OPENROUTER_FREE_MODEL,
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "No endpoints found" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const error = await provider.generate([], []).then(
      () => null,
      (cause: unknown) => cause as { message: string },
    );

    // `LLMRequestError` prefixes the provider id; the detail is the provider's own words.
    expect(error?.message).toBe("openai: HTTP 404 — No endpoints found");
  });
});
