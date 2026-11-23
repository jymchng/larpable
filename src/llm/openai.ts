/**
 * The OpenAI Chat Completions wire format, which most hosted models and every local
 * runner (llama.cpp, Ollama, LM Studio, vLLM) speak (PRD §9.2, "OpenAI-compatible APIs").
 *
 * Two things are computed here rather than left to callers:
 *
 * - **message translation.** Our conversation model is provider-neutral: assistant turns
 *   carry `toolCalls`, tool results are their own role. This file is the only place that
 *   knows OpenAI wants `tool_calls[].function.arguments` as a string and tool results as
 *   `role: "tool"` with a `tool_call_id`.
 * - **failure shape.** A non-2xx response becomes `LLMRequestError` with the status and
 *   the body's own message, truncated. The API key is never part of any message, because
 *   an error string ends up in a log and, from there, in a UI the user may screenshot.
 */

import {
  LLMRequestError,
  type ConversationMessage,
  type GenerateOptions,
  type LLMProvider,
  type LLMResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from "./types";
import { parsePayload, readSse } from "./sse";

export interface OpenAICompatibleOptions {
  apiKey: string;
  model: string;
  /** Base URL including the API version, e.g. `https://api.openai.com/v1`. */
  baseUrl?: string;
  /** Provider id for logs; `openai` by default, e.g. `ollama` for a local endpoint. */
  id?: string;
  /** Injected for tests; defaults to the platform fetch. */
  fetch?: typeof fetch;
  /** Request budget. A model that never answers must not hang the agent. */
  timeoutMs?: number;
  /** Sent as `temperature` when set. Left out otherwise, so provider defaults apply. */
  temperature?: number;
}

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIStreamChunk {
  choices?: {
    delta?: { content?: string | null; tool_calls?: OpenAIToolCallDelta[] };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIBody {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCallRequest[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly model: string;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #temperature: number | undefined;

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.id ?? "openai";
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#temperature = options.temperature;
  }

  async generate(
    messages: readonly ConversationMessage[],
    tools: readonly ToolDefinition[],
    options: GenerateOptions = {},
  ): Promise<LLMResponse> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    const temperature = options.temperature ?? this.#temperature;
    if (temperature !== undefined) body.temperature = temperature;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      throw this.#transportError(cause, options.signal);
    }

    if (!response.ok) {
      throw new LLMRequestError(this.id, await describeFailure(response), response.status);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || response.body === null) {
      return this.#readWholeBody(response, options);
    }

    const text: string[] = [];
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: string | null = null;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;

    for await (const event of readSse(response.body)) {
      if ("done" in event) break;
      const chunk = parsePayload<OpenAIStreamChunk>(event.data);
      if (chunk === null) continue;

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content != null && delta.content.length > 0) {
        text.push(delta.content);
        options.onText?.(delta.content);
      }
      for (const call of delta?.tool_calls ?? []) {
        const index = call.index ?? 0;
        const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
        calls.set(index, {
          id: call.id ?? existing.id,
          name: call.function?.name ?? existing.name,
          arguments: existing.arguments + (call.function?.arguments ?? ""),
        });
      }
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          ...(chunk.usage.prompt_tokens === undefined
            ? {}
            : { inputTokens: chunk.usage.prompt_tokens }),
          ...(chunk.usage.completion_tokens === undefined
            ? {}
            : { outputTokens: chunk.usage.completion_tokens }),
        };
      }
    }

    if (options.signal?.aborted === true) {
      return {
        text: text.join(""),
        toolCalls: [...calls.values()].map(toToolCall),
        finishReason: "cancelled",
      };
    }

    const toolCalls = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => toToolCall(call));

    return {
      text: text.join(""),
      toolCalls,
      finishReason: mapFinishReason(finishReason, toolCalls.length > 0),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  /** Some compatible servers ignore `stream: true`; reading the JSON body is cheaper than failing. */
  async #readWholeBody(response: Response, options: GenerateOptions): Promise<LLMResponse> {
    const payload = (await response.json().catch(() => null)) as OpenAIBody | null;
    if (payload === null) {
      throw new LLMRequestError(this.id, "the response was neither an SSE stream nor JSON");
    }
    const choice = payload.choices?.[0];
    const text = choice?.message?.content ?? "";
    if (text.length > 0) options.onText?.(text);
    const toolCalls = choice?.message?.tool_calls ?? [];
    return {
      text,
      toolCalls,
      finishReason: mapFinishReason(choice?.finish_reason ?? null, toolCalls.length > 0),
      ...(payload.usage === undefined
        ? {}
        : {
            usage: {
              ...(payload.usage.prompt_tokens === undefined
                ? {}
                : { inputTokens: payload.usage.prompt_tokens }),
              ...(payload.usage.completion_tokens === undefined
                ? {}
                : { outputTokens: payload.usage.completion_tokens }),
            },
          }),
    };
  }

  #transportError(cause: unknown, signal: AbortSignal | undefined): LLMRequestError {
    if (signal?.aborted === true) {
      return new LLMRequestError(this.id, "the request was cancelled");
    }
    if (cause instanceof Error && cause.name === "TimeoutError") {
      return new LLMRequestError(this.id, `no response within ${String(this.#timeoutMs)} ms`);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    return new LLMRequestError(this.id, `could not reach the endpoint (${message})`);
  }
}

function toToolCall(call: { id: string; name: string; arguments: string }): ToolCallRequest {
  return { id: call.id, name: call.name, arguments: call.arguments };
}

function toOpenAIMessage(message: ConversationMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    };
  }
  if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): LLMResponse["finishReason"] {
  if (hasToolCalls) return "tool_calls";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "error";
  return "stop";
}

/** Status plus the provider's own explanation, cut short. Never includes the request headers. */
export async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const detail = extractMessage(body);
  const suffix = detail === null ? "" : ` — ${detail}`;
  return `HTTP ${String(response.status)}${suffix}`;
}

function extractMessage(body: string): string | null {
  if (body.trim().length === 0) return null;
  const parsed = ((): unknown => {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  })();

  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string") return truncate(message);
    }
    if (typeof record.message === "string") return truncate(record.message);
    if (typeof error === "string") return truncate(error);
  }
  return truncate(body);
}

function truncate(value: string, limit = 300): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}
