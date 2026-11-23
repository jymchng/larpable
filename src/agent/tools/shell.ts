/**
 * Shell tools (PRD §9.3, "Shell").
 *
 * `execute_command` is the tool that makes the agent able to *do* things the file tools
 * cannot: install, build, test. Everything dangerous about it is handled by choosing what
 * to hand back, not by refusing to run:
 *
 * - **A non-zero exit is a result, not an exception.** The agent has to read a compiler's
 *   error to fix it, so a failed command returns the exit code and the tail of the output.
 *   Only an infrastructure failure (cancelled, timeout, spawn failure) is a tool error.
 * - **The tail, not the head.** Build logs put the reason last. `clampText` keeps the tail
 *   and announces what it cut, because a model that reads a silently shortened log will
 *   "fix" a problem that was never in it.
 * - **Background is a first-class choice.** A dev server or a long install should not
 *   block the run, so `background` returns a process id immediately and the other two
 *   tools (`get_process_output`, `terminate_process`) make that decision reversible. That
 *   trio is the reason `ProcessRegistry` exists at all.
 */

import { OutsideWorkspaceError } from "@/env/environment-errors";
import { resolveWorkspacePath } from "@/env/paths";
import {
  clampText,
  defineTool,
  failure,
  success,
  type AgentTool,
  type ToolContext,
} from "./types";
import type { ProcessInfo } from "./processes";

/** Default budget for one foreground command. */
const DEFAULT_TIMEOUT_MS = 120_000;
/** Longest budget a model may ask for: a hung install must still end. */
const MAX_TIMEOUT_MS = 600_000;
/** How long `get_process_output` waits by default for a running process. */
const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MS = 60_000;

