/**
 * The production proxy: `netlify/functions/openrouter.ts`.
 *
 * This file exists because of a measured production failure, and it is tested the same way the
 * failure was found — by talking to it as the browser does:
 *
 *     $ curl -X POST …/api/openrouter/chat/completions
 *     HTTP=404 text/html 3984 bytes      ← Netlify's own page: the route did not exist
 *
 * So the assertions are about the four promises the function makes: it forwards the documented
 * path to OpenRouter with the deployment's key; it never returns or logs that key; it reports a
 * missing key as an actionable JSON 503 rather than a crash or an HTML page; and it refuses every
 * other path, so it cannot be used as an open relay.
 *
 * `globalThis.fetch` is replaced per test: the handler calls the platform fetch, so a stub is the
 * whole seam, and no test ever reaches the network.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import handler, { upstreamPath } from "../netlify/functions/openrouter";
import {
  OPENROUTER_API_ORIGIN,
  OPENROUTER_KEY_VARIABLE,
  OPENROUTER_PROXY_PATH,
} from "../src/lib/openrouter-proxy";

const KEY = "sk-or-v1-test-key-not-a-real-secret";

interface Captured {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

const realFetch = globalThis.fetch;

/** Replace fetch with one that records the upstream call and answers with `response`. */
function stubFetch(response: () => Response): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers ?? {}),
      body: body instanceof ArrayBuffer ? new TextDecoder().decode(body) : null,
    });
    return response();
  }) as typeof fetch;
  return calls;
}

function chatRequest(path = `${OPENROUTER_PROXY_PATH}/chat/completions`): Request {
  return new Request(`https://larpable.netlify.app${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({ model: "openrouter/free", stream: true, messages: [] }),
  });
}

function setKey(value: string | undefined): void {
  if (value === undefined) delete process.env[OPENROUTER_KEY_VARIABLE];
  else process.env[OPENROUTER_KEY_VARIABLE] = value;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setKey(undefined);
});

describe("the upstream path", () => {
  it("accepts both the app's own path and the function's rewritten path", () => {
    expect(upstreamPath(`${OPENROUTER_PROXY_PATH}/chat/completions`)).toBe("/chat/completions");
    expect(upstreamPath("/.netlify/functions/openrouter/chat/completions")).toBe("/chat/completions");
    expect(upstreamPath(`${OPENROUTER_PROXY_PATH}/models`)).toBe("/models");
  });

  it("refuses the bare prefixes, another function, and a lookalike path", () => {
    // No path after the prefix would forward a request to the origin's root: not an API call.
    expect(upstreamPath(OPENROUTER_PROXY_PATH)).toBeNull();
    expect(upstreamPath("/.netlify/functions/openrouter")).toBeNull();
    // A prefix must end at a boundary; `/api/openrouterx` is somebody else's route.
    expect(upstreamPath("/api/openrouterx/chat/completions")).toBeNull();
    expect(upstreamPath("/.netlify/functions/other")).toBeNull();
    expect(upstreamPath("/api/elsewhere")).toBeNull();
  });
});

describe("forwarding a chat request", () => {
  it("posts the same body to OpenRouter's endpoint with the deployment's key", async () => {
    setKey(KEY);
    const calls = stubFetch(
      () =>
        new Response("data: [DONE]\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    const response = await handler(chatRequest());

    expect(calls).toHaveLength(1);
    const call = calls[0] as Captured;
    expect(call.url).toBe(`${OPENROUTER_API_ORIGIN}/chat/completions`);
    expect(call.method).toBe("POST");
    expect(call.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    // The body is forwarded byte for byte: the provider asked for a stream and its own tools.
    expect(JSON.parse(call.body ?? "{}")).toMatchObject({ model: "openrouter/free", stream: true });
    // The upstream's own content type is preserved, so the client still sees an SSE stream.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps the query string, so a caller's own parameters are not dropped", async () => {
    setKey(KEY);
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    await handler(chatRequest(`${OPENROUTER_PROXY_PATH}/models?limit=5`));

    expect((calls[0] as Captured).url).toBe(`${OPENROUTER_API_ORIGIN}/models?limit=5`);
  });

  it("passes an upstream error through, status and all", async () => {
    setKey(KEY);
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );

    const response = await handler(chatRequest());

    expect(response.status).toBe(429);
    expect(await response.text()).toContain("rate limited");
  });
});

describe("the key", () => {
  it("is never in the response, even for an error the upstream caused", async () => {
    setKey(KEY);
    stubFetch(() => new Response("boom", { status: 500 }));

    const response = await handler(chatRequest());
    const body = await response.text();

    expect(body).not.toContain(KEY);
    response.headers.forEach((value) => expect(value).not.toContain(KEY));
  });

  it("is reported as a missing deployment setting, in OpenRouter's error shape", async () => {
    setKey(undefined);
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    const response = await handler(chatRequest());

    // Nothing is sent upstream without a key: the 401 would blame the user for our config.
    expect(calls).toHaveLength(0);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    const payload = (await response.json()) as { error: { message: string } };
    expect(payload.error.message).toContain(OPENROUTER_KEY_VARIABLE);
    // Actionable: it names the two ways forward, one of which needs no key at all.
    expect(payload.error.message).toContain("Demo");
  });

  it("treats a blank variable as absent, which is how a cleared setting arrives", async () => {
    setKey("   ");
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    const response = await handler(chatRequest());

    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("everything else", () => {
  it("answers an unknown path with a JSON 404 instead of proxying it", async () => {
    // `/admin` is inside the function's own prefix, and is still refused: the key belongs to the
    // deployment, so the proxy speaks only the routes the app uses.
    setKey(KEY);
    const calls = stubFetch(() => new Response("{}", { status: 200 }));

    const response = await handler(
      new Request("https://larpable.netlify.app/.netlify/functions/openrouter/admin", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(calls).toHaveLength(0);
  });
});

describe("the deployment wiring", () => {
  const toml = readFileSync(resolve(process.cwd(), "netlify.toml"), "utf8");

  it("routes /api/openrouter to the function, before the single-page-app fallback", () => {
    const route = toml.indexOf('from = "/api/openrouter/*"');

    expect(route).toBeGreaterThan(-1);
    expect(toml).toContain('to = "/.netlify/functions/openrouter/:splat"');
    // Forced, because the SPA rule below would otherwise answer first for some requests.
    expect(toml.slice(route)).toMatch(/force = true/);
    // Order matters: Netlify evaluates rules top-down, and the fallback is a catch-all.
    expect(route).toBeLessThan(toml.indexOf('from = "/*"'));
  });

  it("declares the functions directory, so the file is actually deployed", () => {
    expect(toml).toContain("[functions]");
    expect(toml).toContain('directory = "netlify/functions"');
  });
});
