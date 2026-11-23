/**
 * Publishing a build to the preview worker.
 *
 * The protocol is small, and the failure it prevents is not: `postMessage` resolves for
 * nobody, so a publish that no worker received is indistinguishable from a successful one
 * unless the worker confirms it. Every test here is about that confirmation or about the
 * registration details that decide whether the worker can answer preview URLs at all.
 */

import { describe, expect, it } from "vitest";

import {
  CLEAR_MESSAGE,
  PREVIEW_WORKER_SCOPE,
  PREVIEW_WORKER_URL,
  PUBLISH_MESSAGE,
  PUBLISHED_MESSAGE,
  browserWorkerContainer,
  clearPublishedPreview,
  publishPreviewSnapshot,
  registerPreviewWorker,
  type PreviewWorkerContainer,
  type PreviewWorkerRegistration,
} from "../src/preview/client";
import type { PreviewSnapshot } from "../src/preview/proxy";

/** What the worker receives and what it says back, without a service worker. */
class FakeWorker implements PreviewWorkerContainer {
  readonly sent: unknown[] = [];
  readonly registrations: { scriptUrl: string; options?: { scope?: string; type?: string } }[] = [];
  readonly #listeners = new Set<(event: MessageEvent) => void>();
  active: { postMessage(message: unknown): void } | null = null;
  installing: unknown = null;
  waiting: unknown = null;
  #stateListeners = new Set<() => void>();

  /** Answer a publish the way `public/preview-sw.js` does, counting the files. */
  autoReply = true;

  async register(
    scriptUrl: string,
    options?: { scope?: string; type?: "module" | "classic" },
  ): Promise<PreviewWorkerRegistration> {
    this.registrations.push(options === undefined ? { scriptUrl } : { scriptUrl, options });
    if (this.active === null) this.activate();
    return this as unknown as PreviewWorkerRegistration;
  }

