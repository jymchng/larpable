/**
 * Typed failures for the environment layer.
 *
 * The agent loop has to tell "the build failed" (a normal `ExecutionResult` with a
 * non-zero exit) from "the environment is not ready", "the command timed out" and
 * "you asked for a path outside the project". A single `Error` with a prose message
 * would force string matching, so each case gets a class and a stable `code`.
 */

import type { ExecutionResult } from "./execution";
import type { EnvironmentStatus } from "./status";

export type EnvironmentErrorCode =
  | "not-ready"
  | "busy"
  | "outside-workspace"
  | "file-not-found"
  | "timeout"
  | "cancelled"
  | "spawn"
  | "boot"
  | "shutdown";

export class EnvironmentError extends Error {
  readonly code: EnvironmentErrorCode;

  constructor(code: EnvironmentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EnvironmentError";
    this.code = code;
  }
}

/** A command or file operation was attempted before PRD §5.3's `ready`. */
export class NotReadyError extends EnvironmentError {
  readonly status: EnvironmentStatus;

  constructor(status: EnvironmentStatus, operation: string) {
    super(
      "not-ready",
      `Cannot ${operation} while the environment is "${status}": the guest must be ready first.`,
    );
    this.name = "NotReadyError";
    this.status = status;
  }
}

/** `initialize()` or `shutdown()` was called while another transition was running. */
export class BusyError extends EnvironmentError {
  constructor(action: string, current: EnvironmentStatus) {
    super("busy", `Cannot ${action}: the environment is already "${current}".`);
    this.name = "BusyError";
  }
}

/** The path resolved outside the workspace root. */
export class OutsideWorkspaceError extends EnvironmentError {
  readonly requested: string;
  readonly workspacePath: string;

  constructor(requested: string, workspacePath: string) {
    super(
      "outside-workspace",
      `${JSON.stringify(requested)} is outside the workspace ${workspacePath}.`,
    );
    this.name = "OutsideWorkspaceError";
    this.requested = requested;
    this.workspacePath = workspacePath;
  }
}

export class FileNotFoundError extends EnvironmentError {
  readonly path: string;

  constructor(path: string) {
    super("file-not-found", `${path} does not exist.`);
    this.name = "FileNotFoundError";
    this.path = path;
  }
}

/** A command exceeded its budget. `result` holds whatever it printed before dying. */
export class ExecutionTimeoutError extends EnvironmentError {
  readonly timeoutMs: number;
  readonly result: ExecutionResult;

  constructor(timeoutMs: number, result: ExecutionResult) {
    super(
      "timeout",
      `\`${result.command}\` timed out after ${timeoutMs} ms and was killed.`,
    );
    this.name = "ExecutionTimeoutError";
    this.timeoutMs = timeoutMs;
    this.result = result;
  }
}

/** The caller's AbortSignal fired. `result` holds the partial output. */
export class ExecutionCancelledError extends EnvironmentError {
  readonly result: ExecutionResult;

  constructor(result: ExecutionResult) {
    super("cancelled", `\`${result.command}\` was cancelled.`);
    this.name = "ExecutionCancelledError";
    this.result = result;
  }
}
