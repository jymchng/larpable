/**
 * The tool-calling loop, driven by the scripted provider (PRD §9.4).
 *
 * These tests exist because the loop is where an agent's failure modes live, and none of
 * them is a transport problem:
 *
 * - the model asks for a tool with arguments that do not parse;
 * - the tool fails, and the model has to be told in a way it can act on;
 * - the model keeps asking for tools forever;
 * - the user cancels half-way through, and the transcript must still make sense;
 * - two calls in one turn are read-only and could overlap, or write and must not.
 *
 * Scripting the decisions (`MockProvider`) is what makes the loop's *own* behaviour
 * observable: a real model would hide which of these happened.
 */

import { describe, expect, it } from "vitest";

import { FakeEnvironment } from "../src/env/fake-environment";
import { MockProvider, type MockTurn } from "../src/llm/mock";
import { ProcessRegistry } from "../src/agent/tools/processes";
import { defineTool, success, failure, type AgentTool, type ToolContext } from "../src/agent/tools/types";
import { FILESYSTEM_TOOLS } from "../src/agent/tools/fs";
import { runAgentLoop, type AgentEvent, type AgentRunResult } from "../src/agent/loop";

/** An environment that is ready, so tools may run. */
async function readyEnvironment(tree: Record<string, string> = {}): Promise<FakeEnvironment> {
  const environment = new FakeEnvironment({ tree });
  await environment.initialize();
  return environment;
}

function contextFor(environment: FakeEnvironment, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    environment,
    root: environment.workspacePath,
    build: null,
    netlify: null,
    preview: null,
    processes: new ProcessRegistry(),
    ...overrides,
  };
}

/** A tool with no arguments whose behaviour the test supplies. */
function probeTool(
  name: string,
  readOnly: boolean,
  run: () => Promise<ReturnType<typeof success>>,
): AgentTool {
  return defineTool(
    {
      name,
      description: `test tool ${name}`,
      readOnly,
      parameters: { type: "object", description: `${name} arguments`, properties: {}, required: [] },
    },
    run,
  );
}

async function run(
  turns: readonly MockTurn[],
  options: {
    tools?: readonly AgentTool[];
    context?: ToolContext;
    maxIterations?: number;
    toolTimeoutMs?: number;
    providerRetries?: number;
    secrets?: readonly string[];
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void;
  } = {},
): Promise<{ result: AgentRunResult; provider: MockProvider; events: AgentEvent[] }> {
  const provider = new MockProvider({ turns });
  const events: AgentEvent[] = [];
  const environment = options.context ?? contextFor(await readyEnvironment());
  const result = await runAgentLoop({
    provider,
    tools: options.tools ?? FILESYSTEM_TOOLS,
    context: environment,
    ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
    ...(options.toolTimeoutMs === undefined ? {} : { toolTimeoutMs: options.toolTimeoutMs }),
    ...(options.providerRetries === undefined ? {} : { providerRetries: options.providerRetries }),
    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onEvent: (event) => {
      events.push(event);
      options.onEvent?.(event);
    },
  });
  return { result, provider, events };
}

