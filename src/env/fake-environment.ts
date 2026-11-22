/**
 * A deterministic `ExecutionEnvironment` for tests and the mock agent.
 *
 * Two jobs, one implementation:
 *
 * - Unit tests need an environment with no WebAssembly, no timers and no surprises, so
 *   the agent loop and the UI can be tested on their own.
 * - The mock LLM provider (PRD §9) needs an environment where a scripted conversation
 *   produces scripted tool results.
 *
 * It is deliberately *not* a stub that claims success: every call is recorded, commands
 * are answered only from the configured script, and an unscripted command returns a
 * normal non-zero result rather than pretending to have run. That way a test that
 * forgets to script a command fails visibly.
 */

import { NotReadyError } from "./environment-errors";
import type {
  ExecutionEnvironment,
  ExecutionOptions,
  ExecutionResult,
  FileEntry,
  FileKind,
  InitializeOptions,
  OutputChunk,
  ShellOptions,
  TerminalEnd,
  TerminalSession,
} from "./execution";
import { joinGuestPath, resolveWorkspacePath, toMountedPath } from "./paths";
import type { EnvironmentSnapshot, EnvironmentStatus } from "./status";
import { MemoryWorkspace } from "./workspace-fs";
import type { WorkspaceFs } from "./workspace-fs";

/** What a scripted command answers with. */
export interface FakeCommandResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: number | null;
  /** Simulated duration, so timing-sensitive code has something to read. */
  durationMs?: number;
  /** Chunk boundaries for `onOutput`, to test streaming. Default: one stdout chunk. */
  chunks?: readonly string[];
}

export type FakeCommandHandler = (
  command: string,
  options: ExecutionOptions,
) => FakeCommandResult | Promise<FakeCommandResult>;

export interface FakeEnvironmentOptions {
  workspacePath?: string;
  /** Initial files, by guest path or workspace-relative path. */
  tree?: Record<string, string>;
  /** Commands to answer, keyed by the exact command string. */
  handlers?: Record<string, FakeCommandResult | FakeCommandHandler>;
  /** Answer for anything unscripted. Default: exit 127 with a "not scripted" note. */
  fallback?: FakeCommandResult | FakeCommandHandler;
  /** Boot failure, to test the `error` state. */
  initializeError?: string;
  /** Detected runtime reported in the snapshot. */
  runtime?: string | null;
  cpus?: number;
  memoryMiB?: number;
  now?: () => number;
}

export type FakeCall =
  | { method: "initialize" }
  | { method: "execute"; command: string; cwd: string }
  | { method: "openShell"; cwd: string; cols: number; rows: number }
  | { method: "readFile"; path: string }
  | { method: "writeFile"; path: string; bytes: number }
  | { method: "listFiles"; path: string }
  | { method: "createDirectory"; path: string }
  | { method: "removeFile"; path: string }
  | { method: "shutdown" };

/**
 * A terminal that behaves like a shell without a VM: it echoes what is typed, runs the
 * line through `execute()` once Enter arrives, prints the result and prompts again.
 *
 * That is exactly the contract the UI depends on — keystrokes in, output out, one
 * command per line — so a component test can drive the terminal for real instead of
 * asserting that some mock was called.
 */
class FakeShellSession implements TerminalSession {
  readonly output: ReadableStream<Uint8Array>;
  readonly ended: Promise<TerminalEnd>;
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  cols: number;
  rows: number;

  readonly #encoder = new TextEncoder();
  #controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  #resolveEnd: ((end: TerminalEnd) => void) | null = null;
  #buffer = "";
  #ended = false;

