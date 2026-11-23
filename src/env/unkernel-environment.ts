/**
 * The real Linux guest, behind the `ExecutionEnvironment` contract.
 *
 * This is the only file in `src/` that knows unkernel exists. Everything it needs
 * from the VM is expressed in `unkernel-kernel.ts`, and the two things it cannot own
 * itself — the kernel factory and the workspace file system — are injected. That is
 * what makes the adapter testable: `tests/unkernel-environment.test.ts` drives it
 * through a fake kernel that records calls, so ordering, ready-gating, timeouts,
 * cancellation and exit capture are asserted without booting 10 MB of WebAssembly.
 *
 * Initialisation follows PRD §5.3 in order: boot, mount the workspace, verify the
 * file system, verify the shell, detect JavaScript runtimes, optionally verify the
 * network, then report `ready`. A failure at any step leaves the environment in
 * `error` with the message the UI shows, and `shutdown()` still works.
 *
 * Deliberate omissions, so nobody assumes they are implemented:
 *
 * - The guest runtime is *detected*, not installed. unkernel's guest ships a `node`
 *   shim that downloads a real Node on first use (measured at ~147 s), so probing
 *   `node --version` here would add minutes to boot; pre-warming belongs to the
 *   runtime manager, and the status bar only reports what was found.
 * - No snapshot, display, sound or disk-persistence plumbing: those arrive with the
 *   browser boot goal and the project manager, and adding unused calls now would be
 *   untested code pretending to be support.
 */

import {
  BusyError,
  EnvironmentError,
  ExecutionCancelledError,
  ExecutionTimeoutError,
  FileNotFoundError,
  NotReadyError,
} from "./environment-errors";
import type {
  ExecutionEnvironment,
  ExecutionOptions,
  ExecutionResult,
  FileEntry,
  FileKind,
  InitializeOptions,
  InitializeStage,
  OutputChunk,
  ShellOptions,
  TerminalSession,
} from "./execution";
import { joinGuestPath, resolveWorkspacePath, toMountedPath } from "./paths";
import {
  SHELL_PROBE_COMMAND,
  SHELL_PROBE_MARKER,
  parseBashProbe,
  planShellAttempts,
} from "./shell";
import type { EnvironmentSnapshot, EnvironmentStatus } from "./status";
import { browserKernelFactory, createMemoryWorkspace } from "./unkernel-kernel";
import type {
  KernelBootRequest,
  KernelEndEvent,
  KernelFactory,
  KernelLike,
  KernelNetwork,
  KernelProcessLike,
} from "./unkernel-kernel";
import type { WorkspaceFs } from "./workspace-fs";

export interface UnkernelEnvironmentOptions {
  /** The Linux image to boot: `/distros/debian.erofs` in the browser, a path on Node. */
  distro: string;
  /** Label for the status bar. Defaults to the image's base name without extension. */
  distroName?: string;
  /** Guest path of the project root. Default `/workspace`. */
  workspacePath?: string;
  memoryMiB?: number;
  cpus?: number;
  /** Where the guest's network frames go. Default `"wisp"`: browsers have no
   * direct backend, only a Wisp proxy. `"direct"` is for the Node-side guest tests. */
  network?: KernelNetwork;
  /** Self-hosted Wisp proxies, tried in order, when `network` is `"wisp"`. Empty uses
   * unkernel's default list (which accepts only known origins). */
  wispServers?: string[];
  /** One self-hosted Wisp proxy. Merged into `wispServers`. */
  wispServer?: string;
  /** Run the kernel in a Web Worker (browser). Ignored by injected test kernels. */
  worker?: boolean;
  /** Attach the persistent IndexedDB data disk (browser). */
  persistentDataDisk?: boolean;
  /** Default budget for `execute()`. Default 120 s. */
  commandTimeoutMs?: number;
  /** Default per-stream output cap. Default 8 MiB. */
  maxBufferBytes?: number;
  /** Boots the kernel. Defaults to unkernel in the browser; tests inject a fake. */
  kernelFactory?: KernelFactory;
  /** The workspace file system. Defaults to unkernel's `MemoryFs`. */
  workspaceFs?: WorkspaceFs;
  /** Initial files, when the default `MemoryFs` is created. */
  workspaceTree?: Record<string, string>;
  /** Injectable clock, so durations are deterministic in tests. */
  now?: () => number;
}

