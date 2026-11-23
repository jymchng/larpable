/**
 * The guest's JavaScript runtime, paid for once and then never again in a session.
 *
 * What the measured feasibility run (`docs/feasibility-report.md`) says, and why this
 * class exists at all:
 *
 * - The Alpine image ships **no** working Node. `node` is a first-use *shim*
 *   (`/usr/lib/kw/bin/node`) that downloads Node 26.13.1 (linux-arm64-musl) into
 *   `~/.local` the first time it is called. That took **146.7 s** on the machine that
 *   wrote the report.
 * - The shim's first call **can exit 127** before it has finished preparing itself
 *   ("node: needs libgcc_s.so.1, and installing it failed"). The report shows attempt 1
 *   at exit 127 and attempt 2 at exit 0 with `v26.13.1` / `11.20.0`. So the retry is not
 *   defensive superstition; it is the documented behaviour of the thing we call.
 * - `apk` is not a way out. The shim's own advice (`sudo apk add libgcc`) does not work
 *   in this guest, so nothing here may plan around a package manager.
 * - Bun cannot run in this guest at all: `bun-linux-aarch64-musl` dies with exit 127
 *   because `libstdc++.so.6` is missing and the C++ symbol relocations fail. Node + npm
 *   + Vite/esbuild is the only supported path, and that is recorded here rather than
 *   rediscovered per build.
 *
 * Two guarantees this class is responsible for:
 *
 * 1. **Ordering.** Nothing expensive (an `npm install`, a `vite build`) may run before
 *    the runtime is warm, because the first `node` call *is* the download: a build that
 *    hits the shim cold loses 147 s and may fail with exit 127. Callers therefore go
 *    through `exec()`, which waits for `ensureReady()` and refuses the commands that
 *    cannot work (`apk`, `bun`) with the measured reason instead of a mystery timeout.
 * 2. **Honesty.** `snapshot()` reports what happened — attempts, versions, whether a
 *    download occurred, how long it took, and whether the cache is on the persisted data
 *    disk or will be lost with the page. A failed warm-up leaves `state: "failed"` with
 *    the guest's own output attached; it never reports `ready` on a guess.
 *
 * The cache question is decided, not hoped for: `~/.local` lives on the guest's home
 * directory, and the distro keeps its root changes in `/data/distros/<name>/` on the
 * persisted data disk, so a warm runtime survives a reload and the next boot finds it.
 * When no data disk is attached the same install is thrown away with the page, which
 * this class says out loud in `snapshot().warnings` rather than pretending the second
 * boot will be fast.
 */

import type { ExecutionEnvironment, ExecutionOptions, ExecutionResult, OutputChunk } from "../env/execution";
import { ExecutionCancelledError, ExecutionTimeoutError } from "../env/environment-errors";

export type RuntimeBootstrapState = "idle" | "checking" | "warming" | "ready" | "failed";

/** Can the guest reach the internet at all? */
export type GuestNetworkState = "online" | "offline" | "unknown";

/** One call to the guest's runtime shim, recorded so the UI can show what happened. */
export interface RuntimeAttempt {
  /** 1-based, so "attempt 2" reads the same here and in the feasibility report. */
  index: number;
  command: string;
  exitCode: number | null;
  durationMs: number;
  /** The shim downloaded (or linked) a runtime during this attempt. */
  installed: boolean;
  stdout: string;
  stderr: string;
  /** Set when the attempt failed below the exit code (timeout, cancellation). */
  error: string | null;
}

export interface RuntimeSnapshot {
  state: RuntimeBootstrapState;
  /** e.g. `v26.13.1`, or null before a successful warm-up. */
  nodeVersion: string | null;
  /** e.g. `11.20.0`, or null. npm ships with the guest runtime. */
  npmVersion: string | null;
  /** Guest directory the runtime is installed in (`~/.local` by default). */
  cacheDir: string;
  /**
   * `persisted` when `cacheDir` rides the persistent data disk (the install is paid
   * once per project, not once per page); `session-only` when it does not; `unknown`
   * when the caller did not say.
   */
  cache: "persisted" | "session-only" | "unknown";
  /** The runtime was found already installed: no download in this boot. */
  reused: boolean;
  /** A download actually happened in this boot (from the shim's own output). */
  downloaded: boolean;
  /**
   * What the last network check said. `unknown` means the probe was never needed (a warm
   * cache) or could not run — never a guess either way.
   */
  network: GuestNetworkState;
  attempts: readonly RuntimeAttempt[];
  durationMs: number;
  /** Everything the person should know, in order, without contradicting the facts. */
  warnings: readonly string[];
  /** The last failure, verbatim, or null. */
  error: string | null;
}