describe("runAgentLoop", () => {
  it("runs a single tool call and reports the model's final answer", async () => {
    const environment = await readyEnvironment();
    const { result, provider } = await run(
      [
        {
          toolCalls: [
            { name: "write_file", arguments: { path: "index.html", content: "<h1>hello</h1>" } },
          ],
        },
        { text: "Created index.html." },
      ],
      { context: contextFor(environment), tools: FILESYSTEM_TOOLS },
    );

    expect(result.stop).toBe("complete");
    expect(result.iterations).toBe(2);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]?.ok).toBe(true);
    expect(result.executions[0]?.error).toBeNull();
    expect(result.text).toContain("Created index.html.");

    const written = environment.workspace().readFile("/index.html");
    expect(new TextDecoder().decode(written)).toBe("<h1>hello</h1>");

    // The conversation is usable as history: assistant call, tool result, final answer.
    expect(result.messages.map((message) => message.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
    const toolMessage = result.messages[1];
    expect(toolMessage?.role === "tool" && toolMessage.toolCallId).toBe("mock-0-0");
    expect(toolMessage?.role === "tool" && toolMessage.isError).toBe(false);

    // The second request carried the tool result, so the model could react to it.
    expect(provider.requests).toHaveLength(2);
    const secondTurn = provider.requests[1];
    expect(secondTurn?.messages.some((message) => message.role === "tool")).toBe(true);
    // And it was offered the tools, with their schemas.
    expect(secondTurn?.tools.map((tool) => tool.name)).toContain("write_file");
  });

  it("runs several calls from one turn and reports every result", async () => {
    const environment = await readyEnvironment();
    const { result } = await run(
      [
        {
          toolCalls: [
            { name: "write_file", arguments: { path: "a.txt", content: "A" } },
            { name: "write_file", arguments: { path: "b.txt", content: "B" } },
          ],
        },
        { text: "both written" },
      ],
      { context: contextFor(environment) },
    );

    expect(result.stop).toBe("complete");
    expect(result.executions.map((execution) => execution.ok)).toEqual([true, true]);
    const files = environment.calls.filter((call) => call.method === "writeFile");
    expect(files.map((call) => call.method === "writeFile" && call.path)).toEqual([
      "/workspace/a.txt",
      "/workspace/b.txt",
    ]);
    // Writes never share a batch.
    expect(result.executions.every((execution) => !execution.parallel)).toBe(true);
    // Both results were handed back, in the order asked for.
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  it("overlaps read-only calls in one batch but never a write", async () => {
    let active = 0;
    let readsPeak = 0;
    let writesPeak = 0;

    const slowRead = defineTool(
      {
        name: "slow_read",
        description: "reads slowly",
        readOnly: true,
        parameters: { type: "object", description: "args", properties: {}, required: [] },
      },
      async () => {
        active += 1;
        readsPeak = Math.max(readsPeak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return success("read");
      },
    );

    const slowWrite = defineTool(
      {
        name: "slow_write",
        description: "writes slowly",
        readOnly: false,
        parameters: { type: "object", description: "args", properties: {}, required: [] },
      },
      async () => {
        active += 1;
        writesPeak = Math.max(writesPeak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return success("written");
      },
    );

    const { result } = await run(
      [
        { toolCalls: [{ name: "slow_read" }, { name: "slow_read" }] },
        { toolCalls: [{ name: "slow_write" }, { name: "slow_write" }] },
        { text: "done" },
      ],
      { tools: [slowRead, slowWrite], context: contextFor(await readyEnvironment()) },
    );

    expect(result.stop).toBe("complete");
    expect(readsPeak).toBe(2);
    expect(writesPeak).toBe(1);
    expect(result.executions.filter((execution) => execution.parallel)).toHaveLength(2);
  });

  it("turns unparsable arguments into a correctable error, not a crash", async () => {
    const environment = await readyEnvironment();
    const { result, provider } = await run(
      [
        { toolCalls: [{ name: "write_file", rawArguments: '{"path": ' }] },
        { toolCalls: [{ name: "write_file", arguments: { path: "index.html", content: "ok" } }] },
        { text: "fixed it" },
      ],
      { context: contextFor(environment) },
    );

    expect(result.stop).toBe("complete");
    const failed = result.executions[0];
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toBe("invalid-arguments");
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.content).toContain("not valid JSON");
    expect(toolMessage?.role === "tool" && toolMessage.isError).toBe(true);

    // Nothing was written by the broken call; the corrected one worked.
    expect(result.executions[1]?.ok).toBe(true);
    expect(provider.requests).toHaveLength(3);
  });

  it("hands a tool failure back to the model instead of ending the run", async () => {
    const environment = await readyEnvironment();
    const { result } = await run(
      [
        { toolCalls: [{ name: "write_file", arguments: { path: "../escape.txt", content: "no" } }] },
        { toolCalls: [{ name: "write_file", arguments: { path: "safe.txt", content: "yes" } }] },
        { text: "used a safe path" },
      ],
      { context: contextFor(environment) },
    );

    expect(result.stop).toBe("complete");
    expect(result.executions[0]?.error).toBe("tool-error");
    expect(result.executions[0]?.content).toContain("workspace");
    expect(result.executions[1]?.ok).toBe(true);
    expect(new TextDecoder().decode(environment.workspace().readFile("/safe.txt"))).toBe(
      "yes",
    );
  });

  it("names an unknown tool and lists the ones that exist", async () => {
    const { result } = await run(
      [{ toolCalls: [{ name: "rm_rf" }] }, { text: "sorry" }],
      { context: contextFor(await readyEnvironment()) },
    );

    expect(result.stop).toBe("complete");
    expect(result.executions[0]?.error).toBe("unknown-tool");
    expect(result.executions[0]?.content).toContain("rm_rf");
    expect(result.executions[0]?.content).toContain("write_file");
  });

  it("stops at the iteration limit instead of looping forever", async () => {
    const looping = new MockProvider({
      turns: [{ toolCalls: [{ name: "probe" }] }],
      repeatLast: 100,
    });
    const events: AgentEvent[] = [];
    const result = await runAgentLoop({
      provider: looping,
      tools: [probeTool("probe", true, async () => success("again"))],
      context: contextFor(await readyEnvironment()),
      maxIterations: 3,
      onEvent: (event) => events.push(event),
    });

    expect(result.stop).toBe("iteration-limit");
    expect(result.iterations).toBe(3);
    expect(looping.requests).toHaveLength(3);
    expect(result.reason).toContain("3");
    expect(events.at(-1)?.type).toBe("stop");
  });

  it("cancels mid-run and keeps a transcript that still makes sense", async () => {
    const controller = new AbortController();
    const environment = await readyEnvironment();

    const { result } = await run(
      [
        { toolCalls: [{ name: "write_file", arguments: { path: "a.txt", content: "A" } }] },
        { text: "never reached" },
      ],
      {
        context: contextFor(environment),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "tool-start") controller.abort();
        },
      },
    );

    expect(result.stop).toBe("cancelled");
    expect(result.iterations).toBe(1);
    expect(result.executions[0]?.error).toBe("cancelled");
    // The assistant turn and a matching tool result are both present.
    expect(result.messages.map((message) => message.role)).toEqual(["assistant", "tool"]);
    expect(result.messages[1]?.role === "tool" && result.messages[1].isError).toBe(true);
  });

  it("times out a tool that ignores its signal and carries on", async () => {
    const stuck = defineTool(
      {
        name: "stuck",
        description: "never returns",
        readOnly: true,
        parameters: { type: "object", description: "args", properties: {}, required: [] },
      },
      // Deliberately ignores the signal: the loop must not depend on good behaviour.
      async () => await new Promise<ReturnType<typeof success>>(() => undefined),
    );

    const { result } = await run(
      [{ toolCalls: [{ name: "stuck" }] }, { text: "gave up on that" }],
      {
        tools: [stuck],
        context: contextFor(await readyEnvironment()),
        toolTimeoutMs: 20,
      },
    );

    expect(result.stop).toBe("complete");
    expect(result.executions[0]?.error).toBe("timeout");
    expect(result.text).toContain("gave up");
  });

  it("retries a transport failure once and then finishes", async () => {
    const { result, events } = await run(
      [{ error: "connection reset by peer" }, { text: "recovered" }],
      { context: contextFor(await readyEnvironment()) },
    );

    expect(result.stop).toBe("complete");
    expect(result.text).toBe("recovered");
    expect(events.some((event) => event.type === "retry")).toBe(true);
  });

  it("stops with provider-error when the retry also fails", async () => {
    const { result } = await run(
      [{ error: "the endpoint is unreachable" }],
      { context: contextFor(await readyEnvironment()), providerRetries: 0 },
    );

    expect(result.stop).toBe("provider-error");
    expect(result.reason).toContain("unreachable");
  });

  it("gives up after repeated all-failed turns rather than repeating itself", async () => {
    const { result } = await run(
      [
        { toolCalls: [{ name: "write_file", arguments: { path: "../a", content: "x" } }] },
        { toolCalls: [{ name: "write_file", arguments: { path: "../b", content: "x" } }] },
        { toolCalls: [{ name: "write_file", arguments: { path: "../c", content: "x" } }] },
      ],
      { context: contextFor(await readyEnvironment()) },
    );

    expect(result.stop).toBe("tool-errors");
    expect(result.iterations).toBe(3);
  });

  it("streams assistant text as it arrives", async () => {
    const { result, events } = await run([{ text: "working on it" }], {
      context: contextFor(await readyEnvironment()),
    });

    expect(result.text).toBe("working on it");
    const deltas = events.filter((event) => event.type === "text");
    expect(deltas).toHaveLength(1);
    expect(events.some((event) => event.type === "assistant")).toBe(true);
  });

  it("redacts declared secrets from text, tool results and messages", async () => {
    const secret = "sk-test-0123456789abcdef";
    const leaky = defineTool(
      {
        name: "leaky",
        description: "returns a secret by accident",
        readOnly: true,
        parameters: { type: "object", description: "args", properties: {}, required: [] },
      },
      async () => success(`the key is ${secret}`),
    );

    const { result, events } = await run(
      [{ toolCalls: [{ name: "leaky" }] }, { text: `and also ${secret}` }],
      { tools: [leaky], context: contextFor(await readyEnvironment()), secrets: [secret] },
    );

    // The execution record is what the UI renders, so it is scrubbed too.
    expect(result.executions[0]?.content).not.toContain(secret);
    expect(result.executions[0]?.content).toContain("[redacted]");
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.role === "tool" && toolMessage.content).not.toContain(secret);
    expect(toolMessage?.role === "tool" && toolMessage.content).toContain("[redacted]");
    expect(result.text).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("refuses two tools with the same name instead of guessing", async () => {
    const one = probeTool("duplicate", true, async () => success("one"));
    const two = probeTool("duplicate", false, async () => failure("two"));
    await expect(
      runAgentLoop({
        provider: new MockProvider({ turns: [{ text: "hi" }] }),
        tools: [one, two],
        context: contextFor(await readyEnvironment()),
      }),
    ).rejects.toThrow(/duplicate/);
  });
});
