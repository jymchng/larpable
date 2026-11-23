/**
 * The environment contract every part of Larpable codes against.
 *
 * PRD §5.2 asks for an `ExecutionEnvironment` interface and a concrete
 * `UnkernelEnvironment`. The point of the interface is the dependency direction: the
 * agent, the tools, the build manager and the UI all talk to *this* file, and only
 * `unkernel-environment.ts` knows that a WebAssembly Linux kernel is behind it. No
 * unkernel type appears in any signature here, so the agent code cannot accidentally
 * depend on the VM vendor, and tests can drive the whole system with a fake.
 *
 * Two behaviours are deliberate and worth knowing before using it:
 *
 * - Every operation that touches the guest waits for `status() === "ready"`. PRD §5.3
 *   requires that the agent never runs a command before the environment is ready, so
 *   the check lives in the adapter rather than in each caller's discipline.
 * - A non-zero exit is a *result*, not an exception. The agent needs to read the logs
 *   of a failed build, so only infrastructure problems (boot failed, timeout,
 *   cancellation, spawn failure) throw.
 */

import type { EnvironmentSnapshot, EnvironmentStatus } from "./status";

/** Which pipe a streamed chunk came from. */
export type OutputStream = "stdout" | "stderr";

/** A piece of output as it arrives, so the UI can stream a build instead of waiting. */
export interface OutputChunk {
  stream: OutputStream;
  text: string;
}

export interface ExecutionOptions {
  /** Guest directory to run in. Defaults to the workspace root. */
  cwd?: string;
  /** Extra environment variables, applied over the guest user's defaults. */
  env?: Record<string, string>;
  /**
   * Wall-clock budget in milliseconds. On expiry the program gets SIGKILL and the
   * call rejects with `ExecutionTimeoutError`, carrying the output collected so far.
   */
  timeoutMs?: number;
  /** Abort to cancel. The program gets SIGKILL and the call rejects with
   * `ExecutionCancelledError`, again carrying the output so far. */
  signal?: AbortSignal;
  /** Bytes for stdin, then EOF. Strings are UTF-8. */
  input?: string | Uint8Array;
  /** Per-stream cap in bytes; beyond it the program is killed and output is marked
   * truncated. Default 8 MiB. */
  maxBufferBytes?: number;
  /** Called for every chunk of stdout/stderr as it arrives. */
  onOutput?: (chunk: OutputChunk) => void;
}

export interface ExecutionResult {
  /** The command as written, e.g. `npm run build`. */
  command: string;
  /** The argv actually handed to the guest, e.g. `["sh", "-c", "npm run build"]`. */
  argv: readonly string[];
  stdout: string;
  stderr: string;
  /** The exit status, or null when a signal ended the program. Never throws on
   * non-zero: callers inspect it. */
  exitCode: number | null;
  /** The guest signal number that ended the program, or null. */
  signal: number | null;
  durationMs: number;
  /** True when output hit `maxBufferBytes` and was cut. */
  truncated: boolean;
}

/**
 * How an interactive session ended.
 *
 * `closed` and `lost` both mean "no EXIT frame arrived" (the host hung up, or the
 * connection dropped), so `exitCode` is unknowable and callers must not pretend
 * otherwise.
 */
export type TerminalEnd =
  | { type: "exit"; code: number }
  | { type: "signal"; signal: number }
  | { type: "closed" }
  | { type: "lost" };

/**
 * A live terminal in the guest: a real pty, not a command runner.
 *
 * The distinction matters for what the user can do with it. A pty session has a
 * controlling terminal, so `ls` colours its output, `cat` streams a file as it reads
 * it, and interactive programs (`top`, an editor, a build's progress bar) behave the
 * way they do on a laptop. A pipe-based command runner gives none of that.
 */
export interface TerminalSession {
  /**
   * What the terminal prints, as bytes in order. Pull stream: the guest blocks once
   * the window is full, so keep reading. It ends after the program exits or
   * `close()`.
   */
  readonly output: ReadableStream<Uint8Array>;
  /** Settles once `output` has been read to its end. */
  readonly ended: Promise<TerminalEnd>;
  /** Type into the terminal. Strings are UTF-8. */
  write(data: string | Uint8Array): Promise<void>;
  /** Tell the guest the window size, so the foreground program gets SIGWINCH. */
  resize(cols: number, rows: number): void;
  /** Signal the foreground program (SIGTERM by default). */
  kill(signal?: string): void;
  /** Hang up the session; resolves once the connection is gone. */
  close(): Promise<void>;
}

