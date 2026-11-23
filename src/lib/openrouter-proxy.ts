/**
 * The one server-side secret in this product, and the proxy that keeps it server-side.
 *
 * The app already lets a user paste *their own* key into the settings panel, and that key lives
 * in this browser's `localStorage` and is sent to exactly one API origin (`src/llm/settings.ts`).
 * The "Default" provider option is a different arrangement: the deployment supplies one key, and
 * a user with no account gets a working conversation. There is only one way to do that without
 * publishing the key — it must never be in the bundle — so the browser talks to a path on its own
 * origin (`/api/openrouter/…`), and the server in front of the app adds the `authorization`
 * header while proxying to OpenRouter's OpenAI-compatible endpoint.
 *
 * That is what this module configures, and it is deliberately plain TypeScript with no Vite
 * import: `vite.config.ts` calls it, and so does a unit test, so "the key is only sent by the
 * proxy" is asserted rather than assumed.
 *
 * Three facts worth writing down:
 *
 * - **The variable is not `VITE_`-prefixed**, so Vite cannot inline it. A `VITE_*` variable is
 *   compiled into JavaScript the browser downloads; a secret in one is a published secret.
 * - **An absent key is a state, not a crash.** The proxy is still installed (so the failure is
 *   OpenRouter's own informative 401 rather than a 404 from our own router), and
 *   `describeOpenRouterProxy()` says which of the two situations the server is in.
 * - **The key is never logged or returned.** `describeOpenRouterProxy()` reports *whether* a key
 *   is configured, never the key, because this string ends up in a startup log.
 */

/** OpenRouter's OpenAI-compatible endpoint, including the API version. */
export const OPENROUTER_API_ORIGIN = "https://openrouter.ai/api/v1";

/** The path the browser calls. Same origin, so no CORS and no key in the page. */
export const OPENROUTER_PROXY_PATH = "/api/openrouter";

/** The environment variable `vite.config.ts` reads. Also the `.env.example` entry. */
export const OPENROUTER_KEY_VARIABLE = "LARPABLE_OPENROUTER_DEFAULT_API_KEY";

/**
 * The model the "Default" option asks for.
 *
 * A free-tier id, as the product promises: a person with no account and no key can run a real
 * conversation. The field stays editable, because a free id can be retired faster than this
 * repository ships and a stale id must be correctable without a release.
 */
export const OPENROUTER_FREE_MODEL = "openrouter/free";

/** A dev-server proxy rule, shaped like Vite's `server.proxy` entries. */
export interface OpenRouterProxyRule {
  target: string;
  changeOrigin: boolean;
  /** TLS to the upstream is verified; stated because a proxy that disables it is a trap. */
  secure: boolean;
  /** `/api/openrouter/chat/completions` → `/chat/completions`. */
  rewrite: (path: string) => string;
  /** Request headers added by the proxy. The key, when there is one. */
  headers: Record<string, string>;
}

/** True when the deployment has a key to add. */
export function isOpenRouterConfigured(env: Record<string, string | undefined>): boolean {
  return readKey(env).length > 0;
}

/**
 * One startup line for the server's log: which path, which upstream, and whether a key is set.
 *
 * Never the key itself, not even shortened: a proxy log is the most likely place for a secret to
 * leak into a screenshot.
 */
export function describeOpenRouterProxy(env: Record<string, string | undefined>): string {
  const state = isOpenRouterConfigured(env)
    ? "a key is configured and added by this proxy"
    : `no ${OPENROUTER_KEY_VARIABLE} is set, so requests reach OpenRouter unauthenticated`;
  return `${OPENROUTER_PROXY_PATH} → ${OPENROUTER_API_ORIGIN} (${state})`;
}

/**
 * The proxy rule for `/api/openrouter`.
 *
 * `headers` carries the key when one is configured. It overrides whatever the browser sent —
 * which matters twice: a browser cannot substitute its own key through this path, and a stale
 * key left in `localStorage` from a previous provider choice cannot shadow the deployment's.
 */
export function openRouterProxy(env: Record<string, string | undefined>): OpenRouterProxyRule {
  const key = readKey(env);
  return {
    target: OPENROUTER_API_ORIGIN,
    changeOrigin: true,
    secure: true,
    rewrite: (path) => path.replace(new RegExp(`^${OPENROUTER_PROXY_PATH}`), ""),
    headers:
      key.length === 0
        ? {}
        : {
            authorization: `Bearer ${key}`,
            // OpenRouter attributes free-tier traffic with these; both are optional but
            // recommended, and neither is a secret.
            "x-title": "larpable",
          },
  };
}

function readKey(env: Record<string, string | undefined>): string {
  const raw = env[OPENROUTER_KEY_VARIABLE];
  return typeof raw === "string" ? raw.trim() : "";
}
