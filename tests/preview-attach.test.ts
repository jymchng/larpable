/**
 * Attaching to a server the user runs.
 *
 * Three things have to be true before a forwarded preview can exist, and each fails in its own
 * words: something must answer on the port, the browser must have a service worker (the only
 * thing that can route a frame's request to this page), and the page must be listening for the
 * worker's questions. This file asserts the failure sentences and, for the happy path, the whole
 * chain — knock, install, forward, rebase, stand down.
 */

import { describe, expect, it } from "vitest";

import { attachGuestServer } from "../src/preview/attach";
import type { PreviewWorkerContainer, PreviewWorkerRegistration } from "../src/preview/client";
import type { MessageContainer } from "../src/preview/forwarder";
import { FORWARD_CLAIM_MESSAGE, FORWARD_REPLY_MESSAGE } from "../src/preview/forwarder";

interface Harness {
  requested: string[];
  installs: unknown[];
  attach: Awaited<ReturnType<typeof attachGuestServer>>;
  /** Deliver a message to the page's listener, as the worker would. */
  deliver(data: unknown, source: { postMessage(message: unknown): void }): void;
  /** How many listeners the page currently has. */
  listeners(): number;
}

/**
 * The page's two answers, kept apart.
 *
 * Every forwarded request now gets a claim first ("this session is mine") and the bytes second, so
 * a test that counts "replies" must say which of the two it means.
 */
function ofType(messages: unknown[], type: string): unknown[] {
  return messages.filter((message) => (message as { type?: string }).type === type);
}

