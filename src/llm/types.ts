/**
 * The provider boundary for the agent (PRD §9.2).
 *
 * Everything above this file — the loop, the tools, the UI — speaks these types and
 * nothing else. That is what makes three very different backends interchangeable: an
 * OpenAI-compatible endpoint, Anthropic's Messages API, and a scripted mock that runs
 * the whole product in tests with no key and no network.
 *
 * Two decisions worth knowing:
 *
 * - **Tool arguments travel as a JSON string.** Models emit arguments as text, and a
 *   model can emit broken JSON. Keeping the string here means the loop, not the
 *   transport, decides what a malformed call means: it becomes a tool error the model
 *   can read and correct, instead of an exception that ends the run.
 * - **`raw` is diagnostics, not state.** Provider payloads are kept for debugging and
 *   are never written into the project, never sent to the guest, and never persisted.
 */

/** Who said a message. `tool` is a tool result being handed back to the model. */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** A tool the model asked for. `arguments` is the raw JSON string the model emitted. */
export interface ToolCallRequest {
  /** Provider-assigned id, echoed back with the result so the model can match them. */
  id: string;
  name: string;
  arguments: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Assistant turns only: the tools it asked for. */
  toolCalls?: readonly ToolCallRequest[];
}

/** A tool result, in the shape every provider accepts as a follow-on turn. */
export interface ToolResultMessage {
  role: "tool";
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
}

export type ConversationMessage = ChatMessage | ToolResultMessage;

/** The subset of JSON Schema the tools use. Small on purpose: it is easy to validate. */
export type ToolParameterSchema =
  | {
      type: "string";
      description: string;
      enum?: readonly string[];
      minLength?: number;
      maxLength?: number;
    }
  | { type: "integer"; description: string; minimum?: number; maximum?: number }
  | { type: "number"; description: string; minimum?: number; maximum?: number }
  | { type: "boolean"; description: string }
  | {
      type: "array";
      description: string;
      items: ToolParameterSchema;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: "object";
      description: string;
      properties: Record<string, ToolParameterSchema>;
      required?: readonly string[];
    };

/**
 * How a tool is described to a model.
 *
 * `readOnly` is not documentation: the loop uses it to decide what may run in parallel
 * (PRD §9.4, "safe parallel read-only operations"). Two writes racing over the same file
 * is a bug; two reads are fine.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
  readOnly: boolean;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "cancelled" | "error";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LLMResponse {
  /** Assistant text, with any streamed deltas already applied. */
  text: string;
  toolCalls: readonly ToolCallRequest[];
  finishReason: FinishReason;
  usage?: TokenUsage;
  /** Provider payload, for debugging only. Never persisted or sent to the guest. */
  raw?: unknown;
}

export interface GenerateOptions {
  /** Cancels the request. Providers must abort the underlying fetch. */
  signal?: AbortSignal;
  /** Called as text arrives, so the UI can stream instead of waiting. */
  onText?: (delta: string) => void;
  /** Per-request cap on generated tokens, when the provider supports it. */
  maxTokens?: number;
  temperature?: number;
  /** Request timeout. Providers abort the fetch rather than hanging the loop. */
  timeoutMs?: number;
}

/**
 * PRD §9.2's interface, with options and a model id added.
 *
 * `generate` rejects only for transport problems (network, auth, malformed payload).
 * Everything a model can do *wrong* — bad arguments, an unknown tool — is handled above
 * this layer, because it is information for the model, not a fault of the provider.
 */
export interface LLMProvider {
  /** Stable id for logs and settings, e.g. `openai`, `anthropic`, `mock`. */
  readonly id: string;
  /** Model identifier as sent to the API. */
  readonly model: string;
  generate(
    messages: readonly ConversationMessage[],
    tools: readonly ToolDefinition[],
    options?: GenerateOptions,
  ): Promise<LLMResponse>;
}

/** Raised for transport-level provider failures. Never carries the API key. */
export class LLMRequestError extends Error {
  readonly provider: string;
  /** HTTP status when there was a response body to read. */
  readonly status: number | null;

  constructor(provider: string, message: string, status: number | null = null) {
    super(`${provider}: ${message}`);
    this.name = "LLMRequestError";
    this.provider = provider;
    this.status = status;
  }
}

/**
 * Remove secrets from text before it is logged, streamed into the UI, or handed to a
 * tool result.
 *
 * The API key never belongs in the guest or in a project file, and the cheapest way to
 * keep that promise is to make it impossible for the key to appear in the strings that
 * travel that way — including by accident, when a provider echoes a header in an error.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    result = result.split(secret).join("[redacted]");
  }
  return result;
}