const DEFAULT_WORKSPACE = "/workspace";
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
/** What the browser terminal actually renders, so colour and line editing work. */
const DEFAULT_TERMINAL_TERM = "xterm-256color";
const SHELL_PROBE = SHELL_PROBE_COMMAND;

function timerUnref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

function delay(ms: number): { promise: Promise<never>; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new EnvironmentError("boot", `timed out after ${ms} ms`)), ms);
    timerUnref(handle);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

/**
 * Push a guest stream through a decoder, so a multi-byte character split across two
 * chunks still decodes correctly and the UI sees the text as it arrives.
 */
async function pump(
  stream: ReadableStream<Uint8Array>,
  onText: (text: string) => void,
  limit: { bytes: number; truncated: boolean; max: number },
  onOverflow: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      limit.bytes += value.byteLength;
      if (limit.bytes > limit.max) {
        limit.truncated = true;
        onOverflow();
        break;
      }

      const decoded = decoder.decode(value, { stream: true });
      if (decoded.length > 0) {
        text += decoded;
        onText(decoded);
      }
    }

    const tail = decoder.decode();
    if (tail.length > 0) {
      text += tail;
      onText(tail);
    }
  } catch {
    // A killed program closes its pipes abruptly; the text read so far is the result.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  }

  return text;
}

export class UnkernelEnvironment implements ExecutionEnvironment {
  readonly workspacePath: string;

  readonly #options: UnkernelEnvironmentOptions;
  readonly #kernelFactory: KernelFactory;
  readonly #now: () => number;
  readonly #distroName: string;
  readonly #commandTimeoutMs: number;
  readonly #maxBufferBytes: number;

  readonly #listeners = new Set<(snapshot: EnvironmentSnapshot) => void>();

  #status: EnvironmentStatus = "idle";
  #error: string | null = null;
  #kernel: KernelLike | null = null;
  #fs: WorkspaceFs | null = null;
  #runtime: string | null = null;
  #cpus: number | null = null;
  #memoryMiB: number | null = null;
  #transition: "initialize" | "shutdown" | null = null;
  /** Set by the boot probe: whether the guest can open bash instead of dash. */
  #hasBash = false;

  constructor(options: UnkernelEnvironmentOptions) {
    this.#options = options;
    this.workspacePath = resolveWorkspacePath("/", options.workspacePath ?? DEFAULT_WORKSPACE);
    this.#kernelFactory = options.kernelFactory ?? browserKernelFactory;
    this.#now = options.now ?? Date.now;
    this.#distroName = options.distroName ?? baseNameWithoutExtension(options.distro);
    this.#commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
    this.#cpus = options.cpus ?? null;
    this.#memoryMiB = options.memoryMiB ?? null;
  }

  status(): EnvironmentStatus {
    return this.#status;
  }

  snapshot(): EnvironmentSnapshot {
    return {
      status: this.#status,
      runtime: this.#runtime,
      distro: this.#distroName,
      cpus: this.#cpus,
      memoryMiB: this.#memoryMiB,
      error: this.#error,
    };
  }

