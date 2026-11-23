/**
 * The tool-calling loop (PRD §9.4).
 *
 * The loop's job is narrow and it is worth stating, because it explains every guard here:
 * *the model decides, the loop executes, the model reads the result*. Nothing in this file
 * knows how to read a file, run a command or build a site. It validates arguments against
 * the tool's schema, calls the tool, and hands the outcome back as text. That is what makes
 * an agent's behaviour auditable — every effect has a name and a result the model had to
 * read.
 *
 * Six decisions are load-bearing:
 *
 * - **A model's mistakes are information, not exceptions.** Bad JSON, an unknown tool, a
 *   tool that fails: all become a `tool` message with `isError: true`, appended to the
 *   conversation, and the loop continues so the model can correct itself. Only transport
 *   failure, cancellation and the limits below stop the run.
 * - **Reads may overlap; writes may not.** `ToolDefinition.readOnly` is used, not guessed.
 *   Consecutive read-only calls run as one batch; a write is a batch of one, and batches run
 *   in the order the model asked for them, so a write can never overtake the read that
 *   informed it.
 * - **Every wait has a budget.** A provider turn and a tool call each get a timeout that
 *   aborts the underlying work; a tool that ignores its signal still cannot hang the run,
 *   because the loop stops waiting.
 * - **Iteration is capped.** A model that keeps calling tools is a bug or a loop, and the
 *   run ends with `iteration-limit` rather than burning the user's tokens forever.
 * - **A run reports how it stopped.** `complete`, `cancelled`, `timeout`, `provider-error`,
 *   `tool-errors`, `iteration-limit` — never a bare string the UI has to interpret.
 * - **Secrets are scrubbed on the way out.** Anything the caller declares secret is redacted
 *   from assistant text, tool results and errors before they reach the transcript, the UI or
 *   the model, so a key echoed by a provider cannot be persisted by accident.
 */

import { describeIssues, validateToolArguments } from "@/llm/schema";
import type {
  ConversationMessage,
  LLMResponse,
  LLMProvider,
  ToolCallRequest,
  TokenUsage,
} from "@/llm/types";
import { redactSecrets } from "@/llm/types";
import { clampText, type AgentTool, type ToolContext } from "./tools/types";

export type AgentStopReason =
  | "complete"
  | "iteration-limit"
  | "cancelled"
  | "timeout"
  | "provider-error"
  | "tool-errors";

/** Why a tool call did not produce a usable result. */
export type ToolFailureKind =
  | "unknown-tool"
  | "invalid-arguments"
  | "tool-error"
  | "timeout"
  | "cancelled"
  | "threw";

/** One tool call, from arguments to outcome. This is what the UI renders. */
export interface ToolExecution {
  id: string;
  name: string;
  /** True when this call shared a batch with other read-only calls. */
  parallel: boolean;
  ok: boolean;
  /** Exactly what the model was told. */
  content: string;
  data?: unknown;
  /** Null for success; otherwise what went wrong, in the loop's vocabulary. */
  error: ToolFailureKind | null;
  durationMs: number;
}

export type AgentEvent =
  | { type: "turn-start"; iteration: number }
  | { type: "text"; delta: string; iteration: number }
  | { type: "assistant"; text: string; toolCalls: readonly ToolCallRequest[]; iteration: number }
  | { type: "tool-start"; call: ToolCallRequest; iteration: number; parallel: boolean }
  | { type: "tool-output"; toolCallId: string; stream: "stdout" | "stderr"; text: string }
  | { type: "tool-end"; execution: ToolExecution; iteration: number }
  | { type: "retry"; iteration: number; attempt: number; reason: string }
  | { type: "stop"; reason: AgentStopReason; detail: string; iterations: number };

export interface AgentLoopOptions {
  provider: LLMProvider;
  tools: readonly AgentTool[];
  context: ToolContext;
  /** The conversation so far, usually starting with the system prompt. */
  messages?: readonly ConversationMessage[];
  /** Hard cap on provider turns. Default 24. */
  maxIterations?: number;
  /** Budget for one provider turn. Default 120 s. */
  turnTimeoutMs?: number;
  /** Budget for one tool call. Default 300 s (a cold install is minutes). */
  toolTimeoutMs?: number;
  /** Extra attempts after a transport failure. Default 1. */
  providerRetries?: number;
  /** Consecutive all-failed iterations before giving up. Default 3. */
  maxErrorIterations?: number;
  /** Cancels the run and the work under it. */
  signal?: AbortSignal;
  /** Live progress for the UI. */
  onEvent?: (event: AgentEvent) => void;
  /** Strings never to show or persist: an API key, a token. */
  secrets?: readonly string[];
  /** Injectable clock, so a test can assert durations without sleeping. */
  now?: () => number;
}

