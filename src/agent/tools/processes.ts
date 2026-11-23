/**
 * The record of commands the agent started, including the ones it did not wait for.
 *
 * PRD §9.3 lists `get_process_output` and `terminate_process` next to `execute_command`,
 * and they only mean anything if a command can outlive the tool call that started it. So
 * `execute_command` can run in the background, and this registry is what makes the result
 * of that choice inspectable — and killable:
 *
 * - output is captured as it streams (`onOutput`), so a still-running build can be read
 *   part-way through instead of only at the end;
 * - an abort really reaches the guest, because the same `AbortSignal` is handed to
 *   `ExecutionEnvironment.execute`, which kills the program;
 * - the captured tail is bounded per stream, because a runaway `yes` must not fill the
 *   tab's memory before someone notices.
 */

import type { ExecutionResult, ExecutionOptions, OutputChunk } from "@/env/execution";

/** How much of each stream is kept per process. The tail is what matters. */
const CAPTURE_LIMIT = 64 * 1024;

export type ProcessState = "running" | "exited" | "cancelled" | "failed";

export interface ProcessInfo {
  id: string;
  command: string;
  state: ProcessState;
  /** Exit status once finished, `null` while running or after a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  startedAt: number;
  durationMs: number | null;
  /** True when a capture limit dropped earlier output. */
  truncated: boolean;
  /** Set when the call threw: cancellation, timeout, spawn failure. */
  error: string | null;
}

/** What `start` needs from the environment: one call, with output and an abort signal. */
export type CommandRunner = (
  command: string,
  options: ExecutionOptions,
) => Promise<ExecutionResult>;

export class ProcessRegistry {
  readonly #entries = new Map<string, ProcessInfo>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #now: () => number;
  #sequence = 0;
  /** Insertion order, so "the last process" means what a reader expects. */
  readonly #order: string[] = [];

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /**
   * Run `command` and keep its record. Resolves when it finishes; the record stays in the
   * registry so a later `get_process_output` can read it.
   */
  start(
    command: string,
    run: CommandRunner,
    options: {
      signal?: AbortSignal;
      cwd?: string;
      timeoutMs?: number;
      /** Called for every chunk as it arrives, before it is captured. */
      onOutput?: (stream: "stdout" | "stderr", text: string) => void;
    } = {},
  ): { info: ProcessInfo; done: Promise<ProcessInfo> } {
    const id = `proc-${String((this.#sequence += 1))}`;
    const controller = new AbortController();
    const startedAt = this.#now();

    const info: ProcessInfo = {
      id,
      command,
      state: "running",
      exitCode: null,
      stdout: "",
      stderr: "",
      startedAt,
      durationMs: null,
      truncated: false,
      error: null,
    };
    this.#entries.set(id, info);
    this.#controllers.set(id, controller);
    this.#order.push(id);

    // Cancellation from outside reaches the guest, not just this bookkeeping.
    const onAbort = (): void => {
      controller.abort();
    };
    if (options.signal !== undefined) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }

    const capture = (stream: "stdout" | "stderr", text: string): void => {
      const next = info[stream] + text;
      if (next.length > CAPTURE_LIMIT) {
        info[stream] = next.slice(next.length - CAPTURE_LIMIT);
        info.truncated = true;
      } else {
        info[stream] = next;
      }
      options.onOutput?.(stream, text);
    };

    const done = run(command, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      signal: controller.signal,
      onOutput: (chunk: OutputChunk) => {
        capture(chunk.stream, chunk.text);
      },
    })
      .then((result) => {
        info.exitCode = result.exitCode;
        info.state = result.exitCode === 0 ? "exited" : "failed";
        if (result.truncated) info.truncated = true;
        // The runner already streamed the output; keep the final text in case a runner
        // reports output without streaming it.
        if (info.stdout.length === 0 && result.stdout.length > 0) capture("stdout", result.stdout);
        if (info.stderr.length === 0 && result.stderr.length > 0) capture("stderr", result.stderr);
        return info;
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        info.error = message;
        info.state = controller.signal.aborted ? "cancelled" : "failed";
        return info;
      })
      .finally(() => {
        info.durationMs = this.#now() - startedAt;
        this.#controllers.delete(id);
        options.signal?.removeEventListener("abort", onAbort);
      });

    this.#pending.add(done);
    void done.finally(() => this.#pending.delete(done));
    return { info, done };
  }

  /** Every process this run started, oldest first. */
  list(): readonly ProcessInfo[] {
    return this.#order.map((id) => this.#entries.get(id)).filter((info) => info !== undefined);
  }

  /** The most recent process, or the one with `id`. */
  get(id?: string): ProcessInfo | undefined {
    if (id !== undefined) return this.#entries.get(id);
    const last = this.#order[this.#order.length - 1];
    return last === undefined ? undefined : this.#entries.get(last);
  }

  /** Kill a running command. Returns false when there was nothing to kill. */
  terminate(id: string): boolean {
    const controller = this.#controllers.get(id);
    if (controller === undefined) return false;
    controller.abort();
    const info = this.#entries.get(id);
    if (info !== undefined && info.state === "running") info.state = "cancelled";
    return true;
  }

  /** Wait for every in-flight command. Used when a run ends so nothing leaks. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }
}
