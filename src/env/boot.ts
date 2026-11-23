/**
 * Wiring the real Linux guest into the app: *which* image, how much memory, how many
 * CPUs, where the network frames go, whether the kernel runs in a worker and whether a
 * persistent data disk is attached.
 *
 * This is the one place that turns browser facts (origin, saved settings, a `VITE_*`
 * variable) into an `ExecutionEnvironment`. The UI calls `createBrowserEnvironment()`
 * and then only sees the PRD §5.2 contract — no unkernel types, no boot options.
 *
 * The defaults are the ones the acceptance run actually uses, so "it works in the app"
 * and "it works in the browser test" cannot drift apart:
 *
 * - the Debian image served from this origin (`/distros/debian.erofs`),
 * - 1 GiB of guest memory and 2 CPUs, each CPU in its own worker,
 * - the kernel in a Web Worker, so a build never freezes the page,
 * - the guest's network through a Wisp proxy (browsers have no raw sockets),
 * - a persistent IndexedDB data disk, so the guest's root overlay survives a reload.
 *
 * Every one of those is overridable at boot and most are overridable per deployment
 * with the `VITE_*` variables below.
 */

import { DEFAULT_PROJECT_TREE, DEFAULT_WORKSPACE_PATH } from "./default-project";
import { DEFAULT_DISTRO_NAME } from "./distro";
import type { KernelNetwork } from "./unkernel-kernel";
import { browserKernelFactory, createMemoryWorkspace } from "./unkernel-kernel";
import { UnkernelEnvironment } from "./unkernel-environment";
import type { WorkspaceFs } from "./workspace-fs";

/** The image `bun run fetch:distros` places in `public/distros/`. */
export const DEFAULT_DISTRO_URL = `/distros/${DEFAULT_DISTRO_NAME}.erofs`;
export const DEFAULT_MEMORY_MIB = 1024;
export const DEFAULT_CPUS = 2;
/**
 * Install and build commands get this budget by default. PRD §15 makes it
 * configurable; 10 minutes is enough for a cold `npm install` in the guest and short
 * enough that a hung command does not hang the session.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

/**
 * The Wisp proxy a deployment uses when nothing else says otherwise.
 *
 * Why this is a Larpable default and not unkernel's: unkernel ships exactly one default,
 * `wss://wisp.pi0.io:6680/`, and that server **rejects pages on other origins** — measured
 * from `https://larpable.netlify.app` as a bare WebSocket `error` on the handshake, while
 * it opens for `http://localhost:5173`. A guest booted behind it has no network at all, so
 * every `curl` reports `(7) Failed to connect` and `npm install` cannot reach a registry.
 *
 * `wss://wisp.mercurywork.shop/` completes the handshake from the Netlify origin, and the
 * end-to-end proof is real traffic in the deployed guest: `curl https://example.com` →
 * `HTTP=200 time=5.802675s`, exit 0 (measured 2026-11-23, `scripts/probe-curl-deployed.ts`).
 * Both the proxy URL and the reason are one constant because they must change together if
 * that host ever stops answering.
 */
export const DEFAULT_WISP_SERVERS: readonly string[] = ["wss://wisp.mercurywork.shop/"];

export interface BrowserEnvironmentConfig {
  distroUrl: string;
  workspacePath: string;
  memoryMiB: number;
  cpus: number;
  /** `"wisp"` routes the guest's TCP/UDP through a Wisp proxy; `"none"` boots offline. */
  network: KernelNetwork;
  /**
   * Every Wisp proxy to try, in order. Defaults to `DEFAULT_WISP_SERVERS` — a proxy that
   * accepts this deployment's origin, because unkernel's built-in default does not.
   * Override with `?wisp=wss://…` (one URL, editable in the address bar) or
   * `VITE_WISP_SERVERS` (a comma-separated list) to point at a self-hosted proxy.
   */
  wispServers: string[];
  /** The first configured proxy, for a single-proxy display. */
  wispServer: string | null;
  /** Run the kernel in a Web Worker. Requires cross-origin isolation for SMP. */
  worker: boolean;
  /** Attach the persistent IndexedDB data disk (the root overlay's writable layer). */
  persistentDataDisk: boolean;
  commandTimeoutMs: number;
}

export interface BrowserEnvironmentOptions extends Partial<BrowserEnvironmentConfig> {
  /** Initial workspace files. Default: the starter site. */
  projectTree?: Readonly<Record<string, string>>;
  /** Inject a file system (tests, and the fake agent). Default: a `MemoryFs`. */
  workspaceFs?: WorkspaceFs;
}

type EnvRecord = Readonly<Record<string, string | boolean | undefined>>;