  activate(): void {
    this.active = {
      postMessage: (message: unknown) => {
        this.sent.push(message);
        const data = message as { type?: string; buildId?: string; files?: unknown[] };
        if (!this.autoReply || data.type !== PUBLISH_MESSAGE) return;
        // Asynchronously, as a worker would.
        setTimeout(() => {
          this.emit({
            type: PUBLISHED_MESSAGE,
            buildId: data.buildId,
            files: Array.isArray(data.files) ? data.files.length : 0,
          });
        }, 0);
      },
    };
    for (const listener of this.#stateListeners) listener();
  }

  emit(data: unknown): void {
    for (const listener of this.#listeners) listener({ data } as MessageEvent);
  }

  addEventListener(type: "message" | string, listener: (event: MessageEvent) => void): void {
    if (type === "message") this.#listeners.add(listener);
    else this.#stateListeners.add(listener as unknown as () => void);
  }

  removeEventListener(type: "message" | string, listener: (event: MessageEvent) => void): void {
    if (type === "message") this.#listeners.delete(listener);
    else this.#stateListeners.delete(listener as unknown as () => void);
  }

  listenerCount(): number {
    return this.#listeners.size;
  }
}

function snapshotOf(buildId: string, paths: string[]): PreviewSnapshot {
  return {
    buildId,
    fallbackPath: "/index.html",
    files: paths.map((path) => ({
      path,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: new TextEncoder().encode(path),
    })),
  };
}

describe("registerPreviewWorker", () => {
  it("registers the module worker at the preview scope", async () => {
    const worker = new FakeWorker();
    await registerPreviewWorker({ container: worker });
    expect(worker.registrations).toEqual([
      { scriptUrl: PREVIEW_WORKER_URL, options: { scope: PREVIEW_WORKER_SCOPE, type: "module" } },
    ]);
    // A classic worker would fail to parse an ESM script, and the scope keeps the app's
    // own routes out of the worker's fetch handler.
    expect(PREVIEW_WORKER_URL).toBe("/preview-sw.js");
    expect(PREVIEW_WORKER_SCOPE).toBe("/__preview__/");
  });

  it("does not wait when the worker is already active", async () => {
    const worker = new FakeWorker();
    worker.active = { postMessage: () => undefined };
    const result = await registerPreviewWorker({ container: worker });
    expect(result.waited).toBe(false);
  });

  it("waits for activation when the worker is still installing", async () => {
    const worker = new FakeWorker();
    worker.register = async (scriptUrl, options) => {
      worker.registrations.push({ scriptUrl, ...(options ? { options } : {}) });
      setTimeout(() => worker.activate(), 5);
      return worker as unknown as PreviewWorkerRegistration;
    };
    const result = await registerPreviewWorker({ container: worker, timeoutMs: 1_000 });
    expect(result.waited).toBe(true);
    expect(worker.active).not.toBeNull();
  });

  it("says what to do when the worker never activates", async () => {
    const worker = new FakeWorker();
    worker.register = async () => worker as unknown as PreviewWorkerRegistration;
    await expect(
      registerPreviewWorker({ container: worker, timeoutMs: 20 }),
    ).rejects.toThrow(/did not activate/);
  });
});

describe("publishPreviewSnapshot", () => {
  it("posts the build and resolves the worker's file count", async () => {
    const worker = new FakeWorker();
    worker.activate();
    const { registration } = await registerPreviewWorker({ container: worker });
    const snapshot = snapshotOf("b-3", ["/index.html", "/assets/a.js"]);
    const reply = await publishPreviewSnapshot({
      container: worker,
      registration,
      snapshot,
      timeoutMs: 1_000,
    });
    expect(reply).toEqual({ type: PUBLISHED_MESSAGE, buildId: "b-3", files: 2 });
    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0]).toMatchObject({
      type: PUBLISH_MESSAGE,
      buildId: "b-3",
      fallbackPath: "/index.html",
    });
    // The listener is removed once the reply arrives, so a later build cannot be counted
    // twice by a stale handler.
    expect(worker.listenerCount()).toBe(0);
  });

  it("ignores a confirmation for a different build", async () => {
    const worker = new FakeWorker();
    worker.activate();
    const { registration } = await registerPreviewWorker({ container: worker });
    worker.autoReply = false;

    const publish = publishPreviewSnapshot({
      container: worker,
      registration,
      snapshot: snapshotOf("b-4", ["/index.html"]),
      timeoutMs: 1_000,
    });
    worker.emit({ type: PUBLISHED_MESSAGE, buildId: "b-3", files: 99 });
    worker.emit({ type: PUBLISHED_MESSAGE, buildId: "b-4", files: 1 });
    await expect(publish).resolves.toEqual({ type: PUBLISHED_MESSAGE, buildId: "b-4", files: 1 });
  });

  it("fails loudly when no one confirms the publish", async () => {
    // Silence is the dangerous case: without this rejection the caller would show the
    // previous build and call it a success.
    const worker = new FakeWorker();
    worker.activate();
    const { registration } = await registerPreviewWorker({ container: worker });
    worker.autoReply = false;
    await expect(
      publishPreviewSnapshot({
        container: worker,
        registration,
        snapshot: snapshotOf("b-5", ["/index.html"]),
        timeoutMs: 20,
      }),
    ).rejects.toThrow(/did not confirm/);
  });

  it("refuses to publish when the worker is not active", async () => {
    const worker = new FakeWorker();
    await expect(
      publishPreviewSnapshot({
        container: worker,
        registration: worker as unknown as PreviewWorkerRegistration,
        snapshot: snapshotOf("b-6", []),
      }),
    ).rejects.toThrow(/not active/);
  });

  it("clears the published build", async () => {
    const worker = new FakeWorker();
    worker.activate();
    const { registration } = await registerPreviewWorker({ container: worker });
    clearPublishedPreview(registration);
    expect(worker.sent.at(-1)).toEqual({ type: CLEAR_MESSAGE });
  });
});

describe("browserWorkerContainer", () => {
  it("returns null where there is no service worker support", () => {
    expect(browserWorkerContainer({})).toBeNull();
  });

  it("returns the container when it exists", () => {
    const worker = new FakeWorker();
    expect(browserWorkerContainer({ serviceWorker: worker })).toBe(worker);
  });
});
