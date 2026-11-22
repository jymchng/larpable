/**
 * Install and build, inside the guest, with the logs that justify the verdict.
 *
 * The rules this manager exists to keep (PRD §7.3–7.4):
 *
 * - **Nothing runs before the runtime is warm.** Every command goes through the
 *   `RuntimeBootstrap` passed in, which waits for `node`/`npm` to exist — the first call
 *   would otherwise be a 50–150 s download inside a build's timeout.
 * - **A build is only successful if its output is there.** Exit 0 is necessary, not
 *   sufficient: the manager then resolves the output directory from the project's own
 *   config and reads `index.html` out of it. A build that exits 0 and leaves no entry
 *   point is recorded as a failure with kind `missing-entry`, because the preview would
 *   otherwise show nothing and the app would have claimed success.
 * - **Every attempt has an id and a log.** `id` is what the preview and the UI name, and
 *   the captured stdout/stderr is what the agent fixes code from. A failure invented by
 *   this file would be worse than no message, so the guest's own error lines are carried
 *   through `classifyFailure`.
 * - **Cancellation is not a failure.** It throws (the environment already killed the
 *   process) and leaves the previous successful build as the current one.
 */

import { ExecutionCancelledError, ExecutionTimeoutError } from "../env/environment-errors";
import type {
  ExecutionEnvironment,
  ExecutionOptions,
  ExecutionResult,
} from "../env/execution";
import { FileNotFoundError } from "../env/environment-errors";
import {
  LOCKFILES,
  installCommand,
  type PackageManager,
} from "../runtime/detect";
import type { Framework } from "../runtime/scaffold";

import {
  classifyFailure,
  detectBuildCommand,
  parsePackageJson,
  resolveOutputDir,
  type BuildCommandSource,
  type BuildFailure,
  type OutputDirSource,
} from "./plan";

/** The one method this manager needs from `RuntimeBootstrap`. */
export interface WarmRuntime {
  exec(command: string, options?: ExecutionOptions): Promise<ExecutionResult>;
}

export interface CommandLog {
  command: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface InstallResult {
  ok: boolean;
  log: CommandLog;
  /** The script/manager command that ran, e.g. `npm ci --no-audit --no-fund`. */
  command: string;
  packageManager: PackageManager;
  /** The lockfile that made `ci`-style installation possible, or null. */
  lockfile: string | null;
  failure: BuildFailure | null;
}

export interface BuildResult {
  /** Stable id for this attempt, e.g. `build-mf3k2-1`. Never reused. */
  id: string;
  ok: boolean;
  /** The command that ran (or would have run, for a planning failure). */
  command: string;
  commandSource: BuildCommandSource | "none";
  /** Why this command, in one sentence. */
  reason: string;
  /** Relative output directory, and where that answer came from. */
  outputDir: string;
  outputSource: OutputDirSource | "none";
  /** Guest path of the verified entry point, or null when it was not verified. */
  entryPoint: string | null;
  entryBytes: number | null;
  failure: BuildFailure | null;
  log: CommandLog | null;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
}

export interface BuildManagerOptions {
  environment: ExecutionEnvironment;
  /** The warm-runtime gate. Omit only in tests that never touch a real guest. */
  runtime?: WarmRuntime;
  /** Project root in the guest. Defaults to the environment's workspace. */
  root?: string;
  packageManager?: PackageManager;
  /** Framework hint for build-command and output-dir defaults. */
  framework?: Framework;
  /** Budget for an install. Default 600 s (a cold npm install is minutes). */
  installTimeoutMs?: number;
  /** Budget for a build. Default 300 s. */
  buildTimeoutMs?: number;
  /** Injectable clock and id source, so records are deterministic in tests. */
  now?: () => number;
  nextId?: (sequence: number) => string;
  /** Called after a *successful* build, so the preview refreshes to real output. */
  onBuilt?: (result: BuildResult) => void;
}

export class BuildManager {
  readonly #environment: ExecutionEnvironment;
  readonly #runtime: WarmRuntime | undefined;
  readonly #root: string;
  readonly #packageManager: PackageManager;
  readonly #framework: Framework | undefined;
  readonly #installTimeoutMs: number;
  readonly #buildTimeoutMs: number;
  readonly #now: () => number;
  readonly #nextId: (sequence: number) => string;
  readonly #onBuilt: ((result: BuildResult) => void) | undefined;

  readonly #history: BuildResult[] = [];
  #sequence = 0;

