/**
 * Publishing a build to the preview worker.
 *
 * The protocol is small, and the failure it prevents is not: `postMessage` resolves for
 * nobody, so a publish that no worker received is indistinguishable from a successful one
 * unless the worker confirms it. Every test here is about that confirmation or about the
 * registration details that decide whether the worker can answer preview URLs at all.
 *
 * The fakes below dispatch events where the *platform* dispatches them, which is the whole
 * point of `FakeServiceWorker` existing separately from `FakeRegistration`. An earlier
 * version of this file had one object doing both and fired `"statechange"` on the
 * registration — the event a real registration never sends. 669 green tests then coexisted
 * with a browser in which the worker never counted as activated, so every cold publish
 * waited 15 s and failed. A fake that models the implementation instead of the platform can
 * only confirm what the implementation already believes.
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
  type PreviewWorker,
  type PreviewWorkerContainer,
  type PreviewWorkerRegistration,
} from "../src/preview/client";
import type { PreviewSnapshot } from "../src/preview/proxy";

/** One tick of the macrotask queue, i.e. long enough for `setTimeout(…, 0)`. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A `ServiceWorker`: the object that dispatches `statechange`.
 *
 * `send` is what `postMessage` does; a worker with no page to talk to passes a no-op.
 */
class FakeServiceWorker implements PreviewWorker {
  #state: string;
  readonly #stateListeners = new Set<() => void>();
  readonly #send: (message: unknown) => void;

  constructor(state: string, send: (message: unknown) => void = () => undefined) {
    this.#state = state;
    this.#send = send;
  }

  get state(): string {
    return this.#state;
  }

  postMessage(message: unknown): void {
    this.#send(message);
  }

  addEventListener(type: "statechange", listener: () => void): void {
    // Anything else is not this object's event, and pretending otherwise is what hid the bug.
    if (type === "statechange") this.#stateListeners.add(listener);
  }

  removeEventListener(type: "statechange", listener: () => void): void {
    if (type === "statechange") this.#stateListeners.delete(listener);
  }

  /** How many listeners this worker is holding; a leak would show up here. */
  listenerCount(): number {
    return this.#stateListeners.size;
  }

