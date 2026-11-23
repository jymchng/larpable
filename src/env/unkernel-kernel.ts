/**
 * The slice of unkernel that `UnkernelEnvironment` actually uses.
 *
 * unkernel's real types are excellent but large, and importing them into the adapter
 * would tie every caller (and every test) to a 10 MB WebAssembly package. These are
 * *structural* declarations of the documented surface we rely on — `spawn()` on
 * pipes, `exited`, `stop()`, `createKernel({ mounts, net })` — so that:
 *
 * - the adapter is exercised in unit tests by a fake kernel with no WebAssembly at
 *   all, and
 * - a change in unkernel's API shows up as a type error at the one place that
 *   bridges to it (`browserKernelFactory` below), not scattered through the agent.
 *
 * Every field here was read from `unkernel@0.2.0-261121-e69adda`'s
 * `dist/web.d.mts` / `dist/_chunks/index.d.mts`; nothing is guessed. Two facts worth
 * recording because they shaped this file:
 *
 * - `PtyEnd` has a `lost` variant (the connection dropped without an EXIT), so a guest
 *   program can end with neither an exit code nor a signal.
 * - Browsers have **no** direct network backend: `directBackend()` exists only in
 *   `unkernel/node`. In the browser the guest's traffic goes through a Wisp proxy
 *   (`DEFAULT_WISP_SERVERS` or one you host yourself), and `createKernel` takes that as
 *   the spec `{ kind: "net", backend: { kind: "wisp", servers } }`.
 */

import type { MountsOption } from "unkernel/web";

import { EnvironmentError } from "./environment-errors";
import type { WorkspaceFs } from "./workspace-fs";

/**
 * How a guest program ended, in unkernel's `PtyEnd` vocabulary.
 *
 * `closed` and `lost` both mean "no EXIT frame arrived", so the adapter reports
 * `exitCode: null` and `signal: null` for them instead of inventing a status.
 */
export type KernelEndEvent =
  | { type: "exit"; code: number }
  | { type: "signal"; signal: number }
  | { type: "closed" }
  | { type: "lost" };

/** A guest program on pipes: `spawn(file, args, { pty: false })`. */
export interface KernelProcessLike {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly ended: Promise<KernelEndEvent>;
  /** SIGTERM by default; the adapter sends SIGKILL. */
  kill(signal?: string): void;
  close(): Promise<void>;
}

