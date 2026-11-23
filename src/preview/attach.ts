/**
 * Attaching the preview to a server *the user* runs.
 *
 * The preview has always been able to show a build: `session.ts` starts a static server in the
 * guest, reads `dist/` out of it and publishes the bytes. That is the right answer to "what will
 * Netlify serve". It is the wrong answer to the question a developer asks twenty times a minute
 * — "what does my dev server say right now" — because a dev server has no `dist/`: it compiles
 * per request, its routes are its own, and the whole point of running it is that the bytes change
 * while you look at them.
 *
 * So this module is the other half of the preview, and it is deliberately the *smaller* half: it
 * starts nothing, builds nothing, and reads no files. It does four things, in this order, and
 * every one of them is a decision that can be checked:
 *
 * 1. **Knock on the port.** One `GET /` through `kernel.fetch()`. Any HTTP answer means the socket
 *    is open and something is speaking — a dev server's 404 is still a dev server. No answer is
 *    reported as "nothing is listening", with the command that would make something listen,
 *    because a blank frame at this point would be indistinguishable from a broken preview.
 * 2. **Hold the worker's handshake.** The iframe's requests for `/__preview__/<id>/…` are answered
 *    by the service worker, and a worker cannot reach the guest (no kernel in a worker). It asks
 *    the page; `forwarder.ts` is the page's answer; this module installs that forwarder and tells
 *    the worker which session it is serving. Without a worker there is no way in at all, so that
 *    is a failure with its own sentence rather than a silently empty preview. The forwarder is
 *    installed on `navigator.serviceWorker` — see `messagesOf()` for why `window` is the wrong
 *    object and what that mistake looked like to a user.
 * 3. **Answer each request through the guest.** `serveAppRequest` (the same code the "run the app"
 *    path uses) forwards one path to the port, rebases root-absolute URLs onto the preview prefix
 *    and keeps redirects inside the pane. One transport, one timeout, one set of header rules.
 * 4. **Stay stoppable.** `stop()` disposes the page's listener and tells the worker that no
 *    session is being forwarded, so switching ports or shutting the machine down leaves nothing
 *    behind that could answer a later request with the wrong server's bytes.
 *
 * What is *not* here is as important: no `dist/` is read, no guest `node` is started, and the
 * publish directory in Settings is not consulted. Prod is the mode that does those things
 * (`mode.ts` decides, `session.ts` acts); this is the mode that does none of them.
 */

import type { GuestHttpFetch } from "@/env/unkernel-kernel";
import { serveAppRequest, type AppPreviewResponse } from "./app-preview";
import {
  browserWorkerContainer,
  registerPreviewWorker,
  type PreviewWorkerContainer,
  type PreviewWorkerRegistration,
} from "./client";
import {
  FORWARD_INSTALL_MESSAGE,
  attachPreviewForwarder,
  type MessageContainer,
} from "./forwarder";
import { previewBasePath } from "./routing";
import { fetchTransport, type PreviewTransport } from "./transport";

export interface GuestAttachOptions {
  /** HTTP into the guest's loopback — `UnkernelEnvironment.guestHttp()`. Required. */
  http: GuestHttpFetch;
  /** The guest port the user's server listens on. Never guessed: it comes from Settings. */
  port: number;
  /** The session id the preview's URLs carry, e.g. `dev-mf3k2`. */
  buildId: string;
  /**
   * The page's service worker container. Default: `navigator.serviceWorker`, or null where the
   * browser has none — and null is a failure here, not a fallback, because the worker is the
   * only thing that can route a frame's request to this page.
   */
  container?: PreviewWorkerContainer | null;
  /**
   * Where the worker's forward messages arrive. Default: the same container that registered the
   * worker — `navigator.serviceWorker`. See `messagesOf()` for why that is not `window`.
   */
  messages?: MessageContainer;
  /** Budget for the one knock on the port. Default: the transport's 10 s. */
  timeoutMs?: number;
  /** Called for every forwarded request that failed, so the pane can say why. */
  onError?: (message: string) => void;
}

export interface GuestAttach {
  /** The guest port the preview is attached to. */
  port: number;
  /** The session id in the preview's URLs. */
  buildId: string;
  /** `/__preview__/<buildId>/` — where the pane points the iframe. */
  url: string;
  /** The status the port answered the knock with. Shown, because it is the evidence. */
  status: number;
  /** One sentence about how the bytes arrive, for the pane's own tooltip. */
  note: string;
  /** Forward one path to the user's server. */
  serve(path: string, method?: string): Promise<AppPreviewResponse>;
  /** Stop answering. Idempotent. */
  stop(): Promise<void>;
  /** How many requests were answered — the acceptance run reads this instead of guessing. */
  answered(): number;
  /** Answers that failed, newest last. */
  failures(): readonly string[];
}

export type GuestAttachResult =
  | { ok: true; attach: GuestAttach }
  | { ok: false; message: string };