  /** Move through a lifecycle state the way a browser does: change, then notify. */
  transitionTo(state: string): void {
    this.#state = state;
    for (const listener of [...this.#stateListeners]) listener();
  }
}

/** A `ServiceWorkerRegistration`: it dispatches `updatefound`, and only that. */
class FakeRegistration implements PreviewWorkerRegistration {
  active: FakeServiceWorker | null = null;
  installing: FakeServiceWorker | null = null;
  waiting: FakeServiceWorker | null = null;
  readonly #updateFound = new Set<() => void>();

  addEventListener(type: "updatefound", listener: () => void): void {
    if (type === "updatefound") this.#updateFound.add(listener);
  }

  removeEventListener(type: "updatefound", listener: () => void): void {
    this.#updateFound.delete(listener);
  }

  updateFoundListenerCount(): number {
    return this.#updateFound.size;
  }

  fireUpdateFound(): void {
    for (const listener of [...this.#updateFound]) listener();
  }
}

/** The container (`navigator.serviceWorker`) plus the registration it hands out. */
class FakeWorker implements PreviewWorkerContainer {
  readonly sent: unknown[] = [];
  readonly registrations: { scriptUrl: string; options?: { scope?: string; type?: string } }[] = [];
  readonly registration = new FakeRegistration();
  /** Answer a publish the way `public/preview-sw.js` does, counting the files. */
  autoReply = true;
  readonly #messageListeners = new Set<(event: MessageEvent) => void>();

  async register(
    scriptUrl: string,
    options?: { scope?: string; type?: "module" | "classic" },
  ): Promise<PreviewWorkerRegistration> {
    this.registrations.push(options === undefined ? { scriptUrl } : { scriptUrl, options });
    return this.registration;
  }

  addEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.#messageListeners.add(listener);
  }

  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void {
    if (type === "message") this.#messageListeners.delete(listener);
  }

  listenerCount(): number {
    return this.#messageListeners.size;
  }

  /** A worker that is serving already, as on a second visit within one session. */
  alreadyActive(): FakeServiceWorker {
    const worker = new FakeServiceWorker("activated", (message) => this.#receive(message));
    this.registration.active = worker;
    return worker;
  }

  /** A cold visit: a worker turns up in `installing` and announces itself. */
  install(state = "installing"): FakeServiceWorker {
    const worker = new FakeServiceWorker(state, (message) => this.#receive(message));
    this.registration.installing = worker;
    this.registration.fireUpdateFound();
    return worker;
  }

  /** The browser's own sequence: `activating`, the slot swap, `activated`. */
  activate(worker: FakeServiceWorker): void {
    worker.transitionTo("activating");
    if (this.registration.installing === worker) this.registration.installing = null;
    if (this.registration.waiting === worker) this.registration.waiting = null;
    this.registration.active = worker;
    worker.transitionTo("activated");
  }

  emit(data: unknown): void {
    for (const listener of this.#messageListeners) listener({ data } as MessageEvent);
  }

  #receive(message: unknown): void {
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

/**
 * A compile-time pin: the platform's own registration must still satisfy the slice this
 * module uses. If a future edit widens the slice into something the browser does not offer
 * (an `"statechange"` listener, say), this stops type-checking.
 */
const asSlice = (registration: ServiceWorkerRegistration): PreviewWorkerRegistration =>
  registration;
void asSlice;

describe("registerPreviewWorker", () => {
  it("registers the module worker at the preview scope", async () => {
    const worker = new FakeWorker();
    worker.alreadyActive();
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
    worker.alreadyActive();
    const result = await registerPreviewWorker({ container: worker });
    expect(result.waited).toBe(false);
  });

  it("waits for activation reported by the worker object, not the registration", async () => {
    // The regression this file exists for. `register()` resolves while the worker is still
    // installing; the only signal that it became active is `statechange` on the worker.
    const worker = new FakeWorker();
    const registering = registerPreviewWorker({ container: worker, timeoutMs: 1_000, pollMs: 5 });
    await tick();

    const installing = worker.install();
    await tick();
    expect(worker.registration.active).toBeNull();
    // The wait is listening to the worker, which is where the event is dispatched…
    expect(installing.listenerCount()).toBe(1);
    // …and has nothing to listen for on the registration beyond `updatefound`.
    expect(worker.registration.updateFoundListenerCount()).toBe(1);

    worker.activate(installing);
    await expect(registering).resolves.toMatchObject({ waited: true });
    // Nothing is left behind: a preview is republished on every build.
    expect(installing.listenerCount()).toBe(0);
    expect(worker.registration.updateFoundListenerCount()).toBe(0);
  });

  it("notices a worker that becomes active without any event", async () => {
    // Belt and braces for engines that do not dispatch `statechange`, and for the race
    // where the slot fills between two events.
    const worker = new FakeWorker();
    const registering = registerPreviewWorker({ container: worker, timeoutMs: 1_000, pollMs: 5 });
    await tick();
    worker.alreadyActive();
    await expect(registering).resolves.toMatchObject({ waited: true });
  });

  it("fails at once when the worker is discarded while installing", async () => {
    // Chromium marks a worker `redundant` when its script cannot install. Waiting out the
    // timeout would report a symptom 15 s late and hide the cause.
    const worker = new FakeWorker();
    const started = Date.now();
    const registering = registerPreviewWorker({ container: worker, timeoutMs: 10_000, pollMs: 5 });
    await tick();
    const installing = worker.install();
    installing.transitionTo("redundant");

    await expect(registering).rejects.toThrow(/discarded while installing/);
    await expect(registering).rejects.toThrow(new RegExp(PREVIEW_WORKER_URL));
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("says what to do when the worker never activates, and names each slot", async () => {
    const worker = new FakeWorker();
    await expect(
      registerPreviewWorker({ container: worker, timeoutMs: 20, pollMs: 5 }),
    ).rejects.toThrow(
      /did not activate within 20 ms \(installing: none, waiting: none, active: none\)/,
    );
  });

  it("reports the installing state in the timeout when it never advances", async () => {
    const worker = new FakeWorker();
    const registering = registerPreviewWorker({ container: worker, timeoutMs: 30, pollMs: 5 });
    await tick();
    worker.install();
    await expect(registering).rejects.toThrow(/installing: installing/);
  });
});

describe("publishPreviewSnapshot", () => {
  it("posts the build and resolves the worker's file count", async () => {
    const worker = new FakeWorker();
    worker.alreadyActive();
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
    worker.alreadyActive();
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
    worker.alreadyActive();
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
        registration: new FakeRegistration(),
        snapshot: snapshotOf("b-6", []),
      }),
    ).rejects.toThrow(/not active/);
  });

  it("clears the published build", async () => {
    const worker = new FakeWorker();
    worker.alreadyActive();
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
