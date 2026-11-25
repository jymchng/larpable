// @vitest-environment jsdom
/**
 * The developer's own loop, end to end: a dev server on 1234, Prod off, and the pane's reload arrow.
 *
 * The scenario, in the words it was reported in:
 *
 *   1. `bun i && bun run dev -- --port 1234` in the terminal, and wait for Vite to answer;
 *   2. Settings: port 1234, Prod off;
 *   3. Preview → press the reload arrow beside the address bar;
 *   4. press it again a while later — and still see no preview.
 *
 * Nothing in this file is a stand-in for the parts that were wrong. It mounts the real
 * `usePreview` hook, which builds the real `createPreviewController`, which calls the real
 * `attachGuestServer` — knock, register, install the forwarder, tell the worker which session it
 * serves. The only fakes are the two things a test cannot have: a guest (a `fetch` that answers
 * like Vite) and a service worker (a container that records the registration, the install
 * messages and the page's answers, and can post the worker's `larpable:preview:forward` back).
 *
 * Two of those fakes are what make this the test that would have caught the bugs:
 *
 * - the page's forwarder is registered on `navigator.serviceWorker` — where a worker's messages
 *   actually arrive — so a listener on `window` (the bug that produced "The app did not answer …
 *   within 30 s") fails here rather than in a browser;
 * - the worker is simulated as *stateless between attaches*: it has forgotten the session by the
 *   time the second reload arrives, exactly as a worker that Chromium stopped after ~30 s idle
 *   has. The page must still answer, which is what the claim in `forwarder.ts` is for.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FakeEnvironment } from "../src/env/fake-environment";
import type { GuestHttpFetch } from "../src/env/unkernel-kernel";
import {
  FORWARD_CLAIM_MESSAGE,
  FORWARD_REPLY_MESSAGE,
  FORWARD_REQUEST_MESSAGE,
} from "../src/preview/forwarder";
import { PreviewPane } from "../src/ui/preview-pane";
import type { BuildControl } from "../src/ui/use-build";
import { usePreview } from "../src/ui/use-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The port the user typed in Settings, and the one Vite was told to use. */
const PORT = 1234;

/** What Vite answers `GET /` with: a document with root-absolute URLs, as a dev server does. */
const VITE_HTML =
  '<!doctype html><html><head><script type="module" src="/@vite/client"></script></head>' +
  "<body><div id=\"root\"></div></body></html>";

// ---------------------------------------------------------------------------
// The two things a test cannot have: a guest, and a service worker
// ---------------------------------------------------------------------------

