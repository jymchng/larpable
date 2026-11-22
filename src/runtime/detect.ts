/**
 * Which JavaScript runtime the guest will actually use, measured rather than assumed.
 *
 * PRD §7.1 says Bun is preferred *if it works in this Linux environment*, and the
 * feasibility report (`docs/feasibility-report.md`) settled that: `bun --version` and
 * every other Bun entry point die with exit 127 because the aarch64-musl build needs
 * `libstdc++.so.6`, which this guest does not have. So the honest shape of this module
 * is "prefer Bun, probe it, record why it was rejected, use Node" — and the rejection
 * is data (`fallbackReason`) rather than a comment, because the UI has to show it and
 * the agent must not be told to run `bun install` in a guest where that cannot work.
 *
 * Three rules this module keeps:
 *
 * - A probe result is either a parsed version or a failure with the guest's own words.
 *   No probe is inferred from another: `node --version` succeeding says nothing about
 *   `npm`, which ships alongside it but is a separate program.
 * - Selecting Bun requires Bun to answer. `preferBun` means "try first", never "assume".
 * - A probe that ran out of budget says *that*, not "unknown". The first measurement of
 *   this guest gave `npm --version` 12.2 s and 17.2 s across two calls (and `bun`'s first
 *   call installs the binary before it answers), so a budget that looked generous on a
 *   laptop silently produced `packageManagerVersion: null` here. A null version then
 *   reads like "npm has no version" instead of "we did not wait long enough".
 */

import { ExecutionTimeoutError } from "../env/environment-errors";
import type { ExecutionEnvironment } from "../env/execution";

import { BUN_EXCLUSION } from "./bootstrap";

export type GuestRuntime = "node" | "bun";
export type PackageManager = "npm" | "bun";

/** One probe, recorded so the reason for a choice can be shown rather than claimed. */
export interface RuntimeProbe {
  program: GuestRuntime | "npm";
  command: string;
  ok: boolean;
  exitCode: number | null;
  /** The parsed version, or null when the probe failed or answered something else. */
  version: string | null;
  /** The guest's own words on failure, trimmed for a status line. */
  detail: string;
  /** True when the probe was killed for exceeding its budget instead of answering. */
  timedOut: boolean;
}

export interface RuntimeInfo {
  runtime: GuestRuntime;
  /** e.g. `v26.13.1` for Node, `1.3.13` for Bun. Never invented. */
  version: string | null;
  packageManager: PackageManager;
  /** e.g. `11.20.0` for npm; null when npm did not answer. */
  packageManagerVersion: string | null;
  /** Why Bun was not selected, when it was tried. Null when Bun was selected or not tried. */
  fallbackReason: string | null;
  /**
   * Problems that did not stop a runtime from being selected — a `npm` that would not
   * answer, say. Kept separate from `fallbackReason` because the runtime still works and
   * the caller should carry on, while the UI and the agent still need the warning.
   */
  warnings: readonly string[];
  /** Every probe in the order it ran. */
  probes: readonly RuntimeProbe[];
}

export interface DetectRuntimeOptions {
  /** Try Bun first, as PRD §7.1 prefers. Default true; a false here means "do not ask". */
  preferBun?: boolean;
  /** Budget per probe. Default `DEFAULT_PROBE_TIMEOUT_MS` (120 s, measured in the guest). */
  timeoutMs?: number;
}

/** Node answers `v26.13.1`; a shim may prefix it with its own progress lines. The `v`
 * is part of what the guest printed, so it is part of what this module reports: the
 * status bar should read the same as `node --version` in the user's own terminal. */
const NODE_VERSION = /\b(v\d+\.\d+\.\d+)\b/;
/** Bun answers a bare `1.3.13`. */
const BARE_VERSION = /^\s*(\d+\.\d+\.\d+)\s*$/m;

/**
 * How long one probe may take.
 *
 * Not a round number picked on a laptop: measured in this guest, `npm --version` answered
 * in 12.2 s and then 17.2 s, and the first `bun --version` installs Bun through the shim
 * before it prints anything. A 20 s budget killed both of those and reported "version
 * unknown", so the caller could not tell a missing package manager from a slow one.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 120_000;

/** Neither runtime could be run. The message names the probes, not a guess. */
export class RuntimeDetectionError extends Error {
  readonly probes: readonly RuntimeProbe[];

  constructor(message: string, probes: readonly RuntimeProbe[]) {
    super(message);
    this.name = "RuntimeDetectionError";
    this.probes = probes;
  }
}

/** Run one probe. Never throws: a probe failure is a fact, not an exception. */
async function probe(
  environment: ExecutionEnvironment,
  program: RuntimeProbe["program"],
  command: string,
  pattern: RegExp,
  timeoutMs: number,
): Promise<RuntimeProbe> {
  try {
    const result = await environment.execute(command, { timeoutMs });
    const match = pattern.exec(`${result.stdout}\n${result.stderr}`);
    const version = match ? match[1] ?? null : null;
    return {
      program,
      command,
      ok: result.exitCode === 0 && version !== null,
      exitCode: result.exitCode,
      version,
      detail: tail(`${result.stderr}${result.stdout}`),
      timedOut: false,
    };
  } catch (error) {
    return {
      program,
      command,
      ok: false,
      exitCode: null,
      version: null,
      detail: error instanceof Error ? error.message : String(error),
      // A killed probe and a missing binary both look like "no version"; only this flag
      // lets the caller tell the operator to wait rather than to install something.
      timedOut: error instanceof ExecutionTimeoutError,
    };
  }
}

