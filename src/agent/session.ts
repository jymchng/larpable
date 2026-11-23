/**
 * A session: the thing a user talks to, which is one provider plus one guest plus one
 * conversation.
 *
 * `runAgentLoop` runs *a conversation turn*; it has no memory between calls and no opinion
 * about what the model should have been told. Everything a real session needs to add is
 * here, and each piece exists because of a specific way this product can lie to its user:
 *
 * - **The system prompt is built from the tools actually offered.** A prompt that lists a
 *   tool the session does not have teaches the model to call it (`src/agent/prompt.ts`), so
 *   the prompt and `toolsFor()` come from the same `ToolContext`.
 * - **The ports are decorated, not just passed.** `ensure_netlify_config` is the only thing
 *   that knows whether `netlify.toml` validated, and the model is the only thing that talks
 *   about it. The session records the result as it passes through, so the claims check at
 *   the end of the run is judging the reply against what the tool actually returned
 *   (`src/agent/claims.ts`).
 * - **Every run ends with that check.** `send()` returns `claims` alongside the loop's own
 *   result. The loop can only say *how* it stopped; only the session knows whether the
 *   reply's last paragraph is supported by the build history and the preview phase.
 *
 * What it deliberately is not: a React hook, or a singleton. The UI (goal #19) and the E2E
 * runs construct one of these each and drive it, so what a test asserts is what a user's
 * session runs.
 */

import type { ExecutionEnvironment } from "@/env/execution";
import type { BuildPort, NetlifyPort, PreviewPort, ToolContext, ToolOutputChunk } from "./tools/types";
import type { AgentTool } from "./tools/types";
import { toolsFor } from "./tools";
import { ProcessRegistry } from "./tools/processes";
import { runAgentLoop, type AgentEvent, type AgentRunResult } from "./loop";
import {
  buildEvidenceFrom,
  checkClaims,
  emptyEvidence,
  type ClaimCheck,
  type WorkflowEvidence,
} from "./claims";
import { buildSystemPrompt, type PromptProjectState } from "./prompt";
import type {
  ChatMessage,
  ConversationMessage,
  LLMProvider,
} from "@/llm/types";

export interface AgentSessionOptions {
  provider: LLMProvider;
  environment: ExecutionEnvironment;
  /** Guest-absolute project root. Defaults to the environment's workspace. */
  root?: string;
  build?: BuildPort | null;
  netlify?: NetlifyPort | null;
  preview?: PreviewPort | null;
  /** Shared with the shell tools. Default: a registry owned by this session. */
  processes?: ProcessRegistry;
  /** Override the tool set. Default: `toolsFor(context)`, i.e. capability-gated. */
  tools?: readonly AgentTool[];
  /** What is already known about the project, for the prompt. */
  project?: PromptProjectState;
  /** Extra instructions appended to the system prompt (a saved preference, a workflow note). */
  instructions?: string;
  /** Strings that must never reach the model, a tool result or the transcript. */
  secrets?: readonly string[];
  maxIterations?: number;
  turnTimeoutMs?: number;
  toolTimeoutMs?: number;
  providerRetries?: number;
  maxErrorIterations?: number;
  now?: () => number;
  onEvent?: (event: AgentEvent) => void;
  onOutput?: (chunk: ToolOutputChunk) => void;
}