export interface RuntimeBootstrapOptions {
  environment: ExecutionEnvironment;
  /** The guest user's home. Default `/home/user`. */
  homeDir?: string;
  /**
   * Where the shim installs Node. Default `<homeDir>/.local`, which is what the guest's
   * shim uses and what the persistent data disk carries across boots.
   */
  cacheDir?: string;
  /**
   * The command that forces the shim to bootstrap. Default
   * `node --version && npm --version`: it proves both programs, and it is exactly the
   * probe the feasibility run measured.
   */
  warmupCommand?: string;
  /**
   * Whether a persistent data disk is attached to the guest, which decides whether the
   * install survives a reload. The UI knows this from its boot config.
   */
  persistentDataDisk?: boolean;
  /** Budget for a cold warm-up. Default 300 s (the download measured 146.7 s). */
  warmupTimeoutMs?: number;
  /** Budget for a warm warm-up, i.e. when the cache probe already found Node. Default 30 s. */
  cachedTimeoutMs?: number;
  /** Budget for the cache probe. Default 20 s. */
  probeTimeoutMs?: number;
  /**
   * A network answer the caller already has (the boot config knows whether the guest was
   * given `wisp` or `none`). Seeding `offline` makes a cold warm-up fail at once with
   * {@link OFFLINE_MESSAGE} instead of spending 147 s discovering it.
   */
  network?: GuestNetworkState;
  /** The probe that answers online/offline. Default {@link DEFAULT_NETWORK_PROBE}. */
  networkCommand?: string;
  /** Budget for that probe. Default 20 s. */
  networkTimeoutMs?: number;
  /** Attempts including the first. Default 2: the shim's 127 is worth one retry. */
  maxAttempts?: number;
  /** Pause between attempts. Default 1 s; tests pass 0. */
  retryDelayMs?: number;
  /** Injectable clock and sleep, so tests measure decisions rather than wall time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Why `apk` is not part of any plan here. Shown verbatim to a caller that tries. */
export const APK_RESTRICTION =
  "No package manager can install anything in this guest: it runs as an unprivileged " +
  "user, so `apk` (Alpine) and `apt` (Debian) both refuse. Nothing may depend on one: the " +
  "runtime has to come from the image's own first-use shim (see docs/feasibility-report.md).";

/**
 * Why Bun is excluded, with the measurement rather than an opinion.
 *
 * Kept as data so a test can assert it and the docs can quote it, and so a future guest
 * image that fixes the C++ runtime has one place to change.
 */
export const BUN_EXCLUSION = {
  runtime: "bun",
  target: "bun-linux-aarch64-musl",
  exitCode: 127,
  reason:
    "bun was measured unusable on the Alpine image: the aarch64-musl build fails with exit " +
    "127 because libstdc++.so.6 is missing and its C++ symbol relocations fail.",
  measuredMs: 52_210,
} as const;

/** The runtime path the product actually supports, in one place. */
export const SUPPORTED_RUNTIME = {
  runtime: "node",
  packageManager: "npm",
  bundler: "vite/esbuild",
  bun: false,
} as const;

/** A failure of the runtime bootstrap itself, not of the program it ran. */
export class RuntimeBootstrapError extends Error {
  readonly code: "warm-up-failed" | "unsupported-command" | "not-ready";
  /** The attempts made before giving up, for the UI and the logs. */
  readonly attempts: readonly RuntimeAttempt[];

