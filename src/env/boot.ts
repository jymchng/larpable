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
 * - the Alpine image served from this origin (`/distros/alpine.erofs`),
 * - 1 GiB of guest memory and 2 CPUs, each CPU in its own worker,
 * - the kernel in a Web Worker, so a build never freezes the page,
 * - the guest's network through a Wisp proxy (browsers have no raw sockets),
 * - a persistent IndexedDB data disk, so the guest's root overlay survives a reload.
 *
 * Every one of those is overridable at boot and most are overridable per deployment
 * with the `VITE_*` variables below.
 */

import { DEFAULT_PROJECT_TREE, DEFAULT_WORKSPACE_PATH } from "./default-project";
import type { KernelNetwork } from "./unkernel-kernel";
import { browserKernelFactory, createMemoryWorkspace } from "./unkernel-kernel";
import { UnkernelEnvironment } from "./unkernel-environment";
import type { WorkspaceFs } from "./workspace-fs";

/** The image `bun run fetch:distros` places in `public/distros/`. */
export const DEFAULT_DISTRO_URL = "/distros/alpine.erofs";
export const DEFAULT_MEMORY_MIB = 1024;
export const DEFAULT_CPUS = 2;
/**
 * Install and build commands get this budget by default. PRD §15 makes it
 * configurable; 10 minutes is enough for a cold `npm install` in the guest and short
 * enough that a hung command does not hang the session.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;

export interface BrowserEnvironmentConfig {
  distroUrl: string;
  workspacePath: string;
  memoryMiB: number;
  cpus: number;
  /** `"wisp"` routes the guest's TCP/UDP through a Wisp proxy; `"none"` boots offline. */
  network: KernelNetwork;
  /** A self-hosted Wisp proxy; `null` uses unkernel's default list. */
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

/**
 * Turn overrides and a deployment's `VITE_*` variables into one config.
 *
 * Explicit overrides win over the environment, which wins over the defaults, so a
 * test (or a future settings screen) can pin a value without editing a `.env` file.
 */
export function resolveBrowserEnvironmentConfig(
  overrides: BrowserEnvironmentOptions = {},
  env: EnvRecord = (import.meta as ImportMeta & { env?: EnvRecord }).env ?? {},
): BrowserEnvironmentConfig {
  const network: KernelNetwork =
    overrides.network ?? (booleanFrom(env.VITE_LINUX_NETWORK, true) ? "wisp" : "none");

  return {
    distroUrl: overrides.distroUrl ?? stringFrom(env.VITE_DISTRO_URL) ?? DEFAULT_DISTRO_URL,
    workspacePath: overrides.workspacePath ?? DEFAULT_WORKSPACE_PATH,
    memoryMiB: overrides.memoryMiB ?? numberFrom(env.VITE_LINUX_MEMORY_MIB, DEFAULT_MEMORY_MIB, 128, 4096),
    cpus: overrides.cpus ?? numberFrom(env.VITE_LINUX_CPUS, DEFAULT_CPUS, 1, 4),
    network,
    wispServer: overrides.wispServer ?? stringFrom(env.VITE_WISP_SERVER),
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
    ...(config.wispServer ? { wispServer: config.wispServer } : {}),
    worker: config.worker,
    persistentDataDisk: config.persistentDataDisk,
    commandTimeoutMs: config.commandTimeoutMs,
    kernelFactory: browserKernelFactory,
  });
}
