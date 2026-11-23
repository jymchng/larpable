import { describe, expect, it } from "vitest";

import {
  FORWARD_REPLY_MESSAGE,
  FORWARD_REQUEST_MESSAGE,
  attachPreviewForwarder,
  previewPathOf,
} from "../src/preview/forwarder";

type Listener = (event: {
  data: unknown;
  source?: { postMessage(message: unknown): void } | null;
}) => void;

/** A stand-in for `navigator.serviceWorker`, recording what the page answered. */
function container(): {
  container: { addEventListener: (type: "message", listener: Listener) => void; removeEventListener: (type: "message", listener: Listener) => void };
  deliver: (data: unknown) => void;
  replies: unknown[];
  listeners: () => number;
} {
  const listeners = new Set<Listener>();
  const replies: unknown[] = [];
  return {
    container: {
      addEventListener: (type, listener) => {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener: (type, listener) => {
        if (type === "message") listeners.delete(listener);
      },
    },
    deliver: (data) => {
      for (const listener of listeners) {
        listener({ data, source: { postMessage: (message) => replies.push(message) } });
      }
    },
    replies,
    listeners: () => listeners.size,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("previewPathOf", () => {
  it("strips the session prefix and keeps the query string Next needs", () => {
    expect(previewPathOf("http://x/__preview__/app-1/_next/image?url=%2Fa.png&w=64", "app-1")).toBe(
      "/_next/image?url=%2Fa.png&w=64",
    );
    expect(previewPathOf("http://x/__preview__/app-1/", "app-1")).toBe("/");
    expect(previewPathOf("http://x/__preview__/app-1", "app-1")).toBeNull();
  });

  it("refuses a URL belonging to another session", () => {
    expect(previewPathOf("http://x/__preview__/app-2/index.html", "app-1")).toBeNull();
    expect(previewPathOf("http://x/assets/index.js", "app-1")).toBeNull();
  });
});

describe("attachPreviewForwarder", () => {
  it("answers the worker with the app's status, headers and bytes", async () => {
    const harness = container();
    const forwarder = attachPreviewForwarder({
      container: harness.container,
      buildId: "app-1",
      serve: async (path) => ({
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: new TextEncoder().encode(`<h1>${path}</h1>`),
      }),
    });

    harness.deliver({
      type: FORWARD_REQUEST_MESSAGE,
      requestId: "r1",
      url: "http://x/__preview__/app-1/_next/static/x.js",
      method: "GET",
      buildId: "app-1",
    });
    await flush();

    expect(harness.replies).toHaveLength(1);
    const reply = harness.replies[0] as {
      type: string;
      requestId: string;
      status: number;
      headers: Record<string, string>;
      body: ArrayBuffer;
    };
    expect(reply.type).toBe(FORWARD_REPLY_MESSAGE);
    expect(reply.requestId).toBe("r1");
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toContain("text/html");
    expect(new TextDecoder().decode(new Uint8Array(reply.body))).toBe("<h1>/_next/static/x.js</h1>");
    expect(forwarder.answered()).toBe(1);
  });

  it("turns a failure into a 502 the pane can show, and records it", async () => {
    const harness = container();
    const errors: string[] = [];
    const forwarder = attachPreviewForwarder({
      container: harness.container,
      buildId: "app-1",
      serve: async () => {
        throw new Error("no answer within 10000 ms");
      },
      onError: (message) => errors.push(message),
    });

    harness.deliver({
      type: FORWARD_REQUEST_MESSAGE,
      requestId: "r2",
      url: "http://x/__preview__/app-1/",
      buildId: "app-1",
    });
    await flush();

    const reply = harness.replies[0] as { status: number; body: ArrayBuffer };
    expect(reply.status).toBe(502);
    expect(new TextDecoder().decode(new Uint8Array(reply.body))).toContain("no answer within 10000 ms");
    expect(errors).toEqual(["no answer within 10000 ms"]);
    expect(forwarder.failures()).toEqual(["no answer within 10000 ms"]);
    expect(forwarder.answered()).toBe(0);
  });

  it("ignores another session's request, and anything that is not a forward", async () => {
    const harness = container();
    attachPreviewForwarder({
      container: harness.container,
      buildId: "app-1",
      serve: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    });

    harness.deliver({ type: FORWARD_REQUEST_MESSAGE, requestId: "r3", url: "http://x/__preview__/app-2/", buildId: "app-2" });
    harness.deliver({ type: "larpable:preview:published", buildId: "app-1" });
    harness.deliver(null);
    harness.deliver({ type: FORWARD_REQUEST_MESSAGE });
    await flush();

    expect(harness.replies).toHaveLength(0);
  });

  it("answers 404 for a URL outside its own prefix rather than forwarding it", async () => {
    const harness = container();
    const forwarded: string[] = [];
    attachPreviewForwarder({
      container: harness.container,
      buildId: "app-1",
      serve: async (path) => {
        forwarded.push(path);
        return { status: 200, headers: {}, body: new Uint8Array() };
      },
    });

    harness.deliver({ type: FORWARD_REQUEST_MESSAGE, requestId: "r4", url: "http://x/login", buildId: "app-1" });
    await flush();

    const reply = harness.replies[0] as { status: number };
    expect(reply.status).toBe(404);
    expect(forwarded).toEqual([]);
  });

  it("stops answering after dispose", async () => {
    const harness = container();
    const forwarder = attachPreviewForwarder({
      container: harness.container,
      buildId: "app-1",
      serve: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
    });

    forwarder.dispose();
    expect(harness.listeners()).toBe(0);
    harness.deliver({ type: FORWARD_REQUEST_MESSAGE, requestId: "r5", url: "http://x/__preview__/app-1/", buildId: "app-1" });
    await flush();
    expect(harness.replies).toHaveLength(0);
  });
});
