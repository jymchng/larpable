/**
 * The production half of `/api/openrouter`: the same proxy the dev server installs, as a
 * Netlify Function.
 *
 * Why this file has to exist at all. `vite.config.ts` proxies `/api/openrouter` to OpenRouter
 * and adds the deployment's key, but a Netlify deploy is **static files**: there is no Vite
 * server in production. Measured against https://larpable.netlify.app/ before this function
 * existed:
 *
 *     $ curl -X POST …/api/openrouter/chat/completions
 *     HTTP=404  text/html  3984 bytes      ← Netlify's own "Page not found"
 *     $ curl …/api/openrouter/chat/completions
 *     HTTP=200  text/html  1116 bytes      ← the SPA fallback's index.html
 *
 * GET is caught by `[[redirects]] from "/*"`, POST is not — so the browser posted a chat
 * request to a path that only existed on a developer's laptop, and the app printed the HTML
 * page as its error. This function is the missing server: it forwards the request to
 * OpenRouter's OpenAI-compatible endpoint and adds the key from the deployment's environment.
 *
 * The rules it keeps, which are the same ones `src/lib/openrouter-proxy.ts` states:
 *
 * - **The key is read, never returned.** It comes from `LARPABLE_OPENROUTER_DEFAULT_API_KEY`
 *   (a non-`VITE_` variable, so it cannot be inlined into the bundle) and it is only ever put
 *   in an outbound header. No log line, no error body and no response header contains it.
 * - **An absent key is a state, not a crash.** The function answers 503 with a sentence naming
 *   the variable and the screen that fixes it, in OpenRouter's own error shape so the client's
 *   existing `describeFailure()` surfaces the sentence instead of a status code.
 * - **The streaming response is passed through, not buffered.** The provider asks for
 *   `stream: true` and reads SSE; collecting the body here would turn a token stream into a
 *   long silence and then a wall of text.
 * - **Only the documented path is served.** Anything else is a JSON 404, so this function
 *   cannot be used as an open relay for arbitrary OpenRouter routes.
 *
 * The route is wired in `netlify.toml` (`/api/openrouter/*` → this function, `force = true`)
 * because a function that is deployed but unreachable is the bug this file fixes.
 */

import {
  OPENROUTER_API_ORIGIN,
  OPENROUTER_KEY_VARIABLE,
  OPENROUTER_PROXY_PATH,
} from "../../src/lib/openrouter-proxy";

/** Where Netlify invokes this function, used when the redirect has already rewritten the URL. */
const FUNCTION_PREFIX = "/.netlify/functions/openrouter";

/**
 * The only upstream routes this proxy will speak.
 *
 * An allow-list, not "anything after the prefix": the key is the deployment's, so a
 * wildcard proxy would let any page call any OpenRouter endpoint (and any future endpoint) on
 * the operator's account. `/chat/completions` is what the app uses; `/models` is the one probe
 * that can answer "is this deployment's key valid" without spending a completion.
 */
const ALLOWED_UPSTREAM_PATHS: readonly string[] = ["/chat/completions", "/models"];

/**
 * The upstream path, or null when the request is not for the API.
 *
 * Both prefixes are accepted because a rewrite may or may not have replaced the URL by the
 * time the function sees it; accepting both makes the handler independent of that detail
 * instead of silently depending on it.
 */
export function upstreamPath(pathname: string): string | null {
  for (const prefix of [OPENROUTER_PROXY_PATH, FUNCTION_PREFIX]) {
    if (pathname === prefix) return null;
    if (pathname.startsWith(`${prefix}/`)) {
      const rest = pathname.slice(prefix.length);
      return rest.length > 0 ? rest : null;
    }
  }
  return null;
}

/** An OpenAI-shaped error, so the app's `extractMessage()` shows the sentence, not the JSON. */
function failure(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "proxy_error" } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export default async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = upstreamPath(url.pathname);
  if (path === null || !ALLOWED_UPSTREAM_PATHS.includes(path)) {
    return failure(
      404,
      `${url.pathname} is not part of this proxy; it serves ${OPENROUTER_PROXY_PATH}${ALLOWED_UPSTREAM_PATHS.join(
        `, ${OPENROUTER_PROXY_PATH}`,
      )} only.`,
    );
  }

  const key = (process.env[OPENROUTER_KEY_VARIABLE] ?? "").trim();
  if (key.length === 0) {
    // Named, actionable, and true: the deploy has no secret, so the Default provider cannot
    // reach a model. Demo needs no key, and a user's own key goes straight to the provider.
    return failure(
      503,
      `This deployment has no ${OPENROUTER_KEY_VARIABLE}, so the Default provider cannot reach OpenRouter. Set it in the site's environment variables, or choose Demo — or add your own key in Settings.`,
    );
  }

  const headers = new Headers();
  headers.set("content-type", request.headers.get("content-type") ?? "application/json");
  const accept = request.headers.get("accept");
  if (accept !== null && accept.length > 0) headers.set("accept", accept);
  // Overwrites whatever the browser sent: a page cannot substitute its own key through this
  // path, and a stale key in `localStorage` cannot shadow the deployment's.
  headers.set("authorization", `Bearer ${key}`);
  headers.set("x-title", "larpable");

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${OPENROUTER_API_ORIGIN}${path}${url.search}`, init);
  } catch (cause) {
    return failure(502, `The proxy could not reach ${OPENROUTER_API_ORIGIN}: ${messageOf(cause)}`);
  }

  const out = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType !== null) out.set("content-type", contentType);
  // A streamed answer must not be cached by the CDN, and a per-user request never should be.
  out.set("cache-control", "no-store");
  // `upstream.body` is passed straight through: SSE chunks reach the browser as they arrive.
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