  constructor(
    private readonly run: (line: string) => Promise<string>,
    cols: number,
    rows: number,
    private readonly prompt: string,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.output = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: () => {
        this.#settle({ type: "lost" });
      },
    });
    this.ended = new Promise<TerminalEnd>((resolve) => {
      this.#resolveEnd = resolve;
    });
    this.#print(this.prompt);
  }

  async write(data: string | Uint8Array): Promise<void> {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.writes.push(text);

    for (const char of text) {
      if (char === "\u0003") {
        this.#buffer = "";
        this.#print("^C\r\n" + this.prompt);
        continue;
      }
      if (char === "\r" || char === "\n") {
        const line = this.#buffer;
        this.#buffer = "";
        // A real pty echoes the keystrokes, so the transcript shows the command.
        this.#print(`\r\n${await this.run(line)}${this.prompt}`);
        continue;
      }
      if (char === "\u007f") {
        this.#buffer = this.#buffer.slice(0, -1);
        continue;
      }
      this.#buffer += char;
      this.#print(char);
    }
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizes.push({ cols, rows });
  }

  kill(): void {
    this.#settle({ type: "signal", signal: 15 });
  }

  async close(): Promise<void> {
    this.#settle({ type: "closed" });
  }

  #print(text: string): void {
    if (this.#ended || !this.#controller || text.length === 0) return;
    this.#controller.enqueue(this.#encoder.encode(text));
  }

  #settle(end: TerminalEnd): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.#controller?.close();
    } catch {
      // Already closed by a cancelled reader.
    }
    this.#resolveEnd?.(end);
  }
}


export class FakeEnvironment implements ExecutionEnvironment {
  readonly workspacePath: string;

  /** Every call in order, so tests assert sequencing instead of guessing it. */
  readonly calls: FakeCall[] = [];

  readonly #fs: MemoryWorkspace;
  readonly #options: FakeEnvironmentOptions;
  readonly #handlers: Record<string, FakeCommandResult | FakeCommandHandler>;
  readonly #now: () => number;
  readonly #listeners = new Set<(snapshot: EnvironmentSnapshot) => void>();

  #status: EnvironmentStatus = "idle";
  #error: string | null = null;

  constructor(options: FakeEnvironmentOptions = {}) {
    this.#options = options;
    // Copied, so `script()` can add an answer later — a handler sometimes needs the
    // environment it will answer for (to write the file its shell would have).
    this.#handlers = { ...(options.handlers ?? {}) };
    this.workspacePath = resolveWorkspacePath("/", options.workspacePath ?? "/workspace");
    // Tree keys may be workspace-relative (`package.json`) or guest-absolute
    // (`/workspace/src/App.tsx`); both mean "inside the workspace", so they are
    // resolved against it instead of being handed to the file system unconverted.
    const tree: Record<string, string> = {};
    for (const [path, content] of Object.entries(options.tree ?? {})) {
      const guest = resolveWorkspacePath(this.workspacePath, path);
      tree[toMountedPath(this.workspacePath, guest)] = content;
    }
    this.#fs = new MemoryWorkspace(tree);
    this.#now = options.now ?? (() => 0);
  }

  status(): EnvironmentStatus {
    return this.#status;
  }