function workerContainer(): {
  container: {
    register: () => Promise<PreviewWorkerRegistration>;
    addEventListener: () => void;
    removeEventListener: () => void;
  };
  installs: unknown[];
} {
  const installs: unknown[] = [];
  const registration: PreviewWorkerRegistration = {
    active: {
      postMessage: (message: unknown) => installs.push(message),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    installing: null,
    waiting: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return {
    installs,
    container: {
      register: async () => registration,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  };
}

function messageContainer(): {
  container: MessageContainer;
  listeners: Set<(event: { data: unknown; source?: { postMessage(message: unknown): void } | null }) => void>;
} {
  const listeners = new Set<
    (event: { data: unknown; source?: { postMessage(message: unknown): void } | null }) => void
  >();
  return {
    listeners,
    container: {
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
  };
}

async function harness(
  options: { answer?: (url: string) => Response | Promise<Response> } = {},
): Promise<Harness> {
  const requested: string[] = [];
  const { container, installs } = workerContainer();
  const messages = messageContainer();

  const attach = await attachGuestServer({
    http: async (url) => {
      requested.push(url);
      return options.answer === undefined
        ? new Response("<html><body>dev</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })
        : options.answer(url);
    },
    port: 1234,
    buildId: "dev-1",
    container,
    messages: messages.container,
  });

  return {
    requested,
    installs,
    attach,
    listeners: () => messages.listeners.size,
    deliver(data, source) {
      for (const listener of messages.listeners) listener({ data, source });
    },
  };
}

describe("attachGuestServer", () => {
  it("knocks on the port, then tells the worker which session it serves", async () => {
    const h = await harness();

    expect(h.requested[0]).toBe("http://127.0.0.1:1234/");
    if (!h.attach.ok) throw new Error(h.attach.message);
    expect(h.attach.attach.url).toBe("/__preview__/dev-1/");
    expect(h.attach.attach.port).toBe(1234);
    // The status is carried because it is the evidence that something answered: a 404 from a dev
    // server is still a running dev server, and the note says so.
    expect(h.attach.attach.status).toBe(200);
    expect(h.attach.attach.note).toContain("Attached to port 1234");
    // The install message names the session *after* the page can answer, so the worker cannot
    // forward a request into a listener that does not exist yet.
    expect(h.installs).toEqual([{ type: "larpable:preview:forward:install", buildId: "dev-1" }]);
    expect(h.listeners()).toBe(1);
  });

  it("says what to run when nothing is listening, instead of showing a blank frame", async () => {
    const requested: string[] = [];
    const result = await attachGuestServer({
      http: async (url) => {
        requested.push(url);
        throw new Error("connection refused");
      },
      port: 4321,
      buildId: "dev-1",
      container: workerContainer().container,
      messages: messageContainer().container,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain("Nothing answered on guest port 4321");
    // The fix is named in the same sentence, with the user's own port.
    expect(result.message).toContain("bun run dev -- -p 4321");
    expect(result.message).toContain("connection refused");
    expect(requested).toHaveLength(1);
  });

  it("refuses to pretend when the browser has no service worker", async () => {
    const result = await attachGuestServer({
      http: async () => new Response("", { status: 200 }),
      port: 1234,
      buildId: "dev-1",
      container: null,
      messages: messageContainer().container,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a failure");
    expect(result.message).toContain("no service worker");
  });

  it("forwards a request through the guest and rebases what comes back", async () => {
    const h = await harness({
      answer: (url) =>
        url.endsWith("/app")
          ? new Response('<html><head><link href="/assets/x.css"></head></html>', {
              status: 200,
              headers: { "content-type": "text/html" },
            })
          : new Response("", { status: 200 }),
    });
    if (!h.attach.ok) throw new Error(h.attach.message);

    const replies: { status: number; headers: Record<string, string>; body: ArrayBuffer | null }[] = [];
    h.deliver(
      {
        type: "larpable:preview:forward",
        requestId: "r1",
        url: "http://app.example/__preview__/dev-1/app",
        method: "GET",
      },
      { postMessage: (message) => replies.push(message as (typeof replies)[number]) },
    );

    // The page answers asynchronously: one tick is enough for the fake transport.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.requested.at(-1)).toBe("http://127.0.0.1:1234/app");
    expect(ofType(replies, FORWARD_REPLY_MESSAGE)).toHaveLength(1);
    const [answer] = ofType(replies, FORWARD_REPLY_MESSAGE) as {
      status: number;
      headers: Record<string, string>;
      body: ArrayBuffer | null;
    }[];
    expect(answer?.status).toBe(200);
    expect(h.attach.attach.answered()).toBe(1);
    const body = new TextDecoder().decode(new Uint8Array(answer?.body ?? new ArrayBuffer(0)));
    // Root-absolute URLs are rebased onto the preview prefix, or the page loads the *app's*
    // stylesheet and renders unstyled.
    expect(body).toContain("/__preview__/dev-1/assets/x.css");
  });

  it("ignores another session's requests, so a stale frame cannot be answered here", async () => {
    const h = await harness();
    if (!h.attach.ok) throw new Error(h.attach.message);

    const replies: unknown[] = [];
    h.deliver(
      {
        type: "larpable:preview:forward",
        requestId: "r1",
        url: "http://app.example/__preview__/other/app",
        buildId: "other",
      },
      { postMessage: (message) => replies.push(message) },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replies).toHaveLength(0);
    expect(h.attach.attach.answered()).toBe(0);
  });

  it("stands down on stop: no listener, and the worker told to forward nothing", async () => {
    const h = await harness();
    if (!h.attach.ok) throw new Error(h.attach.message);

    await h.attach.attach.stop();

    expect(h.listeners()).toBe(0);
    // A null session matches no preview URL. `clear` would also drop a published build, which a
    // mode switch must not do.
    expect(h.installs.at(-1)).toEqual({ type: "larpable:preview:forward:install", buildId: null });
  });

  it("listens where the worker posts: the container that registered it, not window", async () => {
    // The bug this test exists for: the page listened on `window`, so the worker's
    // `larpable:preview:forward` was never heard, every forwarded request sat until the worker's
    // 30 s budget expired, and the pane said "The app did not answer for
    // https://…/__preview__/dev-1/ within 30 s. It may still be compiling" — for a dev server
    // that had answered in milliseconds. `messages` is deliberately *not* injected here: the
    // default is the thing under test.
    const requested: string[] = [];
    const replies: unknown[] = [];
    const { container } = workerContainer();
    const listeners = new Set<(event: MessageEvent) => void>();
    const registering: PreviewWorkerContainer = {
      register: container.register,
      addEventListener: (_type, listener) => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener) => {
        listeners.delete(listener);
      },
    };

    const result = await attachGuestServer({
      http: async (url) => {
        requested.push(url);
        return new Response("<html><body>vite</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
      port: 1234,
      buildId: "dev-1",
      container: registering,
    });
    if (!result.ok) throw new Error(result.message);

    // The worker posts to its clients; those messages arrive at `navigator.serviceWorker`.
    expect(listeners.size).toBe(1);
    for (const listener of listeners) {
      listener({
        data: {
          type: "larpable:preview:forward",
          requestId: "r1",
          url: "http://app.example/__preview__/dev-1/",
          method: "GET",
          buildId: "dev-1",
        },
        source: { postMessage: (message: unknown) => replies.push(message) },
      } as unknown as MessageEvent);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requested.at(-1)).toBe("http://127.0.0.1:1234/");
    expect(ofType(replies, FORWARD_CLAIM_MESSAGE)).toHaveLength(1);
    expect(ofType(replies, FORWARD_REPLY_MESSAGE)).toHaveLength(1);
    expect((ofType(replies, FORWARD_REPLY_MESSAGE)[0] as { status: number }).status).toBe(200);
    expect(result.attach.answered()).toBe(1);
  });

  it("serves a path directly, for a caller without a worker in between", async () => {
    const h = await harness();
    if (!h.attach.ok) throw new Error(h.attach.message);

    const answer = await h.attach.attach.serve("/api/health");

    expect(answer.status).toBe(200);
    expect(h.requested.at(-1)).toBe("http://127.0.0.1:1234/api/health");
  });
});