export interface ShellOptions {
  /** Guest directory to start in. Defaults to the workspace root. */
  cwd?: string;
  /** Window size at start. Default 80 columns by 24 rows. */
  cols?: number;
  rows?: number;
  /** Extra environment variables for the shell. */
  env?: Record<string, string>;
  /** `TERM` for the guest program. Default `xterm-256color`. */
  term?: string;
  /**
   * Program to run. Default: the best shell the guest actually has — bash as a login,
   * interactive shell, falling back to `/bin/sh -i` with a prompt that needs no
   * expansion (`src/env/shell.ts` explains why the distinction is not cosmetic).
   */
  file?: string;
  args?: readonly string[];
}

export type FileKind = "file" | "directory" | "symlink";

export interface FileEntry {
  name: string;
  /** Guest-absolute path, always inside the workspace. */
  path: string;
  kind: FileKind;
  /** Bytes for files, 0 for directories and links. */
  size: number;
}

/** The steps `initialize()` reports, in the order PRD §5.3 lists them. */
export type InitializeStage =
  | "boot"
  | "filesystem"
  | "shell"
  | "runtime"
  | "network";

export interface InitializeOptions {
  /** Cancels initialisation; the environment ends in `error` with a cancellation
   * message and `shutdown()` still works. */
  signal?: AbortSignal;
  /** Progress for the UI: which PRD §5.3 step is running. */
  onStage?: (stage: InitializeStage, detail: string) => void;
  /** Run the optional network probe (PRD §5.3 step 8, "if supported"). Off by
   * default: a Wisp allow-list can make it fail for reasons that say nothing about
   * the environment. */
  verifyNetwork?: boolean;
}

/**
 * What the rest of Larpable uses. Implemented by `UnkernelEnvironment` (the real
 * Linux guest) and `FakeEnvironment` (tests, and the deterministic mock agent).
 */
export interface ExecutionEnvironment {
  /** Guest path of the project root, e.g. `/workspace`. */
  readonly workspacePath: string;

  status(): EnvironmentStatus;

  /** Status plus the facts the status bar shows. Never invents values. */
  snapshot(): EnvironmentSnapshot;

  /** Subscribe to status/snapshot changes. Returns the unsubscribe function. */
  onStatus(listener: (snapshot: EnvironmentSnapshot) => void): () => void;

  /** PRD §5.3: boot, mount, verify filesystem, verify shell, detect runtimes. */
  initialize(options?: InitializeOptions): Promise<void>;

  /**
   * Run a shell command. `command` is a shell string (`npm run build 2>&1`), so it is
   * handed to `sh -lc` in the guest: pipes, globs and redirection behave as a person
   * writing a shell command expects. Use `executeArgv` when quoting must not be
   * reinterpreted.
   */
  execute(command: string, options?: ExecutionOptions): Promise<ExecutionResult>;

  /**
   * Open an interactive terminal (a real pty in the guest), for the user's own shell.
   *
   * Separate from `execute()` on purpose: a command runner collects output and reports
   * an exit code, while a terminal is a conversation the user drives, with a
   * controlling terminal, a working `cd`, and a window size.
   */
  openShell(options?: ShellOptions): Promise<TerminalSession>;

  /** Run a program with an explicit argv, with no shell in between. */
  executeArgv(
    file: string,
    args?: readonly string[],
    options?: ExecutionOptions,
  ): Promise<ExecutionResult>;

  /** Guest-absolute or workspace-relative; anything outside the workspace throws
   * `OutsideWorkspaceError`. */
  readFile(path: string): Promise<Uint8Array>;

  writeFile(path: string, content: Uint8Array | string): Promise<void>;

  listFiles(path: string): Promise<FileEntry[]>;

  createDirectory(path: string): Promise<void>;

  removeFile(path: string): Promise<void>;

  /** Stop the guest. Idempotent, and safe after a failed `initialize()`. */
  shutdown(): Promise<void>;
}