  snapshot(): EnvironmentSnapshot {
    const ready = this.#status === "ready";
    return {
      status: this.#status,
      runtime: ready ? (this.#options.runtime ?? null) : null,
      distro: ready ? "fake" : null,
      cpus: ready ? (this.#options.cpus ?? null) : null,
      memoryMiB: ready ? (this.#options.memoryMiB ?? null) : null,
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
    this.calls.push({ method: "initialize" });
    this.#set("initializing");
    options.onStage?.("boot", "fake boot");
    this.#set("booting");

    if (this.#options.initializeError) {
      this.#error = this.#options.initializeError;
      this.#set("error", this.#options.initializeError);
      throw new Error(this.#options.initializeError);
    }

    options.onStage?.("filesystem", this.workspacePath);
    this.#fs.mkdirp("/");
    options.onStage?.("shell", "fake shell");
    options.onStage?.("runtime", "fake runtime");
    this.#set("ready");
  }

  async execute(command: string, options: ExecutionOptions = {}): Promise<ExecutionResult> {
    this.#requireReady(`run \`${command}\``);
    const cwd = options.cwd
      ? resolveWorkspacePath(this.workspacePath, options.cwd)
      : this.workspacePath;
    this.calls.push({ method: "execute", command, cwd });

    const handler = this.#handlers[command];
    const entry = handler ?? this.#options.fallback;
    const result =
      typeof entry === "function"
        ? await entry(command, options)
        : (entry ?? {
            stdout: "",
            stderr: `fake environment: no script for \`${command}\`\n`,
            exitCode: 127,
          });

    for (const chunk of result.chunks ?? [result.stdout ?? ""]) {
      if (chunk.length === 0) continue;
      emit(options.onOutput, { stream: "stdout", text: chunk });
    }
    if (result.stderr) emit(options.onOutput, { stream: "stderr", text: result.stderr });

    return {
      command,
      argv: ["/bin/sh", "-lc", command],
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
      signal: result.signal ?? null,
      durationMs: result.durationMs ?? this.#now(),
      truncated: false,
    };
  }

  async executeArgv(
    file: string,
    args: readonly string[] = [],
    options: ExecutionOptions = {},
  ): Promise<ExecutionResult> {
    return this.execute([file, ...args].join(" "), options);
  }

  /**
   * A terminal over `execute()`: the same commands, one per line, with a prompt. It is
   * not a pty — there is no VM here — but the shape the UI sees is the real one, so a
   * component test can type a command and assert on what came back.
   */
  async openShell(options: ShellOptions = {}): Promise<TerminalSession> {
    this.#requireReady("open a terminal");
    const cwd = options.cwd
      ? resolveWorkspacePath(this.workspacePath, options.cwd)
      : this.workspacePath;
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;
    this.calls.push({ method: "openShell", cwd, cols, rows });

    return new FakeShellSession(
      async (line) => {
        const command = line.trim();
        if (command.length === 0) return "";
        const result = await this.execute(command, { cwd });
        const out = `${result.stdout}${result.stderr}`.replace(/\n/g, "\r\n");
        const status =
          result.exitCode === 0 || result.exitCode === null
            ? ""
            : `[exit ${String(result.exitCode)}]\r\n`;
        return `${out}${status}`;
      },
      cols,
      rows,
      `user@larpable:${cwd}$ `,
    );
  }

  async readFile(path: string): Promise<Uint8Array> {
    const target = this.#requireFile(`read ${path}`, path);
    this.calls.push({ method: "readFile", path: target });
    return this.#fs.readFile(toMountedPath(this.workspacePath, target));
  }
  async writeFile(path: string, content: Uint8Array | string): Promise<void> {
    const target = this.#requireFile(`write ${path}`, path);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.calls.push({ method: "writeFile", path: target, bytes: bytes.byteLength });
    this.#fs.writeFile(toMountedPath(this.workspacePath, target), content);
  }

  async listFiles(path: string): Promise<FileEntry[]> {
    const target = this.#requireFile(`list ${path}`, path);
    this.calls.push({ method: "listFiles", path: target });
    return this.#fs.readdir(toMountedPath(this.workspacePath, target)).map((entry) => ({
      name: entry.name,
      path: joinGuestPath(target, entry.name),
      kind: kindOf(entry.type),
      size:
        this.#fs.stat(toMountedPath(this.workspacePath, joinGuestPath(target, entry.name)))?.size ?? 0,
    }));
  }

  async createDirectory(path: string): Promise<void> {
    const target = this.#requireFile(`create ${path}`, path);
    this.calls.push({ method: "createDirectory", path: target });
    this.#fs.mkdirp(toMountedPath(this.workspacePath, target));
  }

  async removeFile(path: string): Promise<void> {
    const target = this.#requireFile(`remove ${path}`, path);
    this.calls.push({ method: "removeFile", path: target });
    this.#fs.rm(toMountedPath(this.workspacePath, target), { force: false, recursive: false });
  }

  async shutdown(): Promise<void> {
    this.calls.push({ method: "shutdown" });
    this.#set("stopped");
  }

  /** Test helper: add or replace a scripted command after construction. */
  script(command: string, handler: FakeCommandResult | FakeCommandHandler): void {
    this.#handlers[command] = handler;
  }

  /** Test helper: the workspace tree, for assertions. */
  workspace(): WorkspaceFs {
    return this.#fs;
  }

  #requireReady(operation: string): void {
    if (this.#status !== "ready") throw new NotReadyError(this.#status, operation);
  }

  #requireFile(operation: string, path: string): string {
    this.#requireReady(operation);
    return resolveWorkspacePath(this.workspacePath, path);
  }

  #set(status: EnvironmentStatus, error: string | null = null): void {
    this.#status = status;
    this.#error = error;
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) listener(snapshot);
  }
}

function emit(onOutput: ((chunk: OutputChunk) => void) | undefined, chunk: OutputChunk): void {
  onOutput?.(chunk);
}

function kindOf(type: "file" | "dir" | "symlink"): FileKind {
  return type === "dir" ? "directory" : type;
}