  constructor(
    code: RuntimeBootstrapError["code"],
    message: string,
    attempts: readonly RuntimeAttempt[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RuntimeBootstrapError";
    this.code = code;
    this.attempts = attempts;
  }
}

const DEFAULT_HOME = "/home/user";
const DEFAULT_WARMUP = "node --version && npm --version";
/**
 * The offline check. `wget` is busybox's, which is in the image before anything is
 * downloaded — the point is to test the *network*, not a package manager.
 */
const DEFAULT_NETWORK_PROBE = "wget -q -O /dev/null http://example.com/ && echo ONLINE || echo OFFLINE";

/** The one sentence a person needs when the guest has no network. */
export const OFFLINE_MESSAGE =
  "The guest has no internet, so nothing can be downloaded (this is why `curl`, `apk` " +
  "and the Node shim fail). A browser has no raw sockets: the guest's traffic goes " +
  "through a Wisp proxy, and unkernel's default proxy accepts only known origins. " +
  "Point this page at a proxy that accepts it — `?wisp=wss://your-proxy/` for one " +
  "session, or `VITE_WISP_SERVERS=wss://a/,wss://b/` at build time.";

/** Commands that cannot work in this guest, with the measured reason to say instead. */
const REFUSED: ReadonlyArray<{ token: string; message: string }> = [
  { token: "apk", message: APK_RESTRICTION },
  { token: "bun", message: `${BUN_EXCLUSION.reason} Use ${SUPPORTED_RUNTIME.runtime} + npm instead.` },
  { token: "bunx", message: `${BUN_EXCLUSION.reason} Use npx instead.` },
];

/** The `node` version the guest reports, e.g. `v26.13.1`. */
const NODE_VERSION = /\bv(\d+\.\d+\.\d+)\b/;
/** A bare semver on its own line, which is how `npm --version` answers. */
const BARE_VERSION = /^\s*(\d+\.\d+\.\d+)\s*$/m;
/** The shim's own progress messages, which say whether a download happened. */
const INSTALL_MARKER = /installing node|installed \/|download/i;

/** Pull `node --version && npm --version` output apart into its two versions. */
export function parseRuntimeVersions(
  stdout: string,
  stderr = "",
): { nodeVersion: string | null; npmVersion: string | null } {
  const node = NODE_VERSION.exec(stdout) ?? NODE_VERSION.exec(stderr);
  const npm = BARE_VERSION.exec(stdout);
  return { nodeVersion: node ? `v${node[1] as string}` : null, npmVersion: npm ? (npm[1] as string) : null };
}

/**
 * The guest runtime, warmed once and then reused.
 *
 * ```ts
 * const runtime = new RuntimeBootstrap({ environment, persistentDataDisk: true });
 * await runtime.ensureReady();                 // one 147 s download, once per project
 * const build = await runtime.exec("npm run build"); // ordered *after* the warm-up
 * ```
 */
export class RuntimeBootstrap {
  readonly #environment: ExecutionEnvironment;
  readonly #homeDir: string;
  readonly #cacheDir: string;
  readonly #warmupCommand: string;
  readonly #cache: RuntimeSnapshot["cache"];
  readonly #warmupTimeoutMs: number;
  readonly #cachedTimeoutMs: number;
  readonly #probeTimeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #networkCommand: string;
  readonly #networkTimeoutMs: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  readonly #listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  #snapshot: RuntimeSnapshot;
  #inflight: Promise<RuntimeSnapshot> | null = null;

  constructor(options: RuntimeBootstrapOptions) {
    this.#environment = options.environment;
    this.#homeDir = options.homeDir ?? DEFAULT_HOME;
    this.#cacheDir = options.cacheDir ?? `${this.#homeDir}/.local`;
    this.#warmupCommand = options.warmupCommand ?? DEFAULT_WARMUP;
    this.#cache =
      options.persistentDataDisk === undefined
        ? "unknown"
        : options.persistentDataDisk
          ? "persisted"
          : "session-only";
    this.#warmupTimeoutMs = options.warmupTimeoutMs ?? 300_000;
    this.#cachedTimeoutMs = options.cachedTimeoutMs ?? 30_000;
    this.#probeTimeoutMs = options.probeTimeoutMs ?? 20_000;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.#retryDelayMs = options.retryDelayMs ?? 1_000;
    this.#networkCommand = options.networkCommand ?? DEFAULT_NETWORK_PROBE;
    this.#networkTimeoutMs = options.networkTimeoutMs ?? 20_000;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? (async (ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    this.#snapshot = {
      state: "idle",
      nodeVersion: null,
      npmVersion: null,
      cacheDir: this.#cacheDir,
      cache: this.#cache,
      reused: false,
      downloaded: false,
      network: options.network ?? "unknown",
      attempts: [],
      durationMs: 0,
      warnings: this.#initialWarnings(),
      error: null,
    };
  }

  snapshot(): RuntimeSnapshot {
    return this.#snapshot;
  }