/**
 * The object a service worker's messages are dispatched at.
 *
 * It is the container that registered the worker — a page's `navigator.serviceWorker` — and *not*
 * `window`. `Client.postMessage()` fires its `message` event at the client's
 * `ServiceWorkerContainer`; a listener on `window` never sees it. This module shipped with a
 * `window` listener, and the consequence was not subtle: the page never heard the worker's
 * `larpable:preview:forward`, so it never answered, so every request the iframe made sat until
 * the worker's own budget expired and the pane showed
 *
 *     The app did not answer for https://…/__preview__/dev-1/ within 30 s.
 *     It may still be compiling; reload the preview.
 *
 * for a dev server that had answered in milliseconds — and "reload the preview" could never
 * help, because the bug was on this side of the wire. `use-app-preview.ts` has always listened
 * on `navigator.serviceWorker`; this is the same wire, and the default now matches it.
 *
 * The cast is the price of one object described by two interfaces: `PreviewWorkerContainer` is a
 * `MessageEvent`-typed view of the container `forwarder.ts` wants, and a page has exactly one
 * `navigator.serviceWorker`.
 */
function messagesOf(container: PreviewWorkerContainer): MessageContainer {
  return container as unknown as MessageContainer;
}

/** The command a user is most likely to have meant, named in the failure's own sentence. */
function startHint(port: number): string {
  return `bun run dev -- -p ${String(port)}`;
}

/**
 * Attach the preview to whatever is listening on `options.port` inside the guest.
 *
 * The knock comes first because everything after it is expensive and pointless against a closed
 * socket: registering a worker and installing a forwarder for a port nobody serves would produce
 * a pane that loads a document from nowhere. The result is a union rather than a throw because
 * "nothing is listening on 1234" is an ordinary state of a developer's afternoon, and it deserves
 * a sentence in the pane rather than an exception in a console.
 */
export async function attachGuestServer(
  options: GuestAttachOptions,
): Promise<GuestAttachResult> {
  const container = options.container === undefined ? browserWorkerContainer() : options.container;
  if (container === null) {
    return {
      ok: false,
      message:
        "This browser has no service worker, so a preview cannot forward requests to your own " +
        "server: the frame's URLs would be answered by the app instead of by the guest. " +
        "Enable service workers (or use a browser that has them) and reload the preview.",
    };
  }

  // `fetchTransport` rather than `kernelPreviewTransport` because the app hands over a
  // `GuestHttpFetch` (a narrower `fetch` shape), and both transports are the same code path —
  // same timeout, same abort handling, same lower-cased headers — with only the base URL
  // decided differently.
  const transport: PreviewTransport = fetchTransport(options.http, {
    baseUrl: `http://127.0.0.1:${String(options.port)}`,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });

  let status: number;
  try {
    // `/` rather than a path of the user's choosing: the question is only "is the socket open
    // and is something speaking HTTP on it", and any answer — 200, 404, 500 — is a yes.
    const knock = await transport.fetch("/");
    status = knock.status;
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message:
        `Nothing answered on guest port ${String(options.port)}, so there is nothing to attach ` +
        `to. Start your own server in the terminal — for example \`${startHint(options.port)}\` — ` +
        `and reload the preview. (${cause})`,
    };
  }

  let registration: PreviewWorkerRegistration;
  try {
    ({ registration } = await registerPreviewWorker({ container }));
  } catch (error) {
    return {
      ok: false,
      message:
        "The preview worker could not be registered, so requests cannot be forwarded to the " +
        `server on port ${String(options.port)}: ${
          error instanceof Error ? error.message : String(error)
        }`,
    };
  }

  const messages = options.messages ?? messagesOf(container);

  const serve = (path: string, method?: string): Promise<AppPreviewResponse> =>
    serveAppRequest(
      { path, ...(method !== undefined ? { method } : {}) },
      { transport, port: options.port, buildId: options.buildId },
    );

  const forwarder = attachPreviewForwarder({
    container: messages,
    buildId: options.buildId,
    serve,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });

  // Told *after* the page can answer: a worker that starts forwarding before the listener exists
  // would answer every request with its own 504 timeout, which reads as a slow server rather than
  // as a race in this file.
  registration.active?.postMessage({
    type: FORWARD_INSTALL_MESSAGE,
    buildId: options.buildId,
  });

  return {
    ok: true,
    attach: {
      port: options.port,
      buildId: options.buildId,
      url: previewBasePath(options.buildId),
      status,
      note:
        `Attached to port ${String(options.port)} (it answered ${String(status)}) — every request ` +
        "is forwarded to the server you run. No build, and no server of the preview's own.",
      serve,
      async stop() {
        forwarder.dispose();
        // A null session matches no preview URL, so the worker stops forwarding. `clear` is not
        // used here because it would also drop a published build, which a mode switch must not.
        registration.active?.postMessage({
          type: FORWARD_INSTALL_MESSAGE,
          buildId: null,
        });
      },
      answered: () => forwarder.answered(),
      failures: () => forwarder.failures(),
    },
  };
}