export interface SendOptions {
  /** Cancels this turn and the tool work under it. */
  signal?: AbortSignal;
  /** Per-turn listener, in addition to the session's own. */
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentSessionResult extends AgentRunResult {
  /** The system prompt this run was given. */
  prompt: string;
  /** What the reply claimed against what the tools showed. */
  claims: ClaimCheck;
  /** The evidence the check used, so a caller can display it. */
  evidence: WorkflowEvidence;
}

export interface AgentSession {
  /** The context the tools receive. The UI reads `environment.snapshot()` from it. */
  readonly context: ToolContext;
  readonly systemPrompt: string;
  readonly tools: readonly AgentTool[];
  /** The conversation so far, without the system prompt. What a caller persists. */
  messages(): readonly ConversationMessage[];
  /** What the tools have shown about the project, as of now. */
  evidence(): WorkflowEvidence;
  /** Send a user turn. One at a time: a second concurrent call is a programming error. */
  send(prompt: string, options?: SendOptions): Promise<AgentSessionResult>;
  /** Forget the conversation, keeping the session, its ports and its guest. */
  reset(): void;
}

export function createAgentSession(options: AgentSessionOptions): AgentSession {
  const root = options.root ?? options.environment.workspacePath;
  const processes = options.processes ?? new ProcessRegistry();

  /**
   * The Netlify port, wrapped so the session knows what the tool last returned.
   *
   * `ToolContext` is what the tools see, so the wrapper has to be *in* the context rather
   * than beside it; and the wrapper has to be transparent, because `ensureNetlifyConfig`
   * returns the whole plan and the tool reports it verbatim.
   */
  let netlifyResult: { ok: boolean; errors: string[] } | null = null;
  const netlifySource = options.netlify ?? null;
  const netlifyPort: NetlifyPort | null =
    netlifySource === null
      ? null
      : {
          ensure: async (ensureOptions) => {
            const result = await netlifySource.ensure(ensureOptions);
            netlifyResult = {
              ok: result.ok,
              errors: result.validation.issues
                .filter((issue) => issue.severity === "error")
                .map((issue) => issue.message),
            };
            return result;
          },
        };

  const context: ToolContext = {
    environment: options.environment,
    root,
    build: options.build ?? null,
    netlify: netlifyPort,
    preview: options.preview ?? null,
    processes,
    ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput }),
  };

  const tools = options.tools ?? toolsFor(context);
  const systemPrompt = buildSystemPrompt({
    root,
    tools: tools.map((tool) => tool.definition),
    capabilities: {
      build: context.build !== null,
      netlify: context.netlify !== null,
      preview: context.preview !== null,
    },
    ...(options.project === undefined ? {} : { project: options.project }),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  });

  let history: ConversationMessage[] = [];
  let inFlight = false;

  function evidence(): WorkflowEvidence {
    const base = emptyEvidence();
    const preview = options.preview ?? null;
    const phase = preview === null ? null : preview.phase();
    return {
      build:
        options.build === null || options.build === undefined
          ? base.build
          : buildEvidenceFrom(options.build.history()),
      netlify:
        netlifyResult === null
          ? base.netlify
          : { attempted: true, ok: netlifyResult.ok, errors: netlifyResult.errors },
      preview:
        phase === null
          ? base.preview
          : {
              kind: phase.kind,
              buildId: phase.kind === "ready" ? phase.buildId : null,
            },
    };
  }

  return {
    context,
    systemPrompt,
    tools,

    messages() {
      return [...history];
    },

    evidence,

    async send(prompt: string, sendOptions: SendOptions = {}): Promise<AgentSessionResult> {
      if (inFlight) {
        throw new Error(
          "This session is already running a turn. Wait for it to finish: two turns at once would interleave tool calls on one guest.",
        );
      }
      inFlight = true;

      const user: ChatMessage = { role: "user", content: prompt };
      const system: ChatMessage = { role: "system", content: systemPrompt };
      const signal = sendOptions.signal;
      // The tools read the signal from the context, so the context has to carry the current
      // one. Cleared in `finally`: a stale signal would make the *next* turn abort at once.
      if (signal !== undefined) context.signal = signal;

      try {
        const result = await runAgentLoop({
          provider: options.provider,
          tools,
          context,
          messages: [system, ...history, user],
          ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
          ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
          ...(options.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
          ...(options.providerRetries === undefined
            ? {}
            : { providerRetries: options.providerRetries }),
          ...(options.maxErrorIterations === undefined
            ? {}
            : { maxErrorIterations: options.maxErrorIterations }),
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
          ...(signal === undefined ? {} : { signal }),
          onEvent: (event) => {
            options.onEvent?.(event);
            sendOptions.onEvent?.(event);
          },
        });

        // The system prompt is rebuilt on every run, so it is not part of the history: a
        // persisted transcript that carried it would pin an old prompt into the next turn.
        history = result.messages.filter((message) => message.role !== "system");

        const current = evidence();
        return {
          ...result,
          prompt: systemPrompt,
          evidence: current,
          claims: checkClaims(finalAssistantText(result), current),
        };
      } finally {
        inFlight = false;
        if (signal !== undefined) delete context.signal;
      }
    },

    reset() {
      history = [];
      netlifyResult = null;
    },
  };
}

/**
 * The assistant's last word.
 *
 * `AgentRunResult.text` accumulates every turn's text, including the "now let me install the
 * dependencies" that preceded a failure. The claims check is about what the user is left
 * with, so it reads the final assistant message with no tool calls — the reply — and falls
 * back to the accumulated text when a run ended before producing one.
 */
export function finalAssistantText(result: AgentRunResult): string {
  for (let index = result.messages.length - 1; index >= 0; index -= 1) {
    const message = result.messages[index];
    if (message?.role !== "assistant") continue;
    if ((message.toolCalls?.length ?? 0) > 0) continue;
    return message.content;
  }
  return result.text;
}