  constructor(options: BuildManagerOptions) {
    this.#environment = options.environment;
    this.#runtime = options.runtime;
    this.#root = options.root ?? options.environment.workspacePath;
    this.#packageManager = options.packageManager ?? "npm";
    this.#framework = options.framework;
    this.#installTimeoutMs = options.installTimeoutMs ?? 600_000;
    this.#buildTimeoutMs = options.buildTimeoutMs ?? 300_000;
    this.#now = options.now ?? Date.now;
    this.#nextId =
      options.nextId ?? ((sequence) => `build-${this.#now().toString(36)}-${String(sequence)}`);
    this.#onBuilt = options.onBuilt;
  }

  /** Every build attempt, oldest first. Failures are kept: they are evidence. */
  history(): readonly BuildResult[] {
    return [...this.#history];
  }

  /** The build the preview should be serving: the most recent successful one. */
  lastSuccessfulBuild(): BuildResult | null {
    for (let index = this.#history.length - 1; index >= 0; index -= 1) {
      const result = this.#history[index];
      if (result?.ok) return result;
    }
    return null;
  }

  /**
   * Install dependencies inside the guest.
   *
   * `npm ci` is chosen only when a lockfile exists, because `ci` fails loudly without
   * one — and a failing install is not a useful way to learn that a project has no lock.
   */
  async install(options: ExecutionOptions = {}): Promise<InstallResult> {
    const lockfile = await this.#findLockfile();
    const command = installCommand(this.#packageManager, { ci: lockfile !== null });
    const started = this.#now();

    let result: ExecutionResult;
    try {
      result = await this.#exec(command, {
        ...options,
        timeoutMs: options.timeoutMs ?? this.#installTimeoutMs,
      });
    } catch (error) {
      if (error instanceof ExecutionCancelledError) throw error;
      const failure = this.#exceptionFailure(command, error);
      return {
        ok: false,
        command,
        packageManager: this.#packageManager,
        lockfile,
        failure,
        log: {
          command,
          exitCode: null,
          durationMs: this.#now() - started,
          stdout: "",
          stderr: failure.detail,
          truncated: false,
        },
      };
    }

    const ok = result.exitCode === 0;
    return {
      ok,
      command,
      packageManager: this.#packageManager,
      lockfile,
      failure: ok
        ? null
        : classifyFailure({
            command,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
      log: {
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      },
    };
  }

  /**
   * Run the production build and verify its output.
   *
   * A planning failure (no `package.json`, no build script) is recorded like any other
   * failure: it has an id, a reason and a log of what was *not* run. That keeps the
   * history readable as "what happened" instead of "what was attempted and silently
   * dropped".
   */
  async build(options: ExecutionOptions = {}): Promise<BuildResult> {
    const startedAt = this.#now();
    const id = this.#nextId((this.#sequence += 1));

    const pkg = await this.#readPackageJson();
    const planned = detectBuildCommand({
      packageJson: pkg,
      packageManager: this.#packageManager,
      ...(this.#framework ? { framework: this.#framework } : {}),
    });

    if (planned.plan === null) {
      return this.#record({
        id,
        ok: false,
        command: `(no build command: ${this.#packageManager})`,
        commandSource: "none",
        reason: planned.problem ?? "No build command could be determined.",
        outputDir: "—",
        outputSource: "none",
        entryPoint: null,
        entryBytes: null,
        failure: {
          kind: "missing-script",
          summary: planned.problem ?? "No build command could be determined.",
          detail: pkg.problem ?? "",
          hint: "Add a `build` script to package.json; the build manager will not invent one.",
        },
        log: null,
        startedAt,
        finishedAt: this.#now(),
      });
    }

    const command = planned.plan.command;
    let result: ExecutionResult;
    try {
      result = await this.#exec(command, {
        ...options,
        timeoutMs: options.timeoutMs ?? this.#buildTimeoutMs,
      });
    } catch (error) {
      if (error instanceof ExecutionCancelledError) throw error;
      return this.#record({
        id,
        ok: false,
        command,
        commandSource: planned.plan.source,
        reason: planned.plan.reason,
        outputDir: "—",
        outputSource: "none",
        entryPoint: null,
        entryBytes: null,
        failure: this.#exceptionFailure(command, error),
        log: null,
        startedAt,
        finishedAt: this.#now(),
      });
    }

    if (result.exitCode !== 0) {
      return this.#record({
        id,
        ok: false,
        command,
        commandSource: planned.plan.source,
        reason: planned.plan.reason,
        outputDir: "—",
        outputSource: "none",
        entryPoint: null,
        entryBytes: null,
        failure: classifyFailure({
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
        log: logOf(result),
        startedAt,
        finishedAt: this.#now(),
      });
    }

    // Exit 0 is not the verdict. Read the project's own configuration, then the file.
    const output = resolveOutputDir({
      ...(this.#framework ? { framework: this.#framework } : {}),
      viteConfig: await this.#readOptional("vite.config.ts") ?? (await this.#readOptional("vite.config.js")),
      netlifyToml: await this.#readOptional("netlify.toml"),
      packageJson: pkg.json,
    });

    const entryPoint = `${this.#root}/${output.dir}/index.html`;
    const entry = await this.#readEntryPoint(entryPoint);
    if (!entry.ok) {
      return this.#record({
        id,
        ok: false,
        command,
        commandSource: planned.plan.source,
        reason: planned.plan.reason,
        outputDir: output.dir,
        outputSource: output.source,
        entryPoint: null,
        entryBytes: null,
        failure: entry.failure,
        log: logOf(result),
        startedAt,
        finishedAt: this.#now(),
      });
    }

    const finishedAt = this.#now();
    const build: BuildResult = {
      id,
      ok: true,
      command,
      commandSource: planned.plan.source,
      reason: `${planned.plan.reason} ${output.reason}`,
      outputDir: output.dir,
      outputSource: output.source,
      entryPoint,
      entryBytes: entry.bytes,
      failure: null,
      log: logOf(result),
      startedAt,
      finishedAt,
      // Read from the same clock value as `finishedAt`: a record whose duration
      // disagrees with its own timestamps cannot be used to answer "how long did the
      // build take" without a second, contradictory answer.
      durationMs: finishedAt - startedAt,
    };
    this.#history.push(build);
    // The preview only ever refreshes to output that exists and parsed as HTML.
    this.#onBuilt?.(build);
    return build;
  }

  /** Run through the warm runtime when one was given, the environment otherwise. */
  async #exec(command: string, options: ExecutionOptions): Promise<ExecutionResult> {
    return this.#runtime
      ? this.#runtime.exec(command, options)
      : this.#environment.execute(command, options);
  }

  #record(result: Omit<BuildResult, "durationMs">): BuildResult {
    const record: BuildResult = { ...result, durationMs: result.finishedAt - result.startedAt };
    this.#history.push(record);
    return record;
  }

  async #findLockfile(): Promise<string | null> {
    const names = LOCKFILES[this.#packageManager];
    let entries;
    try {
      entries = await this.#environment.listFiles(this.#root);
    } catch {
      return null;
    }
    const found = entries
      .filter((entry) => entry.kind === "file" && names.includes(entry.name))
      .map((entry) => entry.name)
      .sort();
    return found[0] ?? null;
  }

  async #readPackageJson() {
    const text = await this.#readOptional("package.json");
    if (text === null) {
      return {
        json: null,
        problem: `There is no package.json in ${this.#root}, so there is no project to install or build.`,
      };
    }
    return parsePackageJson(text);
  }

  async #readOptional(relative: string): Promise<string | null> {
    try {
      const bytes = await this.#environment.readFile(`${this.#root}/${relative}`);
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  /** The entry point must exist *and* look like HTML; a JSON file named index.html is a bug. */
  async #readEntryPoint(
    guestPath: string,
  ): Promise<{ ok: true; bytes: number } | { ok: false; failure: BuildFailure }> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#environment.readFile(guestPath);
    } catch (error) {
      const missing = error instanceof FileNotFoundError;
      return {
        ok: false,
        failure: {
          kind: "missing-entry",
          summary: missing
            ? `The build exited 0 but wrote no ${guestPath}.`
            : `The build exited 0 but ${guestPath} could not be read: ${
                error instanceof Error ? error.message : String(error)
              }`,
          detail: "",
          hint:
            "Check the build command's output directory: set `build.outDir` in vite.config, or publish the " +
            "directory the build actually writes to.",
        },
      };
    }

    const text = new TextDecoder().decode(bytes.subarray(0, 512)).toLowerCase();
    if (!text.includes("<!doctype") && !text.includes("<html")) {
      return {
        ok: false,
        failure: {
          kind: "missing-entry",
          summary: `${guestPath} exists but is not HTML.`,
          detail: text.slice(0, 120),
          hint: "The output directory does not contain the site's entry page; check the build configuration.",
        },
      };
    }

    return { ok: true, bytes: bytes.byteLength };
  }

  #exceptionFailure(command: string, error: unknown): BuildFailure {
    if (error instanceof ExecutionTimeoutError) {
      return {
        kind: "timeout",
        summary: `\`${command}\` did not finish inside its budget and was killed.`,
        detail: error.message,
        hint: "A cold install or a very large project needs a larger timeout; nothing was retried silently.",
      };
    }
    return {
      kind: "unknown",
      summary: `\`${command}\` could not be started: ${
        error instanceof Error ? error.message : String(error)
      }`,
      detail: "",
      hint: "Check that the environment is ready and the runtime is warm.",
    };
  }
}

function logOf(result: ExecutionResult): CommandLog {
  return {
    command: result.command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
  };
}