  onState(listener: (snapshot: RuntimeSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The command that forces the shim's download; exposed for logs and tests. */
  get warmupCommand(): string {
    return this.#warmupCommand;
  }

  /**
   * Warm the runtime, or confirm it is already warm. Concurrent callers share one
   * warm-up: two tool calls must not both pay for the download.
   */
  async ensureReady(): Promise<RuntimeSnapshot> {
    if (this.#snapshot.state === "ready") return this.#snapshot;
    if (this.#inflight) return this.#inflight;

    let run: Promise<RuntimeSnapshot>;
    run = this.#warm().finally(() => {
      if (this.#inflight === run) this.#inflight = null;
    });
    this.#inflight = run;
    return run;
  }

  /**
   * Run a command *after* the runtime is warm, refusing the ones that cannot work here.
   *
   * Every install and build in the product goes through this method, which is what makes
   * the ordering guarantee a property of the code rather than of each caller's memory.
   */
  async exec(command: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    this.#assertSupported(command);
    await this.ensureReady();
    return this.#environment.execute(command, options);
  }

  /** Forget that the runtime is warm (a reboot); the cache on disk is untouched. */
  invalidate(): void {
    this.#snapshot = {
      ...this.#snapshot,
      state: "idle",
      attempts: [],
      durationMs: 0,
      error: null,
      reused: false,
      downloaded: false,
    };
    this.#emit();
  }

  /** Throw with the measured reason for a command this guest cannot run. */
  #assertSupported(command: string): void {
    const tokens = command.split(/[\s;&|()<>]+/);
    for (const refused of REFUSED) {
      if (!tokens.includes(refused.token)) continue;
      throw new RuntimeBootstrapError(
        "unsupported-command",
        `\`${command}\` cannot run here. ${refused.message}`,
        this.#snapshot.attempts,
      );
    }
  }

  async #warm(): Promise<RuntimeSnapshot> {
    const startedAt = this.#now();
    this.#set({
      ...this.#snapshot,
      state: "checking",
      attempts: [],
      durationMs: 0,
      error: null,
      reused: false,
      downloaded: false,
    });

    // 1. Is the runtime already installed on *this boot's* home? The shim installs to
    //    `<cacheDir>/share/node/<version>` and links from `<cacheDir>/bin`, so the
    //    directory is the fact to check — `command -v node` would only find the shim.
    const cached = await this.#probeCache();
    if (!cached) this.#set({ ...this.#snapshot, state: "warming" });

    // 2. A download without a network is 147 s of nothing: check first, and say what to
    //    do about it (the guest's network is a Wisp proxy, and the default one accepts
    //    only known origins).
    if (!cached) {
      const network = await this.#probeNetwork();
      if (network === "offline") {
        throw this.#fail(OFFLINE_MESSAGE, []);
      }
    }

    // 3. Ask the shim. A cold call downloads (~147 s) and can exit 127 once, so it gets
    //    the long budget and one retry; a warm call is one exec and a short budget.
    const attempts: RuntimeAttempt[] = [];
    const timeoutMs = cached ? this.#cachedTimeoutMs : this.#warmupTimeoutMs;
    let failure: string | null = null;

    for (let index = 1; index <= this.#maxAttempts; index += 1) {
      const attemptStart = this.#now();
      try {
        const result = await this.#environment.execute(this.#warmupCommand, {
          timeoutMs,
          onOutput: (chunk) => this.#onOutput(chunk),
        });
        const attempt = this.#record(index, result, this.#now() - attemptStart);
        attempts.push(attempt);
        this.#set({ ...this.#snapshot, attempts: [...attempts] });

        if (result.exitCode === 0) return this.#succeed(attempts, cached, startedAt);

