/**
 * The preview session: start the guest's file server, publish a build, answer requests.
 *
 * Everything before this file is a decision about bytes — how a path is routed, what a
 * `Content-Type` is, which bytes a stale build may not receive. This file is the only place
 * that puts those decisions in order for a real guest, and it exists because the ordering is
 * not obvious and had been missing:
 *
 * 1. the guest's `node` must be started against `/workspace/dist` (`guest-server.ts`), which
 *    is a real process in a real VM and can take minutes on a cold runtime;
 * 2. the build must be read out of that server over HTTP (`transport.ts`), not off the
 *    filesystem, so headers and status codes are the server's own;
 * 3. its bytes must be fetched and typed once (`collectPreviewSnapshot` in `proxy.ts`);
 * 4. the service worker must confirm it accepted them (`client.ts`), because a `postMessage`
 *    that no worker heard still "succeeds".
 *
 * A failure at any step is reported as what it is. In particular a browser that refuses
 * service-worker registration does **not** fail the publish: the snapshot is kept and
 * `serve()` answers preview URLs straight from the guest through `proxy.ts`, which is the
 * documented fallback and is slower rather than broken.
 *
 * The session is injected rather than process-wide so both the app and the browser
 * acceptance run drive the same code, and so unit tests can drive it with a stub guest.
 */

import type { ExecutionEnvironment } from "@/env/execution";
import type { GuestHttpFetch } from "@/env/unkernel-kernel";
import {
  browserWorkerContainer,
  publishPreviewSnapshot,
  registerPreviewWorker,
  type PreviewWorkerContainer,
  type PreviewWorkerRegistration,
} from "./client";
import { startPreviewServer, type GuestPreviewServer } from "./guest-server";
import {
  collectPreviewSnapshot,
  servePreviewRequest,
  snapshotBuild,
  type PreviewHttpResult,
  type PreviewSnapshot,
} from "./proxy";
import { previewBasePath } from "./routing";
import { fetchTransport, type PreviewTransport } from "./transport";

export interface StartPreviewSessionOptions {
  /** The booted guest. Writes the server script and runs it. */
  environment: ExecutionEnvironment;
  /**
   * HTTP to the guest's loopback, i.e. `UnkernelEnvironment.guestHttp()`. Required: without
   * it there is no way to reach a port inside the VM, and pretending otherwise would turn a
   * missing capability into a 404.
   */
  http: GuestHttpFetch;
  /** Port the guest's server listens on. Default `DEFAULT_PREVIEW_PORT` (8123). */
  port?: number;
  /** Directory to serve, workspace-relative. Default `dist`. */
  root?: string;
  /** `/index.html` for an SPA build; null when deep links must 404. Default `/index.html`. */
  fallbackPath?: string | null;
  /**
   * The page's service worker container (`navigator.serviceWorker`). Default: whatever this
   * realm has. `null` explicitly means "no worker": publish then keeps the snapshot for
   * `serve()` instead of failing.
   */
  container?: PreviewWorkerContainer | null;
  /** How long to wait for the guest's server to announce its port. Default 120 s. */
  timeoutMs?: number;
}

/** What happened to a built snapshot. Both outcomes leave the preview usable. */
export type PreviewPublishOutcome =
  | { kind: "published"; buildId: string; files: number; waited: boolean }
  | { kind: "proxied"; buildId: string; files: number; reason: string };

export interface PreviewSession {
  /** The guest port the server answered on. */
  readonly port: number;
  /** The guest directory being served, guest-absolute. */
  readonly root: string;
  /** `/__preview__/<current build>/`, or null before the first publish. */
  readonly url: string | null;
  /** The published build's id, or null. */
  readonly buildId: string | null;
  /** Start the server (once) and publish everything under the workspace's publish dir. */
  publish(buildId: string): Promise<PreviewPublishOutcome>;
  /**
   * Answer a preview URL from the last snapshot, through the guest.
   *
   * Returns null for a URL that is not a preview URL, so a caller can chain this in front of
   * the app's own handler without shadowing its routes.
   */
  serve(url: string, method?: string): Promise<PreviewHttpResult | null>;
  /** Stop the guest's server. Idempotent. */
  stop(): Promise<void>;
}

export async function startPreviewSession(
  options: StartPreviewSessionOptions,
): Promise<PreviewSession> {
  const fallbackPath = options.fallbackPath === undefined ? "/index.html" : options.fallbackPath;
  const server: GuestPreviewServer = await startPreviewServer(options.environment, {
    ...(options.root !== undefined ? { root: options.root } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    // The server's own reads (the manifest) go through the guest too, not the host.
    fetch: (url, init) => options.http(url, init),
  });

  const transport: PreviewTransport = fetchTransport(options.http, {
    baseUrl: `http://127.0.0.1:${String(server.port)}`,
  });

  const container =
    options.container === undefined ? browserWorkerContainer() : options.container;
  let registration: PreviewWorkerRegistration | null = null;
  /** True once a cold visit had to wait for the worker to activate. */
  let waitedForWorker = false;
  let snapshot: PreviewSnapshot | null = null;

  async function ensureRegistration(): Promise<PreviewWorkerRegistration | null> {
    if (container === null) return null;
    if (registration !== null) return registration;
    const registered = await registerPreviewWorker({ container });
    registration = registered.registration;
    waitedForWorker = registered.waited;
    return registration;
  }

  return {
    port: server.port,
    root: server.root,
    get url() {
      return snapshot === null ? null : previewBasePath(snapshot.buildId);
    },
    get buildId() {
      return snapshot?.buildId ?? null;
    },

    async publish(buildId) {
      const collected = await collectPreviewSnapshot({
        buildId,
        fallbackPath,
        transport,
      });
      // Kept before publishing, so a browser whose worker refuses the message still has a
      // served preview rather than a blank frame and an exception.
      snapshot = collected;

      if (container === null) {
        return {
          kind: "proxied",
          buildId,
          files: collected.files.length,
          reason:
            "This browser has no service worker, so preview URLs are answered by the guest " +
            "on demand instead of from a published snapshot.",
        };
      }

      try {
        const active = await ensureRegistration();
        if (active === null) throw new Error("the preview worker registration disappeared");
        const reply = await publishPreviewSnapshot({
          container,
          registration: active,
          snapshot: collected,
        });
        return {
          kind: "published",
          buildId,
          files: reply.files,
          // Whether the worker had to install first: in the acceptance run this says whether
          // a cold visit paid the activation cost before the first build could be shown.
          waited: waitedForWorker,
        };
      } catch (error) {
        return {
          kind: "proxied",
          buildId,
          files: collected.files.length,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async serve(url, method = "GET") {
      return servePreviewRequest(
        { url, method },
        { build: snapshot === null ? null : snapshotBuild(snapshot), transport },
      );
    },

    async stop() {
      await server.stop();
    },
  };
}