/** A guest `fetch` that answers like the dev server the user started on 1234. */
function viteGuest(): { http: GuestHttpFetch; requested: string[] } {
  const requested: string[] = [];
  const http = async (url: string): Promise<Response> => {
    requested.push(url);
    if (!url.startsWith(`http://127.0.0.1:${String(PORT)}`)) {
      throw new Error(`connection refused: ${url}`);
    }
    if (url.endsWith("/")) {
      return new Response(VITE_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response("", { status: 404 });
  };
  return { http: http as GuestHttpFetch, requested };
}

interface FakeWorker {
  /** `navigator.serviceWorker` for the test. */
  container: {
    register: () => Promise<unknown>;
    addEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
    removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => void;
  };
  /** Every message the page posted to the worker, in order. */
  received: Array<Record<string, unknown>>;
  /** Post the worker's own forward request, and collect what the page answers. */
  forward(url: string): Promise<Array<Record<string, unknown>>>;
  /** Forget the session, as a worker that was stopped and restarted has. */
  restart(): void;
}

function fakeWorker(): FakeWorker {
  const received: Array<Record<string, unknown>> = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  let installs = 0;

  const worker = {
    postMessage: (message: unknown) => {
      const record = message as Record<string, unknown>;
      received.push(record);
      if (record.type === "larpable:preview:forward:install") installs += 1;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    state: "activated",
  };

  return {
    container: {
      register: async () => ({
        active: worker,
        installing: null,
        waiting: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
      addEventListener: (type, listener) => {
        if (type === "message") listeners.add(listener);
      },
      removeEventListener: (type, listener) => {
        if (type === "message") listeners.delete(listener);
      },
    },
    received,
    async forward(url) {
      // The session the worker believes it serves. It is read from the *last* install message,
      // and `restart()` clears it: that is the whole point of the claim protocol.
      const buildId = installs === 0 ? null : lastInstallBuildId(received);
      const answers: Array<Record<string, unknown>> = [];
      const requestId = `r-${String(received.length)}-${url}`;
      for (const listener of listeners) {
        listener({
          data: {
            type: FORWARD_REQUEST_MESSAGE,
            requestId,
            url,
            method: "GET",
            buildId,
          },
          source: { postMessage: (message: unknown) => answers.push(message as Record<string, unknown>) },
        } as unknown as MessageEvent);
      }
      // Let the page's async `serve` settle; the fake guest answers on a microtask.
      for (let tick = 0; tick < 6; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return answers;
    },
    restart() {
      installs = 0;
    },
  };
}

function lastInstallBuildId(received: Array<Record<string, unknown>>): string | null {
  for (let index = received.length - 1; index >= 0; index -= 1) {
    const message = received[index];
    if (message?.type === "larpable:preview:forward:install") {
      return (message.buildId as string | null) ?? null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The pane, wired exactly as `App.tsx` wires it
// ---------------------------------------------------------------------------

/**
 * The build control the app hands the pane.
 *
 * It is here because the pane's empty state is written by whoever renders the hammer: with no
 * control it can only say "a preview appears here once a build has been published", which is the
 * wrong sentence for a dev preview. `App` always passes one, so the test does too.
 */
function buildControl(): BuildControl {
  return {
    status: { kind: "none" },
    busy: false,
    problem: null,
    run: () => undefined,
    cancel: () => undefined,
    port: null,
  };
}

function PreviewTab({ environment }: { environment: FakeEnvironment }) {
  const preview = usePreview({
    environment,
    http: () => environment.guestHttp(),
    port: PORT,
    root: "dist",
    // Settings: Prod off.
    prod: false,
  });

  return (
    <PreviewPane
      phase={preview.phase}
      onRefresh={(buildId) => preview.refresh(buildId)}
      available={preview.available}
      prod={false}
      port={PORT}
      build={buildControl()}
      onAttach={(port) => preview.attach(port)}
    />
  );
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(node);
  });
}

/** Let the attach's awaits — register, knock, install — finish, and React re-render. */
async function settle(rounds = 10): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/**
 * Wait until `check` holds, letting React and the preview's promises run.
 *
 * The start path waits for the port to *answer* rather than sleeping a fixed time, so a test that
 * guessed at a number of microtask rounds would be flaky by construction. This waits for the fact
 * it is about, with a budget so a real failure fails rather than hangs.
 */
async function until(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function reload(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="preview-reload"]');
  if (button === null) throw new Error("the pane has no reload arrow");
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function frameSrc(): string | null {
  return document.querySelector('[data-testid="preview-iframe"]')?.getAttribute("src") ?? null;
}

/** What the pane is showing when there is no frame: the placeholder's own sentence. */
function placeholder(): string {
  return document.querySelector('[data-testid="preview-placeholder"]')?.textContent ?? "";
}

const realServiceWorker = Object.getOwnPropertyDescriptor(Navigator.prototype, "serviceWorker");

beforeEach(() => {
  // jsdom has no service worker, and the preview refuses to pretend: it installs its forwarder on
  // `navigator.serviceWorker`, so the test provides one where the browser provides one.
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
  if (realServiceWorker === undefined) {
    Reflect.deleteProperty(Navigator.prototype, "serviceWorker");
  } else {
    Object.defineProperty(Navigator.prototype, "serviceWorker", realServiceWorker);
  }
});

function installWorker(worker: FakeWorker): void {
  Object.defineProperty(Navigator.prototype, "serviceWorker", {
    value: worker.container,
    configurable: true,
  });
}

describe("a dev server on the Settings port, Prod off", () => {
  it("fills the pane from the reload arrow, and again after the worker has been restarted", async () => {
    const guest = viteGuest();
    const worker = fakeWorker();
    installWorker(worker);

    const environment = new FakeEnvironment({ guestHttp: guest.http });
    await environment.initialize();

    mount(<PreviewTab environment={environment} />);

    // Nothing has been asked for yet: the pane is empty, and says what to do about it in the mode
    // it is in — start the server, press the arrow — rather than pointing at the hammer.
    expect(frameSrc()).toBeNull();
    expect(placeholder()).toContain(`guest port ${String(PORT)}`);
    expect(placeholder()).toContain("reload arrow");

    // 3. Press the reload arrow.
    reload();
    await settle();

    // The knock went to the guest's loopback on the Settings port, and the frame points at the
    // session the controller attached to.
    expect(guest.requested[0]).toBe(`http://127.0.0.1:${String(PORT)}/`);
    expect(frameSrc()).toBe("/__preview__/dev-1/");
    expect(document.querySelector('[data-served]')?.getAttribute("data-served")).toBe("guest");

    // The worker forwards the document request. The page must answer it — on the container the
    // worker posts to, with the guest's bytes, rebased onto the session's URL space.
    const first = await worker.forward("https://app.example/__preview__/dev-1/");
    expect(first.map((message) => message.type)).toContain(FORWARD_CLAIM_MESSAGE);
    const firstReply = first.find((message) => message.type === FORWARD_REPLY_MESSAGE);
    expect(firstReply?.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(firstReply?.body as ArrayBuffer))).toContain(
      "/__preview__/dev-1/@vite/client",
    );

    // 4. "Press it again a while later": the worker was stopped and restarted, so it has forgotten
    // which session it serves — the state that produced "No preview build has been published yet".
    worker.restart();

    reload();
    await settle();

    // A new attach means a new session id, so the frame is a fresh document rather than a cached
    // one: `/__preview__/dev-2/`, and not the dev-1 it was showing.
    expect(frameSrc()).toBe("/__preview__/dev-2/");

    // And the restarted worker is answered anyway: the page claims the session it is actually
    // serving, which is the fact the worker cannot hold on its own.
    const second = await worker.forward("https://app.example/__preview__/dev-2/");
    expect(second.map((message) => message.type)).toContain(FORWARD_CLAIM_MESSAGE);
    const secondReply = second.find((message) => message.type === FORWARD_REPLY_MESSAGE);
    expect(secondReply?.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(secondReply?.body as ArrayBuffer))).toContain(
      "/__preview__/dev-2/@vite/client",
    );

    // The session that is no longer on screen is refused rather than served: a stale frame must
    // never receive the new session's bytes, and the refusal names the session this page does serve
    // so the reason is in the sentence rather than in a blank frame.
    const stale = await worker.forward("https://app.example/__preview__/dev-1/");
    const refusal = stale.find((message) => message.type === FORWARD_REPLY_MESSAGE);
    expect(refusal?.status).toBe(404);
    expect(new TextDecoder().decode(new Uint8Array(refusal?.body as ArrayBuffer))).toContain("dev-2");
  });

  it("starts the project itself on one press when nothing is listening", async () => {
    // The case the fix was reported for: a fresh project, nothing running, Prod off, one press of
    // the reload arrow. Nothing in this test is a stand-in for the parts that were wrong — the real
    // `usePreview`, the real controller, the real `readStartScript` and `startAppServer`. The only
    // fakes are the two a test cannot have: the guest (a `fetch` that refuses until the project's
    // script has been "run", then answers like Vite) and the service worker.
    const worker = fakeWorker();
    installWorker(worker);

    let running = false;
    const commands: string[] = [];
    const http = (async (url: string): Promise<Response> => {
      // A refused connection is the only "nothing is there", which is what makes the preview
      // start the project instead of attaching to nothing.
      if (!running) throw new Error(`connection refused: ${url}`);
      if (url.endsWith("/")) {
        return new Response(VITE_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("", { status: 404 });
    }) as GuestHttpFetch;

    const environment = new FakeEnvironment({
      tree: {
        // The project's own facts: a `dev` script, and the lockfile that says how to run it.
        "package.json": JSON.stringify({ scripts: { dev: "vite" } }),
        "bun.lock": "",
      },
      guestHttp: http,
      // No real process: the command is recorded, and the guest starts answering from then on.
      fallback: (command) => {
        running = true;
        commands.push(command);
        return { stdout: "VITE v5.0.0  ready in 120 ms\n" };
      },
    });
    await environment.initialize();

    mount(<PreviewTab environment={environment} />);
    expect(frameSrc()).toBeNull();

    // 1. One press: the project is read, started in the guest, and attached to.
    reload();
    await until(() => frameSrc() !== null);

    expect(commands).toEqual(["bun run dev"]);
    expect(frameSrc()).toBe("/__preview__/dev-1/");
    expect(document.body.textContent ?? "").not.toContain("Nothing answered");

    // The document the started server serves is what the pane's forwarder hands back.
    const first = await worker.forward("https://app.example/__preview__/dev-1/");
    const firstReply = first.find((message) => message.type === FORWARD_REPLY_MESSAGE);
    expect(firstReply?.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(firstReply?.body as ArrayBuffer))).toContain(
      "/__preview__/dev-1/@vite/client",
    );

    // 2. A second press finds the server answering, so it attaches again and starts nothing: a
    //    second `bun run dev` on the same port would fail with EADDRINUSE.
    reload();
    await until(() => frameSrc() === "/__preview__/dev-2/");

    expect(commands).toHaveLength(1);

    // 3. And after the worker was stopped and restarted — the state that once produced "No
    //    preview build has been published yet" — the arrow still shows the site.
    worker.restart();
    reload();
    await until(() => frameSrc() === "/__preview__/dev-3/");

    expect(commands).toHaveLength(1);
    const third = await worker.forward("https://app.example/__preview__/dev-3/");
    const thirdReply = third.find((message) => message.type === FORWARD_REPLY_MESSAGE);
    expect(thirdReply?.status).toBe(200);
    expect(new TextDecoder().decode(new Uint8Array(thirdReply?.body as ArrayBuffer))).toContain(
      "/__preview__/dev-3/@vite/client",
    );
  });

  it("says what to run when nothing is listening, instead of showing a blank frame", async () => {
    const worker = fakeWorker();
    installWorker(worker);

    // The user has not started the dev server yet: the knock is refused.
    const environment = new FakeEnvironment({
      guestHttp: (async () => {
        throw new Error("connection refused");
      }) as GuestHttpFetch,
    });
    await environment.initialize();

    mount(<PreviewTab environment={environment} />);
    reload();
    await settle();

    expect(frameSrc()).toBeNull();
    const text = document.body.textContent ?? "";
    expect(text).toContain(`Nothing answered on guest port ${String(PORT)}`);
    expect(text).toContain(`bun run dev -- -p ${String(PORT)}`);
  });
});
