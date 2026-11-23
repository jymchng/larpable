/**
 * Anthropic's Messages API (PRD §9.2, "Anthropic APIs").
 *
 * Anthropic differs from the OpenAI shape in ways that matter and cannot be papered over
 * by renaming fields:
 *
 * - the system prompt is a top-level `system` string, not a message;
 * - `max_tokens` is **required**;
 * - content is a list of blocks, and a tool call is a `tool_use` block whose `input` is
 *   already a JSON *object*, not a string;
 * - a tool result is a `tool_result` block inside a **user** message, and consecutive
 *   results belong in one message rather than one message each.
 *
 * All of that translation is here, so the loop above it never has to know which provider
 * it is talking to.
 */

import {
  LLMRequestError,
  type ChatMessage,
  type ConversationMessage,
  type GenerateOptions,
  type LLMProvider,
  type LLMResponse,
  type ToolCallRequest,
  type ToolDefinition,
} from "./types";
import { parsePayload, readSse } from "./sse";
import { describeFailure } from "./openai";

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  /** Default `https://api.anthropic.com/v1`. */
  baseUrl?: string;
  /** Required by the API. Default 8192, enough for a file plus a sentence. */
  maxTokens?: number;
  /** Pinned so behaviour does not change under the project. */
  version?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  temperature?: number;
}

interface AnthropicBlocks {
  type: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string; text?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly model: string;

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxTokens: number;
  readonly #version: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #temperature: number | undefined;

  constructor(options: AnthropicOptions) {
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.#maxTokens = options.maxTokens ?? 8192;
    this.#version = options.version ?? "2023-06-01";
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

    const translated = translateConversation(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: options.maxTokens ?? this.#maxTokens,
      messages: translated.messages,
      stream: true,
    };
    if (translated.system.length > 0) body.system = translated.system;
    if (tools.length > 0) {
      body.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }
    const temperature = options.temperature ?? this.#temperature;
    if (temperature !== undefined) body.temperature = temperature;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": this.#version,
          // Without this the API buffers the stream and streaming buys nothing.
          "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (signal.aborted) {
        throw new LLMRequestError(
          this.id,
          options.signal?.aborted === true ? "the request was cancelled" : "the request timed out",
        );
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new LLMRequestError(this.id, `could not reach the endpoint (${message})`);
    }

    if (!response.ok) {
      throw new LLMRequestError(this.id, await describeFailure(response), response.status);
    }
    if (response.body === null) {
      throw new LLMRequestError(this.id, "the response had no body");
    }

    const text: string[] = [];
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    let stopReason: string | null = null;
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;

    for await (const event of readSse(response.body)) {
      if ("done" in event) break;
      const chunk = parsePayload<AnthropicBlocks>(event.data);
      if (chunk === null) continue;

      if (chunk.type === "error") {
        throw new LLMRequestError(
          this.id,
          chunk.error?.message ?? "the provider reported an error mid-stream",
        );
      }

      if (chunk.type === "content_block_start") {
        const block = chunk.content_block;
        if (block?.type === "tool_use") {
          calls.set(chunk.index ?? 0, {
            id: block.id ?? "",
            name: block.name ?? "",
            arguments: "",
          });
        }
        if (block?.type === "text" && (block.text?.length ?? 0) > 0) {
          text.push(block.text ?? "");
          options.onText?.(block.text ?? "");
        }
        continue;
      }

      if (chunk.type === "content_block_delta") {
        const delta = chunk.delta;
        if (delta?.type === "text_delta" && (delta.text?.length ?? 0) > 0) {
          text.push(delta.text ?? "");
          options.onText?.(delta.text ?? "");
        }
        if (delta?.type === "input_json_delta") {
          const index = chunk.index ?? 0;
          const existing = calls.get(index) ?? { id: "", name: "", arguments: "" };
          calls.set(index, {
            ...existing,
            arguments: existing.arguments + (delta.partial_json ?? ""),
          });
        }
        continue;
      }

      if (chunk.type === "message_start" && chunk.message?.usage) {
        usage = {
          ...(chunk.message.usage.input_tokens === undefined
            ? {}
            : { inputTokens: chunk.message.usage.input_tokens }),
        };
        continue;
      }

      if (chunk.type === "message_delta") {
        if (chunk.delta?.stop_reason != null) stopReason = chunk.delta.stop_reason;
        if (chunk.usage?.output_tokens !== undefined) {
          usage = { ...(usage ?? {}), outputTokens: chunk.usage.output_tokens };
        }
      }
    }

    const toolCalls: ToolCallRequest[] = [...calls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id,
        name: call.name,
        // The API streams `input` as JSON fragments; an empty stream means "no arguments".
        arguments: call.arguments.length > 0 ? call.arguments : "{}",
      }));

    if (options.signal?.aborted === true) {
      return { text: text.join(""), toolCalls, finishReason: "cancelled" };
    }

    return {
      text: text.join(""),
      toolCalls,
      finishReason: mapStopReason(stopReason, toolCalls.length > 0),
      ...(usage === undefined ? {} : { usage }),
    };
  }
}

function mapStopReason(reason: string | null, hasToolCalls: boolean): LLMResponse["finishReason"] {
  if (hasToolCalls || reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  if (reason === "refusal") return "error";
  return "stop";
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Record<string, unknown>[];
}

/**
 * Turn the neutral conversation into Anthropic's `system` + `messages`.
 *
 * Consecutive tool results are merged into one user turn: the API expects a tool result
 * batch per assistant turn, and splitting them produces a 400 that reads like a model
 * problem rather than a translation one.
 */
export function translateConversation(messages: readonly ConversationMessage[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const system: string[] = [];
  const translated: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      system.push((message as ChatMessage).content);
      continue;
    }

    if (message.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      };
      const last = translated[translated.length - 1];
      if (last !== undefined && last.role === "user" && isToolResultOnly(last.content)) {
        last.content.push(block);
      } else {
        translated.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseInput(call.arguments),
        });
      }
      translated.push({ role: "assistant", content: blocks });
      continue;
    }

    translated.push({ role: "user", content: [{ type: "text", text: message.content }] });
  }

  return { system: system.join("\n\n"), messages: translated };
}

function isToolResultOnly(content: readonly Record<string, unknown>[]): boolean {
  return content.every((block) => block.type === "tool_result");
}

function parseInput(raw: string): Record<string, unknown> {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // A replayed, malformed call from history: the model will see `{}` and retry. The
    // alternative — throwing while translating history — would make one bad turn
    // permanently poison the conversation.
    return {};
  }
}