/**
 * Pick the runtime, trying Bun only when asked.
 *
 * ```ts
 * const info = await detectRuntime(environment);
 * info.runtime;            // "node"
 * info.packageManager;     // "npm"
 * info.fallbackReason;     // why Bun was rejected, quoting its own exit code
 * ```
 */
export async function detectRuntime(
  environment: ExecutionEnvironment,
  options: DetectRuntimeOptions = {},
): Promise<RuntimeInfo> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes: RuntimeProbe[] = [];
  const warnings: string[] = [];
  let fallbackReason: string | null = null;

  if (options.preferBun ?? true) {
    const bun = await probe(environment, "bun", "bun --version", BARE_VERSION, timeoutMs);
    probes.push(bun);
    if (bun.ok) {
      return {
        runtime: "bun",
        version: bun.version,
        packageManager: "bun",
        packageManagerVersion: bun.version,
        fallbackReason: null,
        warnings,
        probes,
      };
    }
    // The measured reason, plus what the guest actually did: a report that says "Bun
    // failed" without either is not verifiable later.
    if (bun.timedOut) {
      // The probe was killed, so nothing was learned about Bun itself — only that it did
      // not answer in time. Quoting BUN_EXCLUSION here would blame a `libstdc++.so.6`
      // this run never observed, and tell the operator to give up instead of to wait.
      fallbackReason =
        `\`bun --version\` did not answer within ${String(timeoutMs)} ms (its first call ` +
        `installs Bun), so Bun was not selected. Using Node + npm instead.`;
    } else {
      const outcome = bun.exitCode === null ? "could not run" : `exited ${String(bun.exitCode)}`;
      fallbackReason =
        `${BUN_EXCLUSION.reason} The probe \`bun --version\` ${outcome}` +
        `${bun.detail ? `: ${bun.detail}` : "."} Using Node + npm instead.`;
    }
  }

  const node = await probe(environment, "node", "node --version", NODE_VERSION, timeoutMs);
  probes.push(node);
  if (!node.ok) {
    throw new RuntimeDetectionError(
      `The guest has no usable JavaScript runtime: \`node --version\` ${
        node.timedOut
          ? `did not answer within ${String(timeoutMs)} ms`
          : node.exitCode === null
            ? "could not run"
            : `exited ${String(node.exitCode)}`
      }${node.detail ? ` (${node.detail})` : ""}. Warm the runtime first (RuntimeBootstrap).`,
      probes,
    );
  }

  const npm = await probe(environment, "npm", "npm --version", BARE_VERSION, timeoutMs);
  probes.push(npm);
  if (!npm.ok) {
    // Node answered but npm did not. That is not a runtime, it is a package manager the
    // install step cannot use — so say so instead of letting the caller discover it when
    // `npm install` fails with a timeout of its own.
    warnings.push(
      `\`npm --version\` ${
        npm.timedOut
          ? `did not answer within ${String(timeoutMs)} ms`
          : npm.exitCode === null
            ? "could not run"
            : `exited ${String(npm.exitCode)}`
      }${npm.detail ? ` (${npm.detail})` : ""}: installing dependencies with npm will not work until it does.`,
    );
  }

  return {
    runtime: "node",
    version: node.version,
    packageManager: "npm",
    packageManagerVersion: npm.version,
    fallbackReason,
    warnings,
    probes,
  };
}

export interface InstallCommandOptions {
  /** A lockfile exists, so the reproducible install (`npm ci`) is preferred. */
  ci?: boolean;
}

/** The install command for a package manager, with the flags this product needs. */
export function installCommand(
  packageManager: PackageManager,
  options: InstallCommandOptions = {},
): string {
  // No audit and no funding text: the agent reads this output, and a failed install's
  // logs should contain the failure, not a donation banner.
  return packageManager === "bun"
    ? `bun install${options.ci ? " --frozen-lockfile" : ""}`
    : `npm ${options.ci ? "ci" : "install"} --no-audit --no-fund`;
}

/** The lockfile names worth checking, per package manager. */
export const LOCKFILES: Readonly<Record<PackageManager, readonly string[]>> = {
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  bun: ["bun.lockb", "bun.lock"],
};

/** Where a fresh scaffold's build output goes, per framework (PRD §7.4 default `dist`). */
export const DEFAULT_OUTPUT_DIR = "dist";

/** A sentence for the UI: runtime + version + why Bun is not in play + any warning. */
export function describeRuntime(info: RuntimeInfo): string {
  const version = info.version ? ` ${info.version}` : " (version unknown)";
  const manager = info.packageManagerVersion
    ? `${info.packageManager} ${info.packageManagerVersion}`
    : info.packageManager;
  const fallback = info.fallbackReason ? ` Bun is not used: ${info.fallbackReason}` : "";
  const warnings = info.warnings.length > 0 ? ` ${info.warnings.join(" ")}` : "";
  return `Runtime: ${info.runtime}${version}, ${manager}.${fallback}${warnings}`;
}

/** The last few meaningful lines, so a status line stays readable. */
function tail(text: string, lines = 2): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-lines)
    .join(" | ");
}