function messageOf(cause: unknown): string {
  if (cause instanceof OutsideWorkspaceError) {
    return `that path is outside the project workspace (${cause.message})`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

function cwdFor(context: ToolContext, cwd: unknown): string {
  const relative = typeof cwd === "string" && cwd.length > 0 ? cwd : ".";
  return resolveWorkspacePath(context.root, relative);
}

function duration(ms: number | null): string {
  if (ms === null) return "still running";
  return ms < 1000 ? `${String(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Render a process record as the text the model reads. */
function describeProcess(info: ProcessInfo): string {
  const headline =
    info.state === "running"
      ? `\`${info.command}\` is still running (${info.id}).`
      : info.state === "cancelled"
        ? `\`${info.command}\` was cancelled after ${duration(info.durationMs)}.`
        : `\`${info.command}\` exited with status ${String(info.exitCode ?? "signal")} after ${duration(info.durationMs)}.`;

  const parts: string[] = [headline];
  if (info.error !== null) parts.push(`Error: ${info.error}`);
  if (info.stdout.length > 0) parts.push(`stdout:\n${info.stdout.trimEnd()}`);
  if (info.stderr.length > 0) parts.push(`stderr:\n${info.stderr.trimEnd()}`);
  if (info.truncated) parts.push("(Earlier output was dropped: only the tail is kept.)");
  if (info.stdout.length === 0 && info.stderr.length === 0 && info.state !== "running") {
    parts.push("(The command printed nothing.)");
  }
  return clampText(parts.join("\n\n"));
}

export const executeCommandTool: AgentTool = defineTool(
  {
    name: "execute_command",
    description:
      "Run a shell command in the project directory. Returns the exit status and the end of " +
      "its output. Use background=true for a long-running command (an install, or a server " +
      "that must keep running) and then get_process_output to read it.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "execute_command arguments",
      properties: {
        command: {
          type: "string",
          description: "The command line, e.g. `npm run build`. Pipes and redirects are allowed.",
          minLength: 1,
        },
        cwd: {
          type: "string",
          description: "Directory to run in, relative to the project root. Default the root.",
        },
        timeoutMs: {
          type: "integer",
          description: "Kill the command after this many milliseconds. Default 120000.",
          minimum: 1,
          maximum: MAX_TIMEOUT_MS,
        },
        background: {
          type: "boolean",
          description:
            "Return immediately with a process id instead of waiting for the command to finish.",
        },
      },
      required: ["command"],
    },
  },
  async (args, context) => {
    const command = String(args.command);
    const background = args.background === true;
    const timeoutMs =
      typeof args.timeoutMs === "number"
        ? Math.min(Math.max(args.timeoutMs, 1), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

    if (context.signal?.aborted === true) {
      return failure("The run was cancelled before the command started.");
    }

    let cwd: string;
    try {
      cwd = cwdFor(context, args.cwd);
    } catch (cause) {
      return failure(`Could not run that command: ${messageOf(cause)}.`);
    }

    const stream = (streamName: "stdout" | "stderr", text: string): void => {
      context.onOutput?.({
        toolCallId: context.toolCallId ?? "execute_command",
        stream: streamName,
        text,
      });
    };

    const { info, done } = context.processes.start(
      command,
      (line, options) => context.environment.execute(line, options),
      {
        cwd,
        timeoutMs,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        onOutput: stream,
      },
    );

    if (background) {
      // Deliberately not awaited: the record is in the registry, so the model can read it
      // later with get_process_output and kill it with terminate_process.
      return success(
        `Started \`${command}\` in the background as ${info.id}. Use get_process_output to read it.`,
        { processId: info.id, command, cwd, background: true },
      );
    }

    const finished = await done;
    const body = describeProcess(finished);
    const data = {
      processId: finished.id,
      command,
      cwd,
      exitCode: finished.exitCode,
      state: finished.state,
      durationMs: finished.durationMs,
      truncated: finished.truncated,
    };
    return finished.exitCode === 0 && finished.state === "exited"
      ? success(body, data)
      : failure(body, data);
  },
);

export const getProcessOutputTool: AgentTool = defineTool(
  {
    name: "get_process_output",
    description:
      "Read what a command started by execute_command has printed so far, or what it printed " +
      "before it exited. Waits briefly for a running command to produce its output.",
    readOnly: true,
    parameters: {
      type: "object",
      description: "get_process_output arguments",
      properties: {
        processId: {
          type: "string",
          description: "Process id from execute_command. Default: the most recent process.",
        },
        waitMs: {
          type: "integer",
          description: "How long to wait for a running process. Default 5000.",
          minimum: 0,
          maximum: MAX_WAIT_MS,
        },
      },
      required: [],
    },
  },
  async (args, context) => {
    const id = typeof args.processId === "string" ? args.processId : undefined;
    const info = context.processes.get(id);
    if (info === undefined) {
      const known = context.processes.list().map((entry) => entry.id);
      return failure(
        known.length === 0
          ? "No command has been started in this run yet."
          : `There is no process ${JSON.stringify(id ?? "")}. Known processes: ${known.join(", ")}.`,
      );
    }

    const waitMs =
      typeof args.waitMs === "number" ? Math.min(Math.max(args.waitMs, 0), MAX_WAIT_MS) : DEFAULT_WAIT_MS;
    const latest = waitMs > 0 && info.state === "running" ? (await context.processes.wait(info.id, waitMs)) ?? info : info;

    return success(describeProcess(latest), {
      processId: latest.id,
      state: latest.state,
      exitCode: latest.exitCode,
      truncated: latest.truncated,
    });
  },
);

export const terminateProcessTool: AgentTool = defineTool(
  {
    name: "terminate_process",
    description:
      "Stop a command started by execute_command. Use it to end a background server or to " +
      "give up on a hung command.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "terminate_process arguments",
      properties: {
        processId: {
          type: "string",
          description: "Process id to stop. Default: the most recent process.",
          minLength: 1,
        },
      },
      required: ["processId"],
    },
  },
  async (args, context) => {
    const id = String(args.processId);
    const info = context.processes.get(id);
    if (info === undefined) {
      return failure(`There is no process ${JSON.stringify(id)} in this run.`);
    }
    const terminated = context.processes.terminate(id);
    return terminated
      ? success(`Sent SIGTERM to ${id} (\`${info.command}\`).`, { processId: id, terminated })
      : failure(`${id} had already finished (state: ${info.state}), so there was nothing to stop.`, {
          processId: id,
          terminated,
        });
  },
);

export const listProcessesTool: AgentTool = defineTool(
  {
    name: "list_processes",
    description: "List the commands this run has started, with their state and exit status.",
    readOnly: true,
    parameters: {
      type: "object",
      description: "list_processes arguments",
      properties: {},
      required: [],
    },
  },
  async (_args, context) => {
    const entries = context.processes.list();
    if (entries.length === 0) return success("No commands have been started in this run.");
    const lines = entries.map(
      (entry) =>
        `${entry.id}  ${entry.state}${entry.exitCode === null ? "" : ` (exit ${String(entry.exitCode)})`}  ${entry.command}`,
    );
    return success(clampText(lines.join("\n")), { processes: entries.length });
  },
);

export const SHELL_TOOLS: readonly AgentTool[] = [
  executeCommandTool,
  getProcessOutputTool,
  terminateProcessTool,
  listProcessesTool,
];
