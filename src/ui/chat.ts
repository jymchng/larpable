/**
 * The chat transcript, as a pure function of the events the agent loop emits.
 *
 * PRD §13 asks for a streaming chat with tool-execution indicators whose output can be
 * inspected. The hard part is not the markup: it is that a live conversation is a sequence of
 * *deltas* (`text`, `tool-start`, `tool-output`, `tool-end`, `stop`) and a UI that folds them
 * wrongly shows something the agent never did — a tool card that stays "running" after it
 * failed, a duplicated paragraph when the final `assistant` event restates the streamed text,
 * or a message with no indication that the run was cancelled.
 *
 * So the folding lives here, away from React, and `tests/chat-state.test.ts` drives it with
 * scripted event sequences. `src/ui/chat-panel.tsx` only renders the result. Two properties
 * this file keeps on purpose:
 *
 * - **Nothing is invented.** Every entry came from an event; a tool entry's status is the
 *   loop's own `ok`, its text is the loop's own `content`, and its "running" state ends only
 *   when `tool-end` arrives.
 * - **Output is bounded.** A build log is megabytes; `clipOutput` keeps the tail (where the
 *   error is) and says how much it dropped, so the pane cannot freeze on a huge result.
 */

import type { AgentEvent, AgentStopReason, ToolExecution } from "@/agent/loop";

/** How much of a tool's output the transcript keeps. The tail is where errors live. */
export const CHAT_OUTPUT_LIMIT = 4_000;
/** How much of a tool's result text the transcript keeps for inspection. */
export const CHAT_RESULT_LIMIT = 2_000;

export type ChatToolStatus = "running" | "ok" | "failed";

export interface ChatUserEntry {
  kind: "user";
  id: string;
  text: string;
}

export interface ChatAssistantEntry {
  kind: "assistant";
  id: string;
  iteration: number;
  text: string;
  /** True while the provider is still streaming into this entry. */
  streaming: boolean;
}

/** One tool call: what it was, how it went, and the output a user can open and read. */
export interface ChatToolEntry {
  kind: "tool";
  id: string;
  name: string;
  label: string;
  summary: string;
  parallel: boolean;
  status: ChatToolStatus;
  error: string | null;
  durationMs: number | null;
  /** Streamed stdout/stderr while the call runs, already clipped. */
  output: string;
  /** What the model was told, once the call finished. */
  result: string | null;
  /** True when either buffer was cut, so the pane can say so instead of lying. */
  truncated: boolean;
}

export interface ChatNoticeEntry {
  kind: "notice";
  id: string;
  tone: "info" | "warn" | "error";
  text: string;
}

export type ChatEntry = ChatUserEntry | ChatAssistantEntry | ChatToolEntry | ChatNoticeEntry;

export interface ChatState {
  entries: readonly ChatEntry[];
  /** True from `beginTurn` until the loop stops. */
  running: boolean;
  /** How many tool calls are still running (the pane's spinner and its live counter). */
  toolsRunning: number;
  /** How the last turn ended, or null before the first one finished. */
  lastStop: AgentStopReason | null;
}

export function initialChat(): ChatState {
  return { entries: [], running: false, toolsRunning: 0, lastStop: null };
}

/** Keep the tail of `text`, announcing what was dropped. */
export function clipOutput(text: string, limit = CHAT_OUTPUT_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const dropped = text.length - limit;
  return {
    text: `…[${String(dropped)} characters cut from the start]…\n${text.slice(text.length - limit)}`,
    truncated: true,
  };
}

/** What each tool is doing, in the user's words rather than the model's verb. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  write_file: "Writing a file",
  read_file: "Reading a file",
  edit_file: "Editing a file",
  list_files: "Listing files",
  search_files: "Searching files",
  delete_file: "Deleting a file",
  create_directory: "Creating a directory",
  execute_command: "Running a command",
  get_process_output: "Reading process output",
  terminate_process: "Stopping a process",
  list_processes: "Listing processes",
  scaffold_project: "Scaffolding a project",
  install_dependencies: "Installing dependencies",
  build_project: "Building the site",
  ensure_netlify_config: "Writing netlify.toml",
  publish_preview: "Publishing the preview",
  preview_status: "Checking the preview",
  project_status: "Checking the project",
};

/** The argument worth showing next to a tool's name, most specific first. */
const SUMMARY_KEYS = ["path", "command", "url", "path_glob", "query", "name", "package_name"] as const;