export interface KernelSpawnOptions {
  /** The program's working directory in the guest. Default the guest user's home. */
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * An interactive session: `spawn(file, args, { pty: true })`.
 *
 * Read from unkernel's `Pty` interface. `output` is a pull stream, so a reader must
 * keep reading or the guest program blocks once the window is full; `ended` settles
 * only after `output` has been read to its end, which is why the UI reads both.
 */
export interface KernelPtyLike {
  readonly pid: number;
  readonly output: ReadableStream<Uint8Array>;
  readonly ended: Promise<KernelEndEvent>;
  /** Type into the pty. Strings are UTF-8, split into 4096-byte DATA frames. */
  write(data: Uint8Array | string): Promise<void>;
  /** Set the window size; the foreground process gets SIGWINCH. */
  resize(cols: number, rows: number): void;
  /** Signal the program; SIGHUP by default. */
  kill(signal?: string): void;
  /** Hang up the session (SIGHUP); resolves once the connection is gone. */
  close(): Promise<void>;
}

export interface KernelPtyOptions extends KernelSpawnOptions {
  pty?: true;
  cols?: number;
  rows?: number;
  /** `TERM` for the guest program. Default `xterm-256color`. */
  term?: string;
  /** Guest user to run as. Default the image's user (uid 1000). */
  user?: string | number;
}

/**
 * HTTP/1.1 to a server on the guest's loopback.
 *
 * unkernel provides this as `kernel.fetch()` (`fetchOver()` over `connect()`): the URL's
 * port picks the guest port, the host only goes into the `Host` header. It is the *only*
 * way the host can reach a port inside the machine, which is why the preview's transport is
 * built on it and why the environment — not the agent — owns it.
 *
 * Declared structurally, with a narrower `init` than the DOM's `RequestInit`, so callers
 * (and tests) do not depend on unkernel's types and a fake kernel satisfies it.
 */
export type GuestHttpFetch = (
  input: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<Response>;

/** A booted kernel: only the parts the adapter calls. */
export interface KernelLike {
  spawn(
    file: string,
    args: readonly string[] | undefined,
    opts: KernelSpawnOptions & { pty: false },
  ): Promise<KernelProcessLike>;
  /** The same `spawn()`, on a pty instead of pipes: an interactive session. */
  spawn(
    file: string,
    args: readonly string[] | undefined,
    opts: KernelPtyOptions,
  ): Promise<KernelPtyLike>;
  /** Settles when the guest halts, panics, traps or is stopped. */
  readonly exited: Promise<unknown>;
  /** Stop the kernel now, without a clean shutdown. */
  stop?(opts?: { code?: number; reason?: string }): Promise<unknown>;
  /** Memory the instance actually allocated, in MiB (a measurement, not a request). */
  readonly memoryMiB?: number;
  /**
   * HTTP/1.1 to a server on the guest's loopback. Optional because a test double need not
   * speak HTTP: `UnkernelEnvironment.guestHttp()` reports the absence instead of guessing.
   */
  fetch?(input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Where the guest's network frames go.
 *
 * `"wisp"` is the only backend a browser has (a Wisp proxy answers the guest's TCP and
 * UDP). `"direct"` exists on Node only, so the browser factory rejects it by name
 * instead of silently booting a guest with no network.
 */
export type KernelNetwork = "wisp" | "direct" | "none";

export interface KernelBootRequest {
  /** Image to boot: a URL in the browser, a path or file: URL on Node. */
  distro: string;
  memoryMiB?: number;
  cpus?: number;
  /**
   * Guest mount points. Opaque here on purpose: the adapter hands over the real
   * `MemoryFs` (mounted over 9p), while tests inject anything they like.
   */
  mounts: Record<string, unknown>;
  network: KernelNetwork;
  /**
   * Wisp proxies to try, in order; the backend connects to all of them and the first
   * to answer carries the guest's traffic (unkernel's own failover). Empty uses
   * unkernel's default list — a proxy that accepts only known origins, so a page
   * hosted elsewhere must pass its own.
   */
  wispServers?: string[];
  /** One proxy, for callers with a single URL. Merged into `wispServers`. */
  wispServer?: string;
  /**
   * Run the kernel in a Web Worker. Browsers need this for SMP (a CPU blocks while it
   * waits for another, which a page's main thread may not) and it is what keeps a
   * 30-second build from freezing the UI.
   */
  worker?: boolean;
  /**
   * Attach the persistent IndexedDB data disk (label `kwdata`). The guest's root is an
   * overlay: the read-only distro image below, writes above, on this disk. Browser
   * only — in worker mode the disk is built from a spec, which is the same
   * `openDataDisk`/`IdbStore` machinery running inside the worker.
   */
  persistentDataDisk?: boolean;
  onProgress?: (stage: string) => void;
}

/** Boots a kernel. Injected so tests (and Node) never touch the browser entry. */
export type KernelFactory = (request: KernelBootRequest) => Promise<KernelLike>;

/**
 * Boot unkernel in the browser.
 *
 * `checkSupport()` is asked first, because the failure it prevents — a browser without
 * JSPI hanging inside `createKernel` — is exactly the "fails silently" case PRD §5.3
 * forbids. The report's `problems` are carried into the error so the UI can explain
 * what the browser is missing instead of showing a spinner forever.
 */
export const browserKernelFactory: KernelFactory = async (request) => {
  if (request.network === "direct") {
    throw new EnvironmentError(
      "boot",
      'The browser has no "direct" network backend: unkernel only ships it for Node. ' +
        'Use "wisp" (a Wisp proxy) or "none".',
    );
  }

  const unkernel = await import("unkernel/web");

  const support = await unkernel.checkSupport();
  if (!support.ok) {
    throw new EnvironmentError(
      "boot",
      `This browser cannot boot Linux: ${support.problems.join("; ") || "unsupported engine"}. ` +
        "WebAssembly JSPI and cross-origin isolation are required.",
    );
  }

  // `servers` is `string | string[]` in NetSpec, so the list is copied rather than
  // passed by reference. The default is unkernel's, which accepts only known origins.
  const configured = request.wispServers ?? (request.wispServer ? [request.wispServer] : []);
  const servers =
    configured.length > 0 ? [...configured] : [...unkernel.DEFAULT_WISP_SERVERS];

  const base = {
    distro: request.distro,
    // The adapter owns the real MemoryFs; the cast is the single place where the
    // structural contract meets unkernel's `FsSource`.
    mounts: request.mounts as unknown as MountsOption,
    ...(request.memoryMiB ? { memoryMiB: request.memoryMiB } : {}),
    ...(request.cpus ? { cpus: request.cpus } : {}),
    ...(request.onProgress
      ? { onProgress: (progress: { stage: string }) => request.onProgress?.(progress.stage) }
      : {}),
    ...(request.network === "none"
      ? {}
      : { net: { kind: "net" as const, backend: { kind: "wisp" as const, servers } } }),
    // In worker mode the disk has to be a spec the worker can build, which is why the
    // persistent disk appears here as data rather than as an `openDataDisk()` result.
    ...(request.persistentDataDisk
      ? {
          disks: [
            { kind: "data" as const, template: "bundled" as const, mode: "persistent" as const },
          ],
        }
      : {}),
  };

  // `worker: true` selects unkernel's WorkerKernel overload. The cast is the same
  // deliberate bridge as `mounts`: our structural `KernelLike` describes the methods
  // the adapter calls, and both kernel shapes satisfy it.
  const kernel = request.worker
    ? await unkernel.createKernel({ ...base, worker: true })
    : await unkernel.createKernel(base);

  return kernel as unknown as KernelLike;
};

/** unkernel's `MemoryFs`, loaded lazily so Node-side tests never pull in the bundle. */
export async function createMemoryWorkspace(
  tree: Record<string, string> = {},
): Promise<WorkspaceFs> {
  const { MemoryFs } = await import("unkernel/web");
  return new MemoryFs(tree);
}
