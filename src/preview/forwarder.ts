/**
 * The page half of server-mode preview: answer the worker's forwarded requests.
 *
 * The chain for a running app is: iframe → service worker → **this** → kernel → guest app.
 * The worker cannot reach the guest (no kernel in a worker), so it asks the page; this file
 * is the page's answer. It is deliberately thin — it parses the preview path out of the URL,
 * calls a `serve` function the caller supplies, and replies — because the interesting
 * decisions (which path to forward, how to rebase the HTML) belong to
 * `src/preview/app-preview.ts`, which is testable without a browser.
 *
 * Two properties worth stating:
 *
 * - **Only its own session is answered.** A message names a build/session id; a page that
 *   was told to serve `app-abc` ignores `app-xyz`, so a stale frame cannot be answered by a
 *   newer session's guest.
 * - **A failure is still an answer.** A thrown error becomes a 502 with its message, because
 *   the alternative is a worker timeout and a blank iframe that explains nothing.
 */

export const FORWARD_REQUEST_MESSAGE = "larpable:preview:forward";
export const FORWARD_REPLY_MESSAGE = "larpable:preview:forward:reply";

/**
 * Told to the worker so it knows which session it forwards.
 *
 * It is the third leg of the handshake: the page listens (`attachPreviewForwarder`), the worker
 * is told the session id, and only then do the frame's requests for
 * `/__preview__/<id>/…` reach the page instead of the network. A `null` build id is the
 * documented "forward nothing" value — see `attach.ts`, which uses it to stand down without
 * dropping a published build the way `clear` would.
 */
export const FORWARD_INSTALL_MESSAGE = "larpable:preview:forward:install";

/** What the worker posts. */
export interface ForwardRequestMessage {
  type: typeof FORWARD_REQUEST_MESSAGE;
  requestId: string;
  url: string;
  method?: string;
  buildId?: string | null;
}

/** The reply the page posts back. `body` travels as an `ArrayBuffer`. */
export interface ForwardReplyMessage {
  type: typeof FORWARD_REPLY_MESSAGE;
  requestId: string;
  status: number;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

/** The slice of a DOM event target this module needs, so a test can pass an object. */
export interface MessageContainer {
  addEventListener(
    type: "message",
    listener: (event: { data: unknown; source?: { postMessage(message: unknown): void } | null }) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: { data: unknown; source?: { postMessage(message: unknown): void } | null }) => void,
  ): void;
}

export interface PreviewForwarder {
  /** Stop answering. Idempotent. */
  dispose(): void;
  /** How many requests were answered — the acceptance run reads this instead of guessing. */
  answered(): number;
  /** Answers that failed, with their messages, newest last. */
  failures(): readonly string[];
}

export interface AttachForwarderOptions {
  container: MessageContainer;
  /** The session id this preview is served under, e.g. `app-mf3k2`. */
  buildId: string;
  /** Forward one preview-relative path to the running app. */
  serve(
    path: string,
    method: string,
  ): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>;
  /** Called for every failed forward, so the pane can show why. */
  onError?: (message: string) => void;
}

/** `/__preview__/app-1/_next/x.js` → `/_next/x.js`, for this session only. */
export function previewPathOf(url: string, buildId: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const scope = `/__preview__/${encodeURIComponent(buildId)}/`;
  if (!pathname.startsWith(scope)) return null;
  const rest = pathname.slice(scope.length);
  // A query string is part of what Next needs (`/_next/image?url=…`), and the URL object
  // dropped it above, so re-attach it here rather than losing the request's parameters.
  let search = "";
  try {
    search = new URL(url).search;
  } catch {
    search = "";
  }
  return `/${rest}${search}`;
}

/** Reply with bytes that survive structured cloning unchanged. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

export function attachPreviewForwarder(options: AttachForwarderOptions): PreviewForwarder {
  let count = 0;
  const failures: string[] = [];

  const listener = (event: { data: unknown; source?: { postMessage(message: unknown): void } | null }) => {
    const data = event.data as Partial<ForwardRequestMessage> | null;
    if (data === null || typeof data !== "object") return;
    if (data.type !== FORWARD_REQUEST_MESSAGE) return;
    if (typeof data.requestId !== "string" || typeof data.url !== "string") return;
    if (data.buildId !== undefined && data.buildId !== null && data.buildId !== options.buildId) return;
    // Captured as locals: the narrowing above does not survive into the async closure below.
    const requestId = data.requestId;
    const url = data.url;

    const reply = (message: ForwardReplyMessage) => {
      event.source?.postMessage(message);
    };

    const path = previewPathOf(url, options.buildId);
    if (path === null) {
      reply({
        type: FORWARD_REPLY_MESSAGE,
        requestId,
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
        body: toArrayBuffer(new TextEncoder().encode(`Not a URL of ${options.buildId}: ${url}`)),
      });
      return;
    }

    void (async () => {
      try {
        const answer = await options.serve(path, data.method ?? "GET");
        count += 1;
        reply({
          type: FORWARD_REPLY_MESSAGE,
          requestId,
          status: answer.status,
          headers: answer.headers,
          body: toArrayBuffer(answer.body),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(message);
        options.onError?.(message);
        reply({
          type: FORWARD_REPLY_MESSAGE,
          requestId,
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
          body: toArrayBuffer(
            new TextEncoder().encode(`The app did not answer for ${path}: ${message}`),
          ),
        });
      }
    })();
  };

  options.container.addEventListener("message", listener);

  return {
    dispose() {
      options.container.removeEventListener("message", listener);
    },
    answered() {
      return count;
    },
    failures() {
      return [...failures];
    },
  };
}