function oneLine(text: string, limit = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * A tool call as a card heading: a human label plus the one argument that identifies it.
 *
 * Arguments arrive as the model emitted them — a JSON string, possibly broken. A card must
 * still render when the JSON is invalid (that is precisely the call the user needs to see),
 * so a parse failure yields an empty summary instead of an exception.
 */
export function describeToolCall(name: string, argsJson: string): { label: string; summary: string } {
  const label = TOOL_LABELS[name] ?? `Running ${name}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return { label, summary: "" };
  }
  if (typeof parsed !== "object" || parsed === null) return { label, summary: "" };
  const record = parsed as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return { label, summary: oneLine(value) };
    }
  }
  return { label, summary: "" };
}

function replaceEntry(entries: readonly ChatEntry[], id: string, next: ChatEntry): ChatEntry[] {
  return entries.map((entry) => (entry.id === id ? next : entry));
}

function findTool(entries: readonly ChatEntry[], id: string): ChatToolEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "tool" && entry.id === id) return entry;
  }
  return null;
}

/** The assistant entry that streamed this iteration, if there is one. */
function findAssistant(entries: readonly ChatEntry[], iteration: number): ChatAssistantEntry | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "assistant" && entry.iteration === iteration) return entry;
  }
  return null;
}

function toolCompleted(entries: readonly ChatEntry[]): number {
  return entries.filter((entry) => entry.kind === "tool" && entry.status === "running").length;
}

/**
 * Start a turn: the user's words go into the transcript before any work begins, so the pane
 * never shows an agent "thinking" about a prompt the user cannot see.
 */
export function beginTurn(state: ChatState, text: string, id: string): ChatState {
  return {
    ...state,
    running: true,
    entries: [...state.entries, { kind: "user", id, text }],
  };
}

/**
 * Fold one loop event into the transcript.
 *
 * The only subtle case is the `assistant` event: providers stream deltas *and* finish with
 * the whole text, so the entry for that iteration is reconciled in place instead of appended
 * again. That is what stops a streamed paragraph from appearing twice.
 */
export function applyAgentEvent(state: ChatState, event: AgentEvent): ChatState {
  switch (event.type) {
    case "turn-start":
      return { ...state, running: true };

    case "text": {
      if (event.delta.length === 0) return state;
      const existing = findAssistant(state.entries, event.iteration);
      if (existing === null) {
        const entry: ChatAssistantEntry = {
          kind: "assistant",
          id: `assistant-${String(event.iteration)}`,
          iteration: event.iteration,
          text: event.delta,
          streaming: true,
        };
        return { ...state, entries: [...state.entries, entry] };
      }
      const next: ChatAssistantEntry = { ...existing, text: existing.text + event.delta, streaming: true };
      return { ...state, entries: replaceEntry(state.entries, existing.id, next) };
    }

    case "assistant": {
      if (event.text.length === 0) return state;
      const existing = findAssistant(state.entries, event.iteration);
      if (existing === null) {
        const entry: ChatAssistantEntry = {
          kind: "assistant",
          id: `assistant-${String(event.iteration)}`,
          iteration: event.iteration,
          text: event.text,
          streaming: false,
        };
        return { ...state, entries: [...state.entries, entry] };
      }
      const next: ChatAssistantEntry = { ...existing, text: event.text, streaming: false };
      return { ...state, entries: replaceEntry(state.entries, existing.id, next) };
    }

    case "tool-start": {
      const { label, summary } = describeToolCall(event.call.name, event.call.arguments);
      const entry: ChatToolEntry = {
        kind: "tool",
        id: event.call.id,
        name: event.call.name,
        label,
        summary,
        parallel: event.parallel,
        status: "running",
        error: null,
        durationMs: null,
        output: "",
        result: null,
        truncated: false,
      };
      const entries = [...state.entries, entry];
      return { ...state, entries, toolsRunning: toolCompleted(entries) };
    }

    case "tool-output": {
      const entry = findTool(state.entries, event.toolCallId);
      if (entry === null) return state;
      const clipped = clipOutput(entry.output + event.text);
      const next: ChatToolEntry = {
        ...entry,
        output: clipped.text,
        truncated: entry.truncated || clipped.truncated,
      };
      return { ...state, entries: replaceEntry(state.entries, entry.id, next) };
    }

    case "tool-end": {
      const entry = findTool(state.entries, event.execution.id);
      if (entry === null) return state;
      const result = clipOutput(event.execution.content, CHAT_RESULT_LIMIT);
      const next: ChatToolEntry = {
        ...entry,
        status: event.execution.ok ? "ok" : "failed",
        error: event.execution.error,
        durationMs: event.execution.durationMs,
        result: result.text,
        truncated: entry.truncated || result.truncated,
      };
      const entries = replaceEntry(state.entries, entry.id, next);
      return { ...state, entries, toolsRunning: toolCompleted(entries) };
    }

    case "retry": {
      const entry: ChatNoticeEntry = {
        kind: "notice",
        id: `retry-${String(event.iteration)}-${String(event.attempt)}`,
        tone: "warn",
        text: `The provider did not answer (${event.reason}). Trying again, attempt ${String(event.attempt)}.`,
      };
      return { ...state, entries: [...state.entries, entry] };
    }

    case "stop":
      return { ...state, running: false, lastStop: event.reason };
  }
}

/** The sentence a finished turn earns, or null when the run simply completed. */
export function stopNotice(reason: AgentStopReason, detail: string): ChatNoticeEntry | null {
  if (reason === "complete") return null;
  const tone: ChatNoticeEntry["tone"] = reason === "cancelled" ? "info" : "error";
  return { kind: "notice", id: `stop-${reason}`, tone, text: detail.length > 0 ? detail : reason };
}

/**
 * Close a turn.
 *
 * Every non-`complete` ending becomes a visible notice: a cancelled run, a provider failure
 * and an iteration limit all mean "the thing you asked for did not finish", and a transcript
 * that just stops looks like a success.
 */
export function endTurn(state: ChatState, options: { stop: AgentStopReason; detail: string }): ChatState {
  const notice = stopNotice(options.stop, options.detail);
  const entries = state.entries.map((entry) =>
    entry.kind === "assistant" && entry.streaming ? { ...entry, streaming: false } : entry,
  );
  return {
    ...state,
    running: false,
    lastStop: options.stop,
    toolsRunning: toolCompleted(entries),
    entries: notice === null ? entries : [...entries, notice],
  };
}

/**
 * The claims check's verdict, as a notice.
 *
 * `src/agent/claims.ts` exists because a model can announce a deployment that never happened.
 * When it finds an unsupported claim, the user is told — in the transcript, next to the claim.
 */
export function claimNotice(ok: boolean, summary: string): ChatNoticeEntry | null {
  if (ok) return null;
  return {
    kind: "notice",
    id: "claims",
    tone: "error",
    text: `That reply claims more than the tools showed: ${summary}`,
  };
}

/** A tool execution as the entry that would render it — used by tests and the panel. */
export function toolEntryFrom(execution: ToolExecution, call: { name: string; arguments: string }, parallel = false): ChatToolEntry {
  const { label, summary } = describeToolCall(call.name, call.arguments);
  const result = clipOutput(execution.content, CHAT_RESULT_LIMIT);
  return {
    kind: "tool",
    id: execution.id,
    name: call.name,
    label,
    summary,
    parallel,
    status: execution.ok ? "ok" : "failed",
    error: execution.error,
    durationMs: execution.durationMs,
    output: "",
    result: result.text,
    truncated: result.truncated,
  };
}

/** One line for the status bar: what the transcript is doing right now. */
export function describeChat(state: ChatState): string {
  if (state.running) {
    return state.toolsRunning > 0
      ? `Working — ${String(state.toolsRunning)} tool call${state.toolsRunning === 1 ? "" : "s"} running.`
      : "Thinking…";
  }
  if (state.entries.length === 0) return "No messages yet.";
  switch (state.lastStop) {
    case "complete":
      return "Ready for the next instruction.";
    case "cancelled":
      return "The last run was cancelled.";
    case "iteration-limit":
      return "The last run hit its tool-call limit.";
    case "timeout":
      return "The last run timed out.";
    case "provider-error":
      return "The last run could not reach the provider.";
    case "tool-errors":
      return "The last run ended with failing tools.";
    case null:
      return "Ready for the next instruction.";
  }
}