        failure = `\`${this.#warmupCommand}\` exited ${String(result.exitCode)}: ${tail(
          `${result.stderr}${result.stdout}`,
        )}`;
      } catch (error) {
        // A timeout or a cancellation is not the shim's transient 127: retrying would
        // double a wall clock the person is already watching.
        if (error instanceof ExecutionTimeoutError || error instanceof ExecutionCancelledError) {
          const attempt = this.#failedAttempt(index, error, this.#now() - attemptStart);
          attempts.push(attempt);
          throw this.#fail(
            `${error.message} while warming the guest runtime (cache ${this.#cacheDir}). ` +
              "Nothing was retried: a hang is not the shim's exit 127.",
            attempts,
          );
        }

        const attempt = this.#failedAttempt(index, error, this.#now() - attemptStart);
        attempts.push(attempt);
        this.#set({ ...this.#snapshot, attempts: [...attempts] });
        failure = error instanceof Error ? error.message : String(error);
      }

      if (index < this.#maxAttempts) {
        this.#set({
          ...this.#snapshot,
          warnings: [...this.#snapshot.warnings, `Attempt ${String(index)} failed; retrying once.`],
        });
        if (this.#retryDelayMs > 0) await this.#sleep(this.#retryDelayMs);
      }
    }

    throw this.#fail(
      `The guest runtime did not come up after ${String(attempts.length)} attempt(s). ${failure ?? ""}`.trim(),
      attempts,
    );
  }

  /** Did the shim already install Node on this home directory? */
  async #probeCache(): Promise<boolean> {
    const command = `ls -1 "${this.#cacheDir}/share/node" 2>/dev/null | head -3`;
    try {
      const result = await this.#environment.execute(command, { timeoutMs: this.#probeTimeoutMs });
      return result.exitCode === 0 && result.stdout.trim().length > 0;
    } catch {
      // The probe is an optimisation: if it fails, warm up the slow, certain way.
      return false;
    }
  }

  /**
   * Can the guest reach the internet? Only asked before a download that would otherwise
   * burn the whole warm-up budget on a network that is not there.
   */
  async #probeNetwork(): Promise<GuestNetworkState> {
    if (this.#snapshot.network === "offline") return "offline";
    try {
      const result = await this.#environment.execute(this.#networkCommand, {
        timeoutMs: this.#networkTimeoutMs,
      });
      const online = result.exitCode === 0 && /\bONLINE\b/.test(result.stdout);
      const network: GuestNetworkState = online ? "online" : "offline";
      this.#set({ ...this.#snapshot, network });
      return network;
    } catch {
      // A probe that could not run proves nothing; do not claim the guest is offline.
      return this.#snapshot.network;
    }
  }

  #succeed(attempts: RuntimeAttempt[], cached: boolean, startedAt: number): RuntimeSnapshot {
    const installed = attempts.some((attempt) => attempt.installed);
    const last = attempts[attempts.length - 1] as RuntimeAttempt;
    const versions = parseRuntimeVersions(last.stdout, last.stderr);
    const warnings = [...this.#initialWarnings()];

    if (versions.nodeVersion === null) {
      warnings.push(
        "The runtime answered but reported no Node version; treat the toolchain as unverified.",
      );
    }
    if (!cached && !installed) {
      warnings.push(
        "No runtime was cached and the shim reported no download; the install may have been reused from the image.",
      );
    }

    const snapshot: RuntimeSnapshot = {
      ...this.#snapshot,
      state: "ready",
      nodeVersion: versions.nodeVersion,
      npmVersion: versions.npmVersion,
      reused: cached && !installed,
      downloaded: installed,
      attempts: [...attempts],
      durationMs: this.#now() - startedAt,
      warnings,
      error: null,
    };
    this.#set(snapshot);
    return snapshot;
  }

  #fail(message: string, attempts: RuntimeAttempt[]): RuntimeBootstrapError {
    this.#set({
      ...this.#snapshot,
      state: "failed",
      attempts: [...attempts],
      error: message,
      warnings: this.#initialWarnings(),
    });
    return new RuntimeBootstrapError("warm-up-failed", message, attempts);
  }

  #record(index: number, result: ExecutionResult, durationMs: number): RuntimeAttempt {
    return {
      index,
      command: result.command,
      exitCode: result.exitCode,
      durationMs,
      installed: INSTALL_MARKER.test(`${result.stdout}${result.stderr}`),
      stdout: result.stdout,
      stderr: result.stderr,
      error: null,
    };
  }

  #failedAttempt(index: number, error: unknown, durationMs: number): RuntimeAttempt {
    const result =
      error instanceof ExecutionTimeoutError || error instanceof ExecutionCancelledError
        ? error.result
        : null;
    return {
      index,
      command: result?.command ?? this.#warmupCommand,
      exitCode: result?.exitCode ?? null,
      durationMs,
      installed: false,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  #initialWarnings(): string[] {
    const warnings: string[] = [];
    if (this.#cache === "session-only") {
      warnings.push(
        `The runtime is installed in ${this.#cacheDir}, which is not on a persistent data disk: ` +
          "the download is paid again after a reload. Boot with a persistent data disk to keep it.",
      );
    }
    return warnings;
  }

  #onOutput(chunk: OutputChunk): void {
    // Only the running command's output matters live; the attempts keep the final text.
    if (chunk.stream === "stderr" && INSTALL_MARKER.test(chunk.text)) {
      this.#set({
        ...this.#snapshot,
        warnings: this.#snapshot.warnings.includes("Downloading the guest runtime…")
          ? this.#snapshot.warnings
          : [...this.#snapshot.warnings, "Downloading the guest runtime…"],
      });
    }
  }

  #set(snapshot: RuntimeSnapshot): void {
    this.#snapshot = snapshot;
    this.#emit();
  }

  #emit(): void {
    const snapshot = this.#snapshot;
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}

/** The last few lines of a failed command, so an error message stays readable. */
function tail(text: string, lines = 4): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-lines)
    .join(" | ");
}

/** A sentence for the docs and the UI that states the supported runtime and the bans. */
export function describeRuntimeSupport(): string {
  return (
    `Guest runtime: ${SUPPORTED_RUNTIME.runtime} (npm, ${SUPPORTED_RUNTIME.bundler}). ` +
    `Bun is excluded — ${BUN_EXCLUSION.reason} ` +
    `apk is not usable in this guest, so the runtime comes from the shim's own download.`
  );
}
