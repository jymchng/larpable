/**
 * A provider that answers from a script (PRD §9.2's third case, and §18's "deterministic
 * mock provider").
 *
 * This is not a stub for the real thing: it is the provider the test suite and the
 * no-key demo run on, and it has to be *exactly* reproducible — same turns, same tool
 * call ids, same text — or a test that asserts "this conversation produced these tool
 * calls" is only asserting that it ran once.
 *
 * It is also the provider that makes the loop testable at all. A real model decides what
 * to do next; the loop's job is to execute what it decided and feed the result back. By
 * scripting the decisions, the loop's own behaviour — sequencing, parallel reads,
 * validation, cancellation, iteration limits — becomes observable.
 */

import type {
  ConversationMessage,
  FinishReason,
  GenerateOptions,
  LLMProvider,
  LLMResponse,
  ToolCallRequest,
  ToolDefinition,
  TokenUsage,
} from "./types";

/** One tool call a turn asks for. `arguments` is an object here; it is serialised for the model. */
export interface MockToolCall {
  name: string;
  arguments?: Record<string, unknown>;
  /** Overrides the deterministic id, for tests that need to match a specific call. */
  id?: string;
  /** Raw argument string, for tests that need the model to emit broken JSON. */
  rawArguments?: string;
}

export interface MockTurn {
  text?: string;
  toolCalls?: readonly MockToolCall[];
  /** Defaults to `tool_calls` when there are tool calls, otherwise `stop`. */
  finishReason?: FinishReason;
  usage?: TokenUsage;
  /** Simulate a transport failure on this turn. */
  error?: string;
}

/** What the loop asked the provider, for assertions. */
export interface MockRequest {
  messages: readonly ConversationMessage[];
  tools: readonly ToolDefinition[];
  turn: number;
}

export interface MockProviderOptions {
  turns: readonly MockTurn[];
  model?: string;
  /** How many times a turn is repeated once the script runs out. Default 0 (stop). */
  repeatLast?: number;
}

export class MockProvider implements LLMProvider {
  readonly id = "mock";
  readonly model: string;
  /** Every request the provider received, in order. */
  readonly requests: MockRequest[] = [];

  readonly #turns: readonly MockTurn[];
  readonly #repeatLast: number;
  #turn = 0;

  constructor(options: MockProviderOptions) {
    this.#turns = options.turns;
    this.model = options.model ?? "mock-1";
    this.#repeatLast = options.repeatLast ?? 0;
  }

  /** How many scripted turns are left. The loop's iteration limit is not this. */
  get remaining(): number {
    return Math.max(0, this.#turns.length - this.#turn);
  }

  async generate(
    messages: readonly ConversationMessage[],
    tools: readonly ToolDefinition[],
    options: GenerateOptions = {},
  ): Promise<LLMResponse> {
    const turnIndex = this.#turn;
    this.requests.push({ messages: [...messages], tools: [...tools], turn: turnIndex });

    if (options.signal?.aborted === true) {
      const error = new Error("The request was cancelled before it was sent.");
      error.name = "AbortError";
      throw error;
    }

    const turn = this.#turnFor(turnIndex);
    this.#turn += 1;

    if (turn?.error !== undefined) {
      throw new Error(turn.error);
    }

    const text = turn?.text ?? "";
    if (text.length > 0) options.onText?.(text);

    const toolCalls: ToolCallRequest[] = (turn?.toolCalls ?? []).map((call, index) => ({
      id: call.id ?? `mock-${String(turnIndex)}-${String(index)}`,
      name: call.name,
      arguments: call.rawArguments ?? JSON.stringify(call.arguments ?? {}),
    }));

    return {
      text,
      toolCalls,
      finishReason:
        turn?.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
      ...(turn?.usage === undefined ? {} : { usage: turn.usage }),
      raw: { mockTurn: turnIndex },
    };
  }

  #turnFor(index: number): MockTurn | undefined {
    const scripted = this.#turns[index];
    if (scripted !== undefined) return scripted;
    if (this.#repeatLast > 0 && this.#turns.length > 0) {
      const last = this.#turns[this.#turns.length - 1];
      if (index < this.#turns.length + this.#repeatLast) return last;
    }
    return undefined;
  }
}
