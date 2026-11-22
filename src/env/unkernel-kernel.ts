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

/** A booted kernel: only the parts the adapter calls. */
export interface KernelLike {
  spawn(
    file: string,
    args: readonly string[] | undefined,
    opts: KernelSpawnOptions & { pty: false },
  ): Promise<KernelProcessLike>;
  /** Settles when the guest halts, panics, traps or is stopped. */
  readonly exited: Promise<unknown>;
  /** Stop the kernel now, without a clean shutdown. */
  stop?(opts?: { code?: number; reason?: string }): Promise<unknown>;
  /** Memory the instance actually allocated, in MiB (a measurement, not a request). */
  readonly memoryMiB?: number;
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
  /** A self-hosted Wisp proxy, when `network` is `"wisp"`. Default: unkernel's list. */
  wispServer?: string;
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

  // `servers` is `string | string[]` in NetSpec, so the readonly default list is
  // copied rather than passed by reference.
  const servers = request.wispServer ?? [...unkernel.DEFAULT_WISP_SERVERS];

  const options = {
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
  };

  return unkernel.createKernel(options);
};

/** unkernel's `MemoryFs`, loaded lazily so Node-side tests never pull in the bundle. */
export async function createMemoryWorkspace(
  tree: Record<string, string> = {},
): Promise<WorkspaceFs> {
  const { MemoryFs } = await import("unkernel/web");
  return new MemoryFs(tree);
}