export interface AgentRunResult {
  stop: AgentStopReason;
  /** One sentence: why it stopped, in the product's voice. */
  reason: string;
  iterations: number;
  /** Assistant text, in order. */
  text: string;
  /** The full conversation, including tool results — what a caller persists. */
  messages: ConversationMessage[];
  executions: readonly ToolExecution[];
  usage: TokenUsage;
}

const DEFAULT_MAX_ITERATIONS = 24;
const DEFAULT_TURN_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_TIMEOUT_MS = 300_000;
const DEFAULT_PROVIDER_RETRIES = 1;
const DEFAULT_MAX_ERROR_ITERATIONS = 3;

/** Run the loop until the model stops asking for tools, or a limit is reached. */
export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentRunResult> {
  const maxIterations = Math.max(1, options.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const providerRetries = Math.max(0, options.providerRetries ?? DEFAULT_PROVIDER_RETRIES);
  const maxErrorIterations = Math.max(1, options.maxErrorIterations ?? DEFAULT_MAX_ERROR_ITERATIONS);
  const now = options.now ?? ((): number => Date.now());
  const scrub = (text: string): string =>
    options.secrets === undefined || options.secrets.length === 0
      ? text
      : redactSecrets(text, options.secrets);

  const registry = new Map<string, AgentTool>();
  for (const tool of options.tools) {
    const name = tool.definition.name;
    if (registry.has(name)) throw new Error(`Two tools are named ${JSON.stringify(name)}.`);
    registry.set(name, tool);
  }
  const definitions = options.tools.map((tool) => tool.definition);

  const messages: ConversationMessage[] = [...(options.messages ?? [])];
  const executions: ToolExecution[] = [];
  const usage: TokenUsage = {};
  const available = [...registry.keys()];
  let assistantText = "";
  let iterations = 0;
  let errorIterations = 0;

  const emit = (event: AgentEvent): void => {
    options.onEvent?.(event);
  };

  /**
   * Read through a function, not the options object directly.
   *
   * `options.signal?.aborted` narrowed by an early `return` would stay narrowed to `false`
   * for the rest of the function as far as the compiler is concerned, and TypeScript then
   * rejects the later checks as impossible. Cancellation genuinely changes between turns.
   */
  const aborted = (): boolean => options.signal?.aborted === true;

  const finish = (stop: AgentStopReason, reason: string): AgentRunResult => {
    emit({ type: "stop", reason: stop, detail: reason, iterations });
    return { stop, reason, iterations, text: assistantText, messages, executions, usage };
  };

  /**
   * Append a call's outcome to the conversation.
   *
   * Done by the caller, in call order, rather than inside `executeCall`: batched reads
   * finish in whatever order they finish, and a transcript whose tool results are shuffled
   * is harder to read back (and to feed to a provider) than one in the order asked for.
   */
  function pushResultMessage(execution: ToolExecution): void {
    messages.push({
      role: "tool",
      toolCallId: execution.id,
      name: execution.name,
      content: clampText(scrub(execution.content)),
      isError: !execution.ok,
    });
  }

  /**
   * Execute one tool call. Never throws: every outcome becomes a `ToolResult`.
   *
   * `executions` is appended in *completion* order, which is what the UI shows live and
   * what a test of parallel execution can assert on.
   */
  async function executeCall(
    call: ToolCallRequest,
    parallel: boolean,
    iteration: number,
  ): Promise<ToolExecution> {
    const startedAt = now();
    // The call's arguments are model output and are rendered by the UI, so they are
    // scrubbed on the way out too. The tool itself still receives the real arguments.
    const shownCall: ToolCallRequest = { ...call, arguments: scrub(call.arguments) };
    emit({ type: "tool-start", call: shownCall, iteration, parallel });

    const record = (execution: ToolExecution): ToolExecution => {
      // Scrubbed *before* it is stored or emitted: the UI renders this object, so a secret
      // that only disappeared from the transcript would still be on screen.
      const safe: ToolExecution = { ...execution, content: scrub(execution.content) };
      executions.push(safe);
      emit({ type: "tool-end", execution: safe, iteration });
      return safe;
    };

    const fail = (error: ToolFailureKind, content: string): ToolExecution =>
      record({
        id: call.id,
        name: call.name,
        parallel,
        ok: false,
        content,
        error,
        durationMs: now() - startedAt,
      });

    const tool = registry.get(call.name);
    if (tool === undefined) {
      return fail(
        "unknown-tool",
        `There is no tool named ${JSON.stringify(call.name)}. The tools available are: ${available.join(", ")}. Nothing was changed.`,
      );
    }

    const validation = validateToolArguments(tool.definition.parameters, call.arguments);
    if (!validation.ok) {
      return fail(
        "invalid-arguments",
        `${describeIssues(validation.issues)}\nNothing was changed. Call ${tool.definition.name} again with corrected arguments.`,
      );
    }

    const outcome = await raceWithBudget(
      async (signal) =>
        await tool.run(validation.value, {
          ...options.context,
          signal,
          toolCallId: call.id,
          onOutput: (chunk) => {
            emit({
              type: "tool-output",
              toolCallId: chunk.toolCallId.length === 0 ? call.id : chunk.toolCallId,
              stream: chunk.stream,
              text: scrub(chunk.text),
            });
          },
        }),
      toolTimeoutMs,
      options.signal,
    );

    switch (outcome.kind) {
      case "value": {
        const result = outcome.value;
        return record({
          id: call.id,
          name: call.name,
          parallel,
          ok: result.ok,
          content: result.content,
          ...(result.data === undefined ? {} : { data: result.data }),
          error: result.ok ? null : "tool-error",
          durationMs: now() - startedAt,
        });
      }
      case "timeout":
        return fail(
          "timeout",
          `\`${call.name}\` did not finish within ${String(toolTimeoutMs)} ms and was cancelled. Nothing else was changed by this call.`,
        );
      case "cancelled":
        return fail("cancelled", `\`${call.name}\` was cancelled before it finished.`);
      case "threw": {
        const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
        return fail("threw", `\`${call.name}\` failed unexpectedly: ${scrub(message)}`);
      }
    }
  }

  /** Group calls so consecutive read-only calls share one batch. */
  function groupCalls(calls: readonly ToolCallRequest[]): { parallel: boolean; calls: ToolCallRequest[] }[] {
    const groups: { parallel: boolean; calls: ToolCallRequest[] }[] = [];
    for (const call of calls) {
      const readOnly = registry.get(call.name)?.definition.readOnly === true;
      const last = groups[groups.length - 1];
      if (readOnly && last !== undefined && last.parallel) last.calls.push(call);
      else groups.push({ parallel: readOnly, calls: [call] });
    }
    return groups;
  }

  while (iterations < maxIterations) {
    if (aborted()) {
      return finish("cancelled", "The run was cancelled before the next turn.");
    }

    iterations += 1;
    emit({ type: "turn-start", iteration: iterations });

    const turn = await requestTurn();
    if (turn.kind === "cancelled") return finish("cancelled", "The model request was cancelled.");
    if (turn.kind === "timeout") {
      return finish(
        "timeout",
        `The model did not answer within ${String(turnTimeoutMs)} ms, so the run stopped.`,
      );
    }
    if (turn.kind === "error") {
      return finish("provider-error", `The model could not be reached: ${scrub(turn.message)}`);
    }

    const response = turn.response;
    if (response.usage?.inputTokens !== undefined) {
      usage.inputTokens = (usage.inputTokens ?? 0) + response.usage.inputTokens;
    }
    if (response.usage?.outputTokens !== undefined) {
      usage.outputTokens = (usage.outputTokens ?? 0) + response.usage.outputTokens;
    }

    const text = scrub(response.text);
    assistantText += text;
    const toolCalls = response.toolCalls;
    // Same reasoning as `shownCall`: the transcript is persisted and rendered, so a secret
    // echoed into an argument must not survive into the conversation.
    const shownCalls: ToolCallRequest[] = toolCalls.map((call) => ({
      ...call,
      arguments: scrub(call.arguments),
    }));
    messages.push({
      role: "assistant",
      content: text,
      ...(shownCalls.length === 0 ? {} : { toolCalls: shownCalls }),
    });
    emit({ type: "assistant", text, toolCalls: shownCalls, iteration: iterations });

    if (toolCalls.length === 0) {
      return finish(
        "complete",
        response.finishReason === "length"
          ? "The model stopped because it ran out of output tokens, not because it was finished."
          : "The model has finished: it asked for no more tools.",
      );
    }

    for (const group of groupCalls(toolCalls)) {
      if (aborted()) {
        // Record the calls the model asked for as cancelled rather than silently dropping
        // them: a transcript that loses tool calls cannot be replayed.
        for (const call of group.calls) {
          messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: `\`${call.name}\` was not run: the run was cancelled.`,
            isError: true,
          });
        }
        return finish("cancelled", "The run was cancelled while tools were running.");
      }

      const results = group.parallel
        ? await Promise.all(group.calls.map(async (call) => await executeCall(call, true, iterations)))
        : await (async (): Promise<ToolExecution[]> => {
            const sequential: ToolExecution[] = [];
            for (const call of group.calls) {
              sequential.push(await executeCall(call, false, iterations));
            }
            return sequential;
          })();

      // In call order, after the batch: a provider correlates by id, but a transcript read
      // by a person should follow the order the model asked in.
      for (const result of results) pushResultMessage(result);

      const anyOk = results.some((result) => result.ok);
      errorIterations = anyOk ? 0 : errorIterations + 1;
      if (errorIterations >= maxErrorIterations) {
        return finish(
          "tool-errors",
          `Tools failed ${String(errorIterations)} turns in a row, so the run stopped rather than repeating itself.`,
        );
      }

      if (aborted()) {
        return finish("cancelled", "The run was cancelled while tools were running.");
      }
    }
  }

  return finish(
    "iteration-limit",
    `The run reached its limit of ${String(maxIterations)} turns without a final answer.`,
  );

  /**
   * One provider turn, with the turn budget and one retry for a transport failure.
   *
   * The retry is for flakiness (a dropped connection), not for a model that answers
   * badly: a bad answer is handled by the tools' error messages and the next turn.
   */
  async function requestTurn(): Promise<
    | { kind: "response"; response: LLMResponse }
    | { kind: "cancelled" }
    | { kind: "timeout" }
    | { kind: "error"; message: string }
  > {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await raceWithBudget(
        async (signal) =>
          await options.provider.generate(messages, definitions, {
            signal,
            timeoutMs: turnTimeoutMs,
            onText: (delta) => {
              emit({ type: "text", delta: scrub(delta), iteration: iterations });
            },
          }),
        turnTimeoutMs,
        options.signal,
      );

      switch (outcome.kind) {
        case "value":
          return { kind: "response", response: outcome.value };
        case "cancelled":
          return { kind: "cancelled" };
        case "timeout":
          return { kind: "timeout" };
        case "threw": {
          const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
          if (attempt >= providerRetries) return { kind: "error", message };
          emit({ type: "retry", iteration: iterations, attempt: attempt + 1, reason: scrub(message) });
        }
      }
    }
  }
}