  onStatus(listener: (snapshot: EnvironmentSnapshot) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async initialize(options: InitializeOptions = {}): Promise<void> {
    if (this.#transition) throw new BusyError("initialize", this.#status);
    if (this.#status === "ready") return;

    this.#transition = "initialize";
    this.#error = null;
    const report = (stage: InitializeStage, detail: string) => options.onStage?.(stage, detail);

    try {
      this.#setStatus("initializing");

      report("boot", `Booting ${this.#distroName}`);
      this.#fs = this.#options.workspaceFs ?? (await createMemoryWorkspace(this.#options.workspaceTree ?? {}));
      this.#setStatus("booting");

      const request: KernelBootRequest = {
        distro: this.#options.distro,
        mounts: { [this.workspacePath]: this.#fs },
        network: this.#options.network ?? "wisp",
        ...(this.#options.memoryMiB ? { memoryMiB: this.#options.memoryMiB } : {}),
        ...(this.#options.cpus ? { cpus: this.#options.cpus } : {}),
        ...(this.#options.wispServers?.length ? { wispServers: this.#options.wispServers } : {}),
        ...(this.#options.wispServer ? { wispServer: this.#options.wispServer } : {}),
        ...(this.#options.worker ? { worker: true } : {}),
        ...(this.#options.persistentDataDisk ? { persistentDataDisk: true } : {}),
        onProgress: (stage) => report("boot", `Booting ${this.#distroName}: ${stage}`),
      };

      const kernel = await this.#kernelFactory(request);
      this.#kernel = kernel;
      // Prefer the kernel's measured memory over the request.
      this.#memoryMiB = kernel.memoryMiB ?? this.#options.memoryMiB ?? null;

      report("filesystem", `Verifying ${this.workspacePath}`);
      await this.#verifyFilesystem();

      report("shell", "Verifying shell execution");
      await this.#verifyShell();

      report("runtime", "Detecting JavaScript runtimes");
      this.#runtime = await this.#detectRuntime();

      if (options.verifyNetwork) {
        report("network", "Verifying guest connectivity");
        await this.#verifyNetwork();
      }

      if (options.signal?.aborted) throw new ExecutionCancelledError(emptyResult("initialize"));
      this.#setStatus("ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.#error = message;
      this.#setStatus("error", message);
      await this.#stopKernel().catch(() => undefined);
      throw error instanceof EnvironmentError
        ? error
        : new EnvironmentError("boot", message, { cause: error });
    } finally {
      this.#transition = null;
    }
  }

  async execute(command: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    this.#requireReady(`run \`${command}\``);
    return this.#run("/bin/sh", ["-lc", command], command, options);
  }

  async executeArgv(
    file: string,
    args: readonly string[] = [],
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult> {
    const command = [file, ...args].join(" ");
    this.#requireReady(`run \`${command}\``);
    return this.#run(file, args, command, options);
  }

  /**
   * Open a real pty in the guest, for the user's own terminal.
   *
   * The shell starts in the workspace, because that is the directory every other
   * feature works on: `ls` there shows the project the agent is editing, and a file
   * `cat`-ed there is the file the preview will build.
   *
   * Which program runs is a measured decision, not a constant: the image's prompt is
   * bash-style, so bash is preferred and a dash fallback gets a prompt that needs no
   * expansion. `./shell.ts` explains why, and what the wrong shell looked like.
   *
   * `TERM=xterm-256color` matches what the browser terminal renders, so colour,
   * cursor addressing and line editing work instead of producing escape-litter.
   */
  async openShell(options: ShellOptions = {}): Promise<TerminalSession> {
    this.#requireReady("open a terminal");

    const kernel = this.#kernel;
    if (!kernel) throw new NotReadyError(this.#status, "open a terminal");

    const cwd = options.cwd
      ? resolveWorkspacePath(this.workspacePath, options.cwd)
      : this.workspacePath;

    const attempts = planShellAttempts({
      hasBash: this.#hasBash,
      ...(options.file !== undefined ? { file: options.file } : {}),
      ...(options.args !== undefined ? { args: options.args } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });

    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        return await kernel.spawn(attempt.file, attempt.args, {
          pty: true,
          cwd,
          cols: options.cols ?? DEFAULT_TERMINAL_COLS,
          rows: options.rows ?? DEFAULT_TERMINAL_ROWS,
          term: options.term ?? DEFAULT_TERMINAL_TERM,
          ...(attempt.env ? { env: attempt.env } : {}),
        });
      } catch (error) {
        // A program that exists but cannot be spawned is worth one fallback, not a
        // dead terminal: keep the failure and try the next shell.
        lastError = error;
      }
    }

    const tried = attempts.map((attempt) => `${attempt.file} ${attempt.args.join(" ")}`).join(", ");
    throw new EnvironmentError(
      "spawn",
      `Could not open a terminal in ${cwd} (tried ${tried}): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      { cause: lastError },
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    const target = this.#requireFile(`read ${path}`, path);
    return this.#requireFs().readFile(toMountedPath(this.workspacePath, target));
  }

  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    const target = this.#requireFile(`write ${path}`, path);
    this.#requireFs().writeFile(toMountedPath(this.workspacePath, target), content);
    this.#emit();
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    const target = this.#requireFile(`list ${path}`, path);
    const fs = this.#requireFs();

    return fs.readdir(toMountedPath(this.workspacePath, target)).map((entry) => ({
      name: entry.name,
      path: joinGuestPath(target, entry.name),
      kind: kindOf(entry.type),
      size:
        fs.stat(toMountedPath(this.workspacePath, joinGuestPath(target, entry.name)))?.size ?? 0,
    }));
  }

  async createDirectory(path: string): Promise<void> {
    const target = this.#requireFile(`create ${path}`, path);
    this.#requireFs().mkdirp(toMountedPath(this.workspacePath, target));
    this.#emit();
  }

  async removeFile(path: string): Promise<void> {
    const target = this.#requireFile(`remove ${path}`, path);
    const fs = this.#requireFs();
    const mounted = toMountedPath(this.workspacePath, target);
    if (!fs.stat(mounted)) throw new FileNotFoundError(target);
    fs.rm(mounted, { recursive: false, force: false });
    this.#emit();
  }

  async shutdown(): Promise<void> {
    if (this.#transition) throw new BusyError("shutdown", this.#status);
    if (this.#status === "stopped") return;

    this.#transition = "shutdown";
    try {
      if (this.#kernel) {
        // `poweroff` flushes the guest's disks; `stop()` alone does not, so it is the
        // fallback rather than the first move. Both are best effort: shutdown must
        // succeed even when the kernel is already wedged.
        // Bounded by the command budget as well as the 15 s ceiling: a shutdown in
        // tests (or in a UI that cancels) must not outlive the work it is cancelling.
        const poweroffBudget = Math.min(15_000, this.#commandTimeoutMs);
        await this.#run("/bin/sh", ["-lc", "poweroff"], "poweroff", {
          timeoutMs: poweroffBudget,
        }).catch(() => undefined);
        await this.#waitForExit(Math.min(10_000, this.#commandTimeoutMs)).catch(() => undefined);
        await this.#stopKernel().catch(() => undefined);
      }
    } finally {
      this.#kernel = null;
      this.#transition = null;
      this.#error = null;
      this.#hasBash = false;
      this.#setStatus("stopped");
    }
  }

  /**
   * The workspace file system, as mounted at `workspacePath`: its root *is* the
   * workspace, so callers map guest paths with `toMountedPath()`.
   */
  workspaceFs(): WorkspaceFs {
    return this.#requireFs();
  }

  async #run(
    file: string,
    args: readonly string[],
    command: string,
    options: ExecutionOptions,
  ): Promise<ExecutionResult> {
    const kernel = this.#kernel;
    if (!kernel) throw new NotReadyError(this.#status, `run \`${command}\``);

    const started = this.#now();
    const timeoutMs = options.timeoutMs ?? this.#commandTimeoutMs;
    const cwd = options.cwd
      ? resolveWorkspacePath(this.workspacePath, options.cwd)
      : this.workspacePath;

    let abortKind: "timeout" | "cancelled" | null = null;
    let process: KernelProcessLike | null = null;

    const kill = () => {
      try {
        process?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    };

    const onAbort = () => {
      if (abortKind) return;
      abortKind = "cancelled";
      kill();
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (abortKind) return;
            abortKind = "timeout";
            kill();
          }, timeoutMs)
        : null;
    if (timer !== null) timerUnref(timer);

    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const budget = {
      bytes: 0,
      truncated: false,
      max: options.maxBufferBytes ?? this.#maxBufferBytes,
    };
    const onText = (stream: OutputChunk["stream"]) => (text: string) =>
      options.onOutput?.({ stream, text });

    try {
      process = await kernel.spawn(file, args, { pty: false, cwd, env: options.env });
      if (abortKind) kill();

      const [stdout, stderr] = await Promise.all([
        pump(process.stdout, onText("stdout"), budget, kill),
        pump(process.stderr, onText("stderr"), budget, kill),
      ]);

      let end: KernelEndEvent = { type: "closed" };
      try {
        end = await process.ended;
      } catch {
        // A killed program can end without an EXIT frame; `closed` is the truth.
      }

      const result: ExecutionResult = {
        command,
        argv: [file, ...args],
        stdout,
        stderr,
        exitCode: end.type === "exit" ? end.code : null,
        signal: end.type === "signal" ? end.signal : null,
        durationMs: this.#now() - started,
        truncated: budget.truncated,
      };

      if (abortKind === "timeout") throw new ExecutionTimeoutError(timeoutMs, result);
      if (abortKind === "cancelled") throw new ExecutionCancelledError(result);

      return result;
    } catch (error) {
      if (error instanceof EnvironmentError) throw error;
      throw new EnvironmentError(
        "spawn",
        `Could not run \`${command}\`: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    } finally {
      if (timer !== null) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (process) await process.close().catch(() => undefined);
    }
  }

  async #verifyFilesystem(): Promise<void> {
    const fs = this.#requireFs();
    const probe = toMountedPath(this.workspacePath, joinGuestPath(this.workspacePath, ".larpable-probe"));
    const payload = `larpable ${this.#distroName}`;

    fs.writeFile(probe, payload);
    const readBack = new TextDecoder().decode(fs.readFile(probe));
    fs.rm(probe, { force: true });

    if (readBack !== payload) {
      throw new EnvironmentError(
        "boot",
        `${this.workspacePath} did not round-trip a write (read back ${JSON.stringify(readBack)}).`,
      );
    }
  }

  async #verifyShell(): Promise<void> {
    const result = await this.#run("/bin/sh", ["-lc", SHELL_PROBE], SHELL_PROBE, {
      timeoutMs: 60_000,
    });

    if (result.exitCode !== 0 || !result.stdout.includes(SHELL_PROBE_MARKER)) {
      throw new EnvironmentError(
        "boot",
        `The guest shell did not run: exit ${result.exitCode}, output ${JSON.stringify(result.stdout + result.stderr)}.`,
      );
    }

    // Same process, no extra cost: the probe also says whether bash exists, which is
    // the difference between the image's own prompt and a fallback one.
    this.#hasBash = parseBashProbe(result.stdout);
  }

  /**
   * Find the JavaScript runtimes the guest can offer. `command -v` is cheap and does
   * not trigger the shim's first-use download; versions are the runtime manager's
   * job, and paying ~147 s here would make boot unusable.
   */
  async #detectRuntime(): Promise<string | null> {
    const result = await this.#run(
      "/bin/sh",
      ["-lc", "command -v node 2>/dev/null; command -v bun 2>/dev/null"],
      "command -v node bun",
      { timeoutMs: 60_000 },
    ).catch(() => null);

    const output = result?.stdout ?? "";
    if (output.includes("node")) return "node (guest shim)";
    if (output.includes("bun")) return "bun";
    return null;
  }

  async #verifyNetwork(): Promise<void> {
    const result = await this.#run(
      "/bin/sh",
      ["-lc", "wget -q -O /dev/null http://example.com/ && echo OK"],
      "wget example.com",
      { timeoutMs: 60_000 },
    ).catch((error: unknown) => {
      if (error instanceof EnvironmentError) throw error;
      throw new EnvironmentError("boot", "The guest could not reach the network.", { cause: error });
    });

    if (!result.stdout.includes("OK")) {
      throw new EnvironmentError(
        "boot",
        "The guest could not reach the network: check the Wisp proxy and its allow-list.",
      );
    }
  }

  async #stopKernel(): Promise<void> {
    const kernel = this.#kernel;
    if (!kernel) return;
    await kernel.stop?.().catch(() => undefined);
  }

  async #waitForExit(timeoutMs: number): Promise<void> {
    const kernel = this.#kernel;
    if (!kernel) return;
    const race = delay(timeoutMs);
    try {
      await Promise.race([kernel.exited, race.promise]);
    } finally {
      race.cancel();
    }
  }

  #requireReady(operation: string): void {
    if (this.#status !== "ready") throw new NotReadyError(this.#status, operation);
  }

  #requireFile(operation: string, path: string): string {
    this.#requireReady(operation);
    return resolveWorkspacePath(this.workspacePath, path);
  }

  #requireFs(): WorkspaceFs {
    if (!this.#fs) throw new NotReadyError(this.#status, "use the workspace file system");
    return this.#fs;
  }

  #setStatus(status: EnvironmentStatus, error: string | null = null): void {
    this.#status = status;
    this.#error = error;
    this.#emit();
  }

  #emit(): void {
    if (this.#listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // A broken listener must not break the environment.
      }
    }
  }
}

function baseNameWithoutExtension(path: string): string {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function kindOf(type: "file" | "dir" | "symlink"): FileKind {
  return type === "dir" ? "directory" : type;
}

function emptyResult(command: string): ExecutionResult {
  return {
    command,
    argv: [],
    stdout: "",
    stderr: "",
    exitCode: null,
    signal: null,
    durationMs: 0,
    truncated: false,
  };
}
