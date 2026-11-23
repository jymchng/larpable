/**
 * What a tool is, and what it is allowed to touch (PRD §9.3).
 *
 * A tool is the only way the agent changes anything. The loop never runs a shell command
 * itself and never reads a file itself: it validates arguments and calls a tool. That
 * boundary is what makes the agent's behaviour auditable — every effect has a name, a
 * schema, and a result the model must read.
 *
 * Two deliberate restrictions:
 *
 * - **Tools cannot see the provider.** A tool receives an environment and ports, never an
 *   `LLMProvider`, so an API key cannot be reached from anything that writes into the
 *   guest. PRD §9.2 requires keys to stay outside the project and the guest; the shape of
 *   this context is half of how that is enforced (`tests/agent-tools.test.ts` asserts the
 *   other half).
 * - **Every result is text.** The model reads `content`; `data` exists for the UI and the
 *   tests. A tool cannot hand the model a live object it might then try to "edit".
 */

import type { ExecutionEnvironment } from "@/env/execution";
import type { BuildResult, InstallResult } from "@/build/manager";
import type { PreviewPhase } from "@/preview/controller";
import type { EnsureNetlifyConfigResult } from "@/netlify/flow";
import type { ToolDefinition } from "@/llm/types";
import type { ProcessRegistry } from "./processes";

/** The build manager, narrowed to what tools need. */
export interface BuildPort {
  install(options?: { signal?: AbortSignal }): Promise<InstallResult>;
  build(options?: { signal?: AbortSignal }): Promise<BuildResult>;
  lastSuccessfulBuild(): BuildResult | null;
  history(): readonly BuildResult[];
}

/** The Netlify flow (`src/netlify/flow.ts`), narrowed to the write-and-validate step. */
export interface NetlifyPort {
  ensure(options?: { root?: string }): Promise<EnsureNetlifyConfigResult>;
}

/** The preview controller, narrowed to what the agent can ask of it. */
export interface PreviewPort {
  refresh(buildId?: string): Promise<PreviewPhase>;
  url(): string | null;
  phase(): PreviewPhase;
}

export interface ToolOutputChunk {
  toolCallId: string;
  stream: "stdout" | "stderr";
  text: string;
}

export interface ToolContext {
  environment: ExecutionEnvironment;
  /** Guest-absolute project root, e.g. `/workspace`. */
  root: string;
  build: BuildPort | null;
  netlify: NetlifyPort | null;
  preview: PreviewPort | null;
  /** Commands started by this run, including ones still running in the background. */
  processes: ProcessRegistry;
  /** Streams a command's output to the caller while it runs. */
  onOutput?: (chunk: ToolOutputChunk) => void;
  /** Cancels long-running tools. Every tool must honour it. */
  signal?: AbortSignal;
  /** Id of the call this invocation belongs to, so streamed output can be attributed. */
  toolCallId?: string;
}

export interface ToolResult {
  ok: boolean;
  /** Plain text for the model. Bounded: a 5 MB file cannot be pasted into a prompt. */
  content: string;
  /** Structured detail for the UI and tests. Never sent to the model. */
  data?: unknown;
}

export interface AgentTool {
  readonly definition: ToolDefinition;
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

/** Construct a tool, keeping the definition and the implementation together. */
export function defineTool(
  definition: ToolDefinition,
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>,
): AgentTool {
  return { definition, run };
}

export function success(content: string, data?: unknown): ToolResult {
  return data === undefined ? { ok: true, content } : { ok: true, content, data };
}

export function failure(content: string, data?: unknown): ToolResult {
  return data === undefined ? { ok: false, content } : { ok: false, content, data };
}

/** How much of a command's or file's text a tool result may carry. */
export const TOOL_TEXT_LIMIT = 24_000;

/**
 * Cut text to `limit` characters, keeping the *tail*.
 *
 * Build logs put the error last, so the tail is the part worth keeping. Truncation is
 * always announced: a model that reads a silently shortened log will "fix" a problem that
 * was never in it.
 */
export function clampText(text: string, limit = TOOL_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  return `…[${String(text.length - limit)} characters cut]…\n${text.slice(text.length - limit)}`;
}
