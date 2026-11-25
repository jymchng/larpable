/**
 * "Run the app" — the preview of a project that has no `dist/`, because it has a *server*.
 *
 * The static preview asks a question with a fixed answer: build, read `dist/`, publish the
 * bytes. A Next.js project has no such moment — `next start` listens on a port and renders
 * per request. So this hook does what a developer does by hand in the terminal, in the same
 * order, and with the same words:
 *
 * 1. read `package.json` and take the project's own `dev` script, falling back to `start` (never
 *    guess one) — the reading itself lives in `src/preview/app-server.ts`, beside the runner;
 * 2. run it in the guest (`bun run dev` / `npm run start`) through `startAppServer`, which
 *    waits for the port to *answer* rather than sleeping;
 * 3. attach the page-side forwarder, so the preview worker's requests reach the guest via
 *    `kernel.fetch()` (`src/preview/forwarder.ts` + `src/preview/app-preview.ts`);
 * 4. tell the worker which session id it is serving (`app-<id>`), so the iframe's URLs
 *    resolve to this session and no other.
 *
 * Every step can fail in its own way and says so: no package.json, no start script, a start
 * command that exits, a port that never answers, a kernel with no HTTP door. The pane shows
 * that sentence instead of an empty frame.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ExecutionEnvironment } from "@/env/execution";
import type { GuestHttpFetch } from "@/env/unkernel-kernel";
import { serveAppRequest } from "@/preview/app-preview";
import {
  readStartScript,
  startAppServer,
  type AppServerSession,
  type StartScriptFacts,
} from "@/preview/app-server";
import { attachPreviewForwarder, type PreviewForwarder } from "@/preview/forwarder";
import { kernelPreviewTransport } from "@/preview/transport";

/**
 * The two facts a start command needs, re-exported so the callers that imported them from this
 * hook keep compiling: they now live in `src/preview/app-server.ts`, beside the code that runs
 * them, and are read without a browser.
 */
export { readStartScript, type StartScriptFacts };

export type AppPreviewState =
  | { kind: "idle" }
  | { kind: "starting"; message: string }
  | {
      kind: "running";
      /** The session id in the URL: `/__preview__/<buildId>/`. */
      buildId: string;
      port: number;
      command: string;
      /** What the app answered when it first came up. */
      status: number;
    }
  | { kind: "failed"; message: string };

export interface AppPreviewControl {
  state: AppPreviewState;
  /** Read the project, start its server and wire the preview through it. */
  run: () => void;
  /** Stop the server. Safe when nothing is running. */
  stop: () => void;
}

export interface UseAppPreviewOptions {
  environment: ExecutionEnvironment | null;
  /** HTTP into the guest's loopback; null before boot or for a kernel without `fetch()`. */
  http: () => GuestHttpFetch | null;
  /** Guest project root. Defaults to the environment's workspace. */
  root?: string;
  /** Guest port for the app. Default 3000 (Next's own default). */
  port?: number;
  /** Where the app's start facts came from; injected in tests. */
  readStartScript?: (environment: ExecutionEnvironment, root: string) => Promise<StartScriptFacts>;
}

export function useAppPreview(options: UseAppPreviewOptions): AppPreviewControl {
  const { environment, http, root, port } = options;
  const [state, setState] = useState<AppPreviewState>({ kind: "idle" });

  const session = useRef<AppServerSession | null>(null);
  const forwarder = useRef<PreviewForwarder | null>(null);
  const starting = useRef(false);

  const teardown = useCallback(() => {
    forwarder.current?.dispose();
    forwarder.current = null;
    void session.current?.stop().catch(() => undefined);
    session.current = null;
  }, []);

  // A page that goes away (or a machine that is replaced) must not leave a server listening.
  useEffect(
    () => () => {
      teardown();
    },
    [teardown],
  );

  const run = useCallback(() => {
    if (starting.current || session.current !== null) return;
    if (environment === null) {
      setState({ kind: "failed", message: "Boot the Linux environment before running the project." });
      return;
    }
    if (http() === null) {
      setState({ kind: "failed", message: "This guest has no HTTP door, so a running app could not be shown." });
      return;
    }
    // Captured once: the kernel's `fetch` is the transport's whole world, and it must be the
    // same door for the start-up probe and for every request the preview forwards later.
    const guestFetch = http() as GuestHttpFetch;

    starting.current = true;
    const projectRoot = root ?? environment.workspacePath;
    const guestPort = port ?? 3000;
    setState({ kind: "starting", message: "Reading the project's start script…" });

    void (async () => {
      try {
        const facts = await (options.readStartScript ?? readStartScript)(environment, projectRoot);
        if (facts.command === null) {
          setState({
            kind: "failed",
            message: facts.problem ?? "The project has no script to run.",
          });
          return;
        }

        const command = facts.command;
        setState({ kind: "starting", message: `Starting \`${command}\` in the guest on port ${String(guestPort)}…` });

        const started = await startAppServer({
          environment,
          command,
          root: projectRoot,
          port: guestPort,
          fetch: http(),
          onStage: (message) => setState({ kind: "starting", message }),
        });
        if (!started.ok || started.session === null) {
          setState({ kind: "failed", message: started.message });
          return;
        }

        session.current = started.session;
        const buildId = `app-${Date.now().toString(36)}`;
        const transport = kernelPreviewTransport({ fetch: guestFetch }, { port: guestPort });

        forwarder.current = attachPreviewForwarder({
          container: navigator.serviceWorker,
          buildId,
          serve: (path, method) => serveAppRequest({ path, method }, { transport, port: guestPort, buildId }),
          onError: (message) => setState({ kind: "failed", message }),
        });

        const registration = await navigator.serviceWorker.ready;
        registration.active?.postMessage({ type: "larpable:preview:forward:install", buildId });

        setState({
          kind: "running",
          buildId,
          port: guestPort,
          command,
          status: started.session.status,
        });
      } catch (error) {
        setState({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
      } finally {
        starting.current = false;
      }
    })();
  }, [environment, http, options.readStartScript, port, root]);

  const stop = useCallback(() => {
    teardown();
    setState({ kind: "idle" });
  }, [teardown]);

  return { state, run, stop };
}
