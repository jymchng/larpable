// @vitest-environment jsdom
/**
 * Who owns the server the dev preview starts.
 *
 * `use-preview.ts` owns the *controller's* lifetime: it makes one when a machine becomes usable
 * and stops it when the machine is replaced, when the pane goes away, or when the Prod switch
 * changes the mode (which rebuilds the controller on purpose). "Stops it" has to mean the
 * project's server too — otherwise pressing the reload arrow with Prod off would leave a listener
 * behind on the Settings port, and the next press would be met by a second server or by
 * EADDRINUSE.
 *
 * These tests mount the real hook and the real controller. The only fakes are the guest boundary
 * — "does anything answer?", "what is the start script?", "run it", "attach" — which is exactly
 * what the controller already accepts as injection points, so nothing here reimplements the
 * logic under test.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import type { AppServerSession, AppServerStart } from "../src/preview/app-server";
import { createPreviewController, type PreviewControllerOptions } from "../src/preview/controller";
import { FakeEnvironment } from "../src/env/fake-environment";
import type { GuestHttpFetch } from "../src/env/unkernel-kernel";
import { usePreview } from "../src/ui/use-preview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PORT = 1234;

/** Everything the guest would have done, recorded. */
interface Guest {
  /** How many servers this guest was asked to start. */
  starts: number;
  /** How many servers that were started have been stopped again. */
  stops: number;
  /** How many attach forwarders were made. */
  attaches: number;
}

/**
 * The controller factory the hook is pointed at, with the guest boundary faked.
 *
 * A guest that starts a server also starts answering: the probe returns 200 once `starts > 0`,
 * which is what a real dev server does and what makes a second press an attach rather than a
 * second start.
 */
function factoryFor(guest: Guest): typeof createPreviewController {
  return (options: PreviewControllerOptions) => {
    let answering = false;
    return createPreviewController({
      ...options,
      probe: async () => (answering ? 200 : null),
      readScript: async () => ({
        dev: "vite",
        start: null,
        command: "bun run dev",
        script: "dev",
        packageManager: "bun",
        problem: null,
      }),
      startApp: async (startOptions) => {
        guest.starts += 1;
        const port = startOptions.port ?? 3000;
        const session: AppServerSession = {
          port,
          command: startOptions.command,
          url: `http://127.0.0.1:${String(port)}/`,
          status: 200,
          output: () => "",
          running: () => true,
          async stop() {
            guest.stops += 1;
          },
        };
        answering = true;
        const started: AppServerStart = {
          ok: true,
          session,
          reason: null,
          message: `Running \`${startOptions.command}\` on port ${String(port)}.`,
        };
        return started;
      },
      attach: async (attachOptions) => {
        guest.attaches += 1;
        return {
          ok: true,
          attach: {
            port: attachOptions.port,
            buildId: attachOptions.buildId,
            url: `/__preview__/${attachOptions.buildId}/`,
            status: 200,
            note: `Forwarding to guest port ${String(attachOptions.port)}.`,
            serve: async () => ({ status: 200, headers: {}, body: new Uint8Array() }),
            async stop() {
              // The forwarder, not the server: stopping it must not be mistaken for a server stop.
            },
            answered: () => 0,
            failures: () => [],
          },
        };
      },
    });
  };
}

function Tab({
  environment,
  prod,
  create,
}: {
  environment: FakeEnvironment;
  prod: boolean;
  create: typeof createPreviewController;
}) {
  const preview = usePreview({
    environment,
    http: () => environment.guestHttp(),
    port: PORT,
    root: "dist",
    prod,
    createController: create,
  });

  return (
    <div>
      <span data-testid="kind">{preview.phase.kind}</span>
      <button data-testid="refresh" onClick={() => preview.refresh()}>
        reload
      </button>
    </div>
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

async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function press(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-testid="refresh"]');
  if (button === null) throw new Error("the tab has no reload control");
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function phaseKind(): string {
  return document.querySelector('[data-testid="kind"]')?.textContent ?? "";
}

async function environmentWith(): Promise<FakeEnvironment> {
  const answer = (async () => new Response("", { status: 200 })) as GuestHttpFetch;
  const environment = new FakeEnvironment({ guestHttp: answer });
  await environment.initialize();
  return environment;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  host?.remove();
  host = null;
});

describe("the dev preview's server, as the hook owns it", () => {
  it("stops the server it started when the mode is switched to Prod", async () => {
    // Prod on rebuilds the controller (the memo is keyed on it), and the cleanup of the old one
    // is where the dev server is stopped. The machine is the same; only the mode changed.
    const guest: Guest = { starts: 0, stops: 0, attaches: 0 };
    const create = factoryFor(guest);
    const environment = await environmentWith();

    mount(<Tab environment={environment} prod={false} create={create} />);
    press();
    await settle();

    expect(guest.starts).toBe(1);
    expect(phaseKind()).toBe("ready");

    act(() => {
      root?.render(<Tab environment={environment} prod={true} create={create} />);
    });
    await settle();

    expect(guest.stops).toBe(1);
  });

  it("stops the server it started when the pane goes away", async () => {
    const guest: Guest = { starts: 0, stops: 0, attaches: 0 };
    const create = factoryFor(guest);
    const environment = await environmentWith();

    mount(<Tab environment={environment} prod={false} create={create} />);
    press();
    await settle();
    expect(guest.starts).toBe(1);

    act(() => {
      root?.unmount();
    });
    root = null;
    await settle();

    expect(guest.stops).toBe(1);
  });

  it("re-attaches on a second press and starts no second server", async () => {
    const guest: Guest = { starts: 0, stops: 0, attaches: 0 };
    const create = factoryFor(guest);
    const environment = await environmentWith();

    mount(<Tab environment={environment} prod={false} create={create} />);
    press();
    await settle();
    press();
    await settle();

    expect(guest.starts).toBe(1);
    expect(guest.attaches).toBe(2);
    expect(guest.stops).toBe(0);
    expect(phaseKind()).toBe("ready");
  });
});