function stringFrom(value: string | boolean | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `"0"`, `"false"` and `"no"` are the only ways to say no; anything else is yes. */
function booleanFrom(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  const text = stringFrom(value)?.toLowerCase();
  if (text === undefined || text === null) return fallback;
  return !(text === "0" || text === "false" || text === "no" || text === "off");
}

function numberFrom(
  value: string | boolean | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const text = stringFrom(value);
  if (text === null) return fallback;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Split a comma/space separated proxy list, dropping empties. */
function serverList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The Wisp proxies to try, most specific first: an explicit option, then `?wisp=` (the
 * convention unkernel's own page uses, so a deployment can be unblocked by editing the
 * URL), then `VITE_WISP_SERVERS` (a list), then `VITE_WISP_SERVER` (one), and finally
 * `DEFAULT_WISP_SERVERS`.
 *
 * The last step is the one that matters for a deployment: returning an empty list would
 * hand the choice back to unkernel, whose default server refuses unknown origins, and the
 * guest would boot with no network while looking perfectly healthy.
 */
function resolveWispServers(
  overrides: BrowserEnvironmentOptions,
  env: EnvRecord,
  search: string,
): string[] {
  if (overrides.wispServers && overrides.wispServers.length > 0) return [...overrides.wispServers];
  if (overrides.wispServer) return serverList(overrides.wispServer);

  const fromQuery = new URLSearchParams(search).get("wisp");
  if (fromQuery) return serverList(fromQuery);

  const fromList = serverList(stringFrom(env.VITE_WISP_SERVERS));
  if (fromList.length > 0) return fromList;

  const fromSingle = serverList(stringFrom(env.VITE_WISP_SERVER));
  if (fromSingle.length > 0) return fromSingle;

  return [...DEFAULT_WISP_SERVERS];
}

/**
 * Turn overrides and a deployment's `VITE_*` variables into one config.
 *
 * Explicit overrides win over the environment, which wins over the defaults, so a
 * test (or a future settings screen) can pin a value without editing a `.env` file.
 */
export function resolveBrowserEnvironmentConfig(
  overrides: BrowserEnvironmentOptions = {},
  env: EnvRecord = (import.meta as ImportMeta & { env?: EnvRecord }).env ?? {},
  search: string = typeof globalThis.location === "object" ? globalThis.location.search : "",
): BrowserEnvironmentConfig {
  const network: KernelNetwork =
    overrides.network ?? (booleanFrom(env.VITE_LINUX_NETWORK, true) ? "wisp" : "none");
  const wispServers = resolveWispServers(overrides, env, search);

  return {
    distroUrl: overrides.distroUrl ?? stringFrom(env.VITE_DISTRO_URL) ?? DEFAULT_DISTRO_URL,
    workspacePath: overrides.workspacePath ?? DEFAULT_WORKSPACE_PATH,
    memoryMiB: overrides.memoryMiB ?? numberFrom(env.VITE_LINUX_MEMORY_MIB, DEFAULT_MEMORY_MIB, 128, 4096),
    cpus: overrides.cpus ?? numberFrom(env.VITE_LINUX_CPUS, DEFAULT_CPUS, 1, 4),
    network,
    wispServers,
    wispServer: wispServers[0] ?? null,
    worker: overrides.worker ?? booleanFrom(env.VITE_LINUX_WORKER, true),
    persistentDataDisk:
      overrides.persistentDataDisk ?? booleanFrom(env.VITE_LINUX_DATA_DISK, true),
    commandTimeoutMs:
      overrides.commandTimeoutMs ??
      numberFrom(env.VITE_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS, 5_000, 3_600_000),
  };
}

/**
 * Build the browser's `ExecutionEnvironment`.
 *
 * `initialize()` is *not* called here: the UI wants to show `initializing`/`booting`
 * and a live stage, and a caller may want to construct an environment while the
 * browser is unsupported. Boot is the caller's explicit step.
 */
export async function createBrowserEnvironment(
  options: BrowserEnvironmentOptions = {},
): Promise<UnkernelEnvironment> {
  const config = resolveBrowserEnvironmentConfig(options);
  const workspaceFs =
    options.workspaceFs ??
    (await createMemoryWorkspace({ ...(options.projectTree ?? DEFAULT_PROJECT_TREE) }));

  return new UnkernelEnvironment({
    distro: config.distroUrl,
    workspacePath: config.workspacePath,
    workspaceFs,
    memoryMiB: config.memoryMiB,
    cpus: config.cpus,
    network: config.network,
    ...(config.wispServers.length > 0 ? { wispServers: config.wispServers } : {}),
    worker: config.worker,
    persistentDataDisk: config.persistentDataDisk,
    commandTimeoutMs: config.commandTimeoutMs,
    kernelFactory: browserKernelFactory,
  });
}
