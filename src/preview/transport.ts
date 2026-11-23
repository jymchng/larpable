/**
 * The one wire between the host and the guest's preview server.
 *
 * The guest serves `/workspace/dist` over HTTP on its own loopback (`guest-server.ts`).
 * Nothing on the host can read that socket directly: it only exists inside the machine.
 * unkernel exposes exactly one way in — `kernel.fetch()`, which speaks HTTP/1.1 over a
 * guest TCP connection — and this module is the only place in Larpable that knows it.
 *
 * Two consequences, both deliberate:
 *
 * - the preview never reads the build through `readFile` on the way out. It goes through
 *   HTTP, so a status code, a `Content-Type` the server chose and a 404 are all real
 *   rather than reconstructed by the host;
 * - the rest of the preview (`proxy.ts`, `client.ts`, the iframe) codes against
 *   `PreviewTransport`, so the routing rules can be tested with a transport that answers
 *   from a table, and a failure can be simulated without a kernel.
 */

/** A response as the preview needs it: status, headers and bytes, nothing DOM. */
export interface PreviewHttpResponse {
  status: number;
  /** Lower-cased header names, so a caller never has to guess the server's case. */
  headers: Record<string, string>;
  body: Uint8Array;
}

/** How the preview reaches the guest's server. Injected, so tests need no kernel. */
export interface PreviewTransport {
  /** `path` starts with `/` and is resolved against the transport's own base URL. */
  fetch(
    path: string,
    options?: { method?: string; signal?: AbortSignal },
  ): Promise<PreviewHttpResponse>;
}

/** The slice of the unkernel kernel this module needs. Structural, so no vendor type leaks. */
export interface GuestKernelFetch {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface KernelTransportOptions {
  /** The port the guest's preview server listens on. */
  port: number;
  /** Host as the *guest* sees it: its own loopback. Only changed by a test. */
  host?: string;
  /**
   * Per-request budget. The guest's Node is local, so a request that takes seconds means
   * something is wrong; a hung preview must not hang the iframe forever.
   */
  timeoutMs?: number;
}

/**
 * A transport that talks to the guest's preview server through `kernel.fetch()`.
 *
 * The timeout is enforced with an `AbortSignal` rather than by racing a promise: a race
 * would leave the guest connection open, and the guest's server would keep a socket per
 * abandoned request until the VM stopped.
 */
export function kernelPreviewTransport(
  kernel: GuestKernelFetch,
  options: KernelTransportOptions,
): PreviewTransport {
  const base = `http://${options.host ?? "127.0.0.1"}:${String(options.port)}`;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async fetch(path, requestOptions = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      // A caller's own signal must also cancel the guest connection.
      const onAbort = () => controller.abort();
      requestOptions.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await kernel.fetch(`${base}${path}`, {
          method: requestOptions.method ?? "GET",
          signal: controller.signal,
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        // forEach rather than iteration: the Node library set has no DOM.Iterable.
        response.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        return { status: response.status, headers, body: bytes };
      } catch (error) {
        // `AbortError` here is our own timeout; anything else is the guest's. Both are
        // reported as one failure by the caller, but the message says which.
        const reason =
          error instanceof Error
            ? controller.signal.aborted
              ? `no answer within ${String(timeoutMs)} ms`
              : error.message
            : String(error);
        throw new PreviewTransportError(`${path}: ${reason}`);
      } finally {
        clearTimeout(timer);
        requestOptions.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** The guest could not be reached. Distinct from "the guest answered 404". */
export class PreviewTransportError extends Error {
  override readonly name = "PreviewTransportError";
}

/**
 * The same transport over any `fetch`-shaped function and an explicit base URL.
 *
 * Used by the gated test and the browser harness, where the kernel is real but the port
 * is decided at runtime, and by tests that answer from a table. It keeps the timeout,
 * the abort handling and the lower-cased headers of the kernel transport, so what the
 * tests exercise is the code the browser runs.
 */
export function fetchTransport(
  implementation: (url: string, init?: RequestInit) => Promise<Response>,
  options: { baseUrl: string; timeoutMs?: number },
): PreviewTransport {
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async fetch(path, requestOptions = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      requestOptions.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await implementation(`${base}${path}`, {
          method: requestOptions.method ?? "GET",
          signal: controller.signal,
        });
        const bytes = new Uint8Array(await response.arrayBuffer());
        const headers: Record<string, string> = {};
        // forEach rather than iteration: the Node library set has no DOM.Iterable.
        response.headers.forEach((value, name) => {
          headers[name.toLowerCase()] = value;
        });
        return { status: response.status, headers, body: bytes };
      } catch (error) {
        const reason =
          error instanceof Error
            ? controller.signal.aborted
              ? `no answer within ${String(timeoutMs)} ms`
              : error.message
            : String(error);
        throw new PreviewTransportError(`${path}: ${reason}`);
      } finally {
        clearTimeout(timer);
        requestOptions.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