/** How a budgeted call ended. */
type BudgetOutcome<T> =
  | { kind: "value"; value: T }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "threw"; error: unknown };

/**
 * Run `work` with a timeout and a parent cancellation signal.
 *
 * The important property is that it always settles, even when the work ignores its signal:
 * a tool that never returns must cost the run one timeout, not the whole session. The work
 * is left running in the background and its late rejection is swallowed — there is nobody
 * left to tell.
 */
async function raceWithBudget<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent: AbortSignal | undefined,
): Promise<BudgetOutcome<T>> {
  const controller = new AbortController();
  let verdict: "timeout" | "cancelled" | null = null;
  let decided = false;

  const abortWith = (kind: "timeout" | "cancelled"): void => {
    if (verdict !== null) return;
    verdict = kind;
    controller.abort();
  };

  const onParentAbort = (): void => {
    abortWith("cancelled");
  };
  if (parent !== undefined) parent.addEventListener("abort", onParentAbort, { once: true });

  const stopped = new Promise<BudgetOutcome<T>>((resolve) => {
    controller.signal.addEventListener(
      "abort",
      () => {
        decided = true;
        resolve({ kind: verdict ?? "cancelled" });
      },
      { once: true },
    );
  });

  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          abortWith("timeout");
        }, timeoutMs)
      : undefined;

  if (parent?.aborted === true) abortWith("cancelled");

  const settled = (async (): Promise<BudgetOutcome<T>> => {
    try {
      const value = await work(controller.signal);
      return decided ? { kind: verdict ?? "cancelled" } : { kind: "value", value };
    } catch (error) {
      return decided ? { kind: verdict ?? "cancelled" } : { kind: "threw", error };
    }
  })();

  try {
    return await Promise.race([settled, stopped]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
    // A tool that ignored the signal may still reject later; that is not this call's news.
    settled.catch(() => undefined);
  }
}
