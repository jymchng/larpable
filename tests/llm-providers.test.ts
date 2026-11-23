/**
 * The provider layer: three backends behind one interface (PRD §9.2).
 *
 * The tests are arranged by the three things that actually break here:
 *
 * - **framing** — a stream arrives in fragments, so `data:` lines are split across reads and
 *   the terminating `[DONE]` is not JSON. Getting this wrong looks like "the model said
 *   nothing";
 * - **arguments** — a tool call's arguments are a JSON *string* that a model wrote, so they
 *   can be broken, mistyped or carry a field name nobody defined. The validator has to say
 *   so precisely, because its message is what the model reads next;
 * - **translation** — OpenAI and Anthropic disagree about where the system prompt, tool
 *   results and tool arguments live. Each provider's mapping is asserted on the request it
 *   actually sends.
 *
 * Everything runs against an injected `fetch` and the scripted provider: no network, no key,
 * no flakiness.
 */

import { describe, expect, it } from "vitest";

import { AnthropicProvider, translateConversation } from "../src/llm/anthropic";
import { MockProvider } from "../src/llm/mock";
import { OpenAICompatibleProvider } from "../src/llm/openai";
import { describeIssues, validateToolArguments } from "../src/llm/schema";
import { readSse, parsePayload } from "../src/llm/sse";
import { LLMRequestError, type ToolDefinition } from "../src/llm/types";

const tool: ToolDefinition = {
  name: "write_file",
  description: "Write a file.",
  readOnly: false,
  parameters: {
    type: "object",
    description: "arguments",
    properties: {
      path: { type: "string", description: "where", minLength: 1 },
      content: { type: "string", description: "what" },
    },
    required: ["path", "content"],
  },
};

/** Feed the parser a stream that splits `text` into `chunks`, so boundaries are real. */
function chunkedStream(text: string, chunks: readonly number[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let offset = 0;
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= text.length) {
        controller.close();
        return;
      }
      const size = chunks[index % chunks.length] ?? 1;
      index += 1;
      const slice = text.slice(offset, offset + size);
      offset += size;
      controller.enqueue(encoder.encode(slice));
    },
  });
}

describe("SSE parsing", () => {
  it("reassembles payloads split across chunk boundaries", async () => {
    const text = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    const events: string[] = [];
    for await (const event of readSse(chunkedStream(text, [1, 2, 3, 5, 7]))) {
      if ("done" in event) {
        events.push("[DONE]");
        break;
      }
      events.push(event.data);
    }
    expect(events).toEqual(['{"a":1}', '{"b":2}', "[DONE]"]);
  });

  it("ignores comments, other fields and blank lines", async () => {
    const text = ": keep-alive\nevent: message\nid: 7\ndata: {\"x\":true}\n\n";
    const events: string[] = [];
    for await (const event of readSse(chunkedStream(text, [4, 9]))) {
      if ("done" in event) events.push("[DONE]");
      else events.push(event.data);
    }
    expect(events).toEqual(['{"x":true}']);
  });

  it("treats unparsable payloads as absent rather than fatal", () => {
    expect(parsePayload<{ a: number }>("{oops")).toBeNull();
    expect(parsePayload<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
});

describe("tool argument validation", () => {
  it("accepts arguments that match the schema", () => {
    const result = validateToolArguments(tool.parameters, '{"path":"a.ts","content":"x"}');
    expect(result).toEqual({ ok: true, value: { path: "a.ts", content: "x" } });
  });

  it("treats empty arguments as an empty object", () => {
    const result = validateToolArguments(
      { type: "object", description: "none", properties: {}, required: [] },
      "  ",
    );
    expect(result).toEqual({ ok: true, value: {} });
  });

  it("reports broken JSON with the parser's reason", () => {
    const result = validateToolArguments(tool.parameters, '{"path": ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("not valid JSON");
    expect(describeIssues(result.issues)).toContain("The arguments were rejected");
  });

  it("names every missing and mistyped field", () => {
    const result = validateToolArguments(tool.parameters, '{"content":42}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toContain("path is required");
    expect(result.issues).toContain("content must be a string");
  });

  it("rejects unknown fields instead of silently ignoring a typo", () => {
    const result = validateToolArguments(tool.parameters, '{"path":"a","contents":"x"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const joined = result.issues.join(" ");
    expect(joined).toContain("contents is not a known field");
    expect(joined).toContain("content is required");
  });

  it("enforces ranges, enums and array items", () => {
    const schema = {
      type: "object" as const,
      description: "args",
      properties: {
        mode: { type: "string" as const, description: "mode", enum: ["fast", "slow"] },
        count: { type: "integer" as const, description: "how many", minimum: 1, maximum: 3 },
        names: {
          type: "array" as const,
          description: "names",
          items: { type: "string" as const, description: "name", minLength: 2 },
        },
      },
      required: [],
    };
    const result = validateToolArguments(schema, '{"mode":"medium","count":9,"names":["a"]}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const joined = result.issues.join(" ");
    expect(joined).toContain("mode must be one of fast, slow");
    expect(joined).toContain("count must be at most 3");
    expect(joined).toContain("names[0] must be at least 2 characters");
  });

  it("rejects a non-object payload", () => {
    const result = validateToolArguments(tool.parameters, "[1,2,3]");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.join(" ")).toContain("must be an object");
  });
});

describe("MockProvider", () => {
  it("replays the same turns, ids and text every run", async () => {
    const script = [
      { text: "looking", toolCalls: [{ name: "write_file", arguments: { path: "a", content: "b" } }] },
      { text: "done" },
    ];

    const first = new MockProvider({ turns: script });
    const second = new MockProvider({ turns: script });

    const a = await first.generate([{ role: "user", content: "go" }], [tool]);
    const b = await second.generate([{ role: "user", content: "go" }], [tool]);
    expect(a).toEqual(b);
    expect(a.toolCalls[0]?.id).toBe("mock-0-0");
    expect(a.toolCalls[0]?.arguments).toBe('{"path":"a","content":"b"}');
    expect(a.finishReason).toBe("tool_calls");

    const finalA = await first.generate([], [tool]);
    expect(finalA.text).toBe("done");
    expect(finalA.finishReason).toBe("stop");
  });

  it("streams its text through onText", async () => {
    const deltas: string[] = [];
    const provider = new MockProvider({ turns: [{ text: "hello" }] });
    await provider.generate([], [], { onText: (delta) => deltas.push(delta) });
    expect(deltas).toEqual(["hello"]);
  });

  it("refuses to answer a cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new MockProvider({ turns: [{ text: "never" }] });
    await expect(provider.generate([], [], { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(provider.requests).toHaveLength(1);
  });

  it("repeats its last turn when asked, so a loop can be tested", async () => {
    const provider = new MockProvider({ turns: [{ toolCalls: [{ name: "write_file" }] }], repeatLast: 2 });
    for (let index = 0; index < 3; index += 1) {
      const response = await provider.generate([], [tool]);
      expect(response.toolCalls).toHaveLength(1);
    }
    const exhausted = await provider.generate([], [tool]);
    expect(exhausted.toolCalls).toHaveLength(0);
  });
});

describe("OpenAI-compatible provider", () => {
  const KEY = "sk-test-key-1234567890";

  function streamResponse(events: readonly string[]): Response {
    return new Response(`${events.map((event) => `data: ${event}\n\n`).join("")}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("sends the model, tools and key, and reassembles streamed text and tool calls", async () => {
    const seen: { url: string; body: string; authorization: string | null }[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : "",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return streamResponse([
        JSON.stringify({ choices: [{ delta: { content: "Writ" } }] }),
        JSON.stringify({ choices: [{ delta: { content: "ing." } }] }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_9",
                    function: { name: "write_file", arguments: '{"path":"a.ts",' },
                  },
                ],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '"content":"x"}' } }],
              },
            },
          ],
        }),
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }),
      ]);
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      apiKey: KEY,
      model: "gpt-test",
      baseUrl: "https://endpoint.invalid/v1/",
      fetch: fakeFetch,
    });

    const deltas: string[] = [];
    const response = await provider.generate([{ role: "user", content: "build it" }], [tool], {
      onText: (delta) => deltas.push(delta),
    });

    expect(seen[0]?.url).toBe("https://endpoint.invalid/v1/chat/completions");
    expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(seen[0]?.body ?? "{}") as {
      model: string;
      messages: unknown[];
      tools: { function: { name: string; parameters: unknown } }[];
      stream: boolean;
    };
    expect(body.model).toBe("gpt-test");
    expect(body.stream).toBe(true);
    expect(body.tools[0]?.function.name).toBe("write_file");
    expect(body.tools[0]?.function.parameters).toEqual(tool.parameters);
    // The key travels in a header, never in the body.
    expect(seen[0]?.body).not.toContain(KEY);

    expect(deltas).toEqual(["Writ", "ing."]);
    expect(response.text).toBe("Writing.");
    expect(response.toolCalls).toEqual([
      { id: "call_9", name: "write_file", arguments: '{"path":"a.ts","content":"x"}' },
    ]);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
  });

  it("reads a whole JSON body when a server ignores streaming", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: "plain", tool_calls: [{ id: "c1", name: "write_file", arguments: "{}" }] },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const provider = new OpenAICompatibleProvider({ apiKey: KEY, model: "m", fetch: fakeFetch });
    const response = await provider.generate([], [tool]);
    expect(response.text).toBe("plain");
    expect(response.toolCalls).toHaveLength(1);
  });

  it("reports a non-2xx response with its status and the server's message, never the key", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "model not found" } }), {
        status: 404,
      })) as typeof fetch;

    const provider = new OpenAICompatibleProvider({ apiKey: KEY, model: "m", fetch: fakeFetch });
    await expect(provider.generate([], [])).rejects.toBeInstanceOf(LLMRequestError);
    await expect(provider.generate([], [])).rejects.toThrow(/HTTP 404/);
    await expect(provider.generate([], [])).rejects.toThrow(/model not found/);
    await expect(provider.generate([], [])).rejects.not.toThrow(new RegExp(KEY));
  });

  it("translates assistant tool calls and tool results into the OpenAI shape", async () => {
    let body: { messages: Record<string, unknown>[] } = { messages: [] };
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { messages: Record<string, unknown>[] };
      return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider({ apiKey: KEY, model: "m", fetch: fakeFetch });
    await provider.generate(
      [
        { role: "system", content: "be brief" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "write_file", arguments: '{"path":"a"}' }],
        },
        { role: "tool", toolCallId: "c1", name: "write_file", content: "wrote a", isError: false },
      ],
      [tool],
    );

    expect(body.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(body.messages[1]).toMatchObject({
      role: "assistant",
      tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path":"a"}' } }],
    });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "wrote a" });
  });
});

describe("Anthropic provider", () => {
  it("hoists the system prompt, requires max_tokens and reassembles tool input", async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        [
          'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
          'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"OK"}}',
          'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"write_file"}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
          'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.ts\\"}"}}',
          'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
          'data: {"type":"message_stop"}',
          "",
        ].join("\n\n"),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;

    const provider = new AnthropicProvider({
      apiKey: "anthropic-key-123456",
      model: "claude-test",
      fetch: fakeFetch,
    });

    const response = await provider.generate(
      [{ role: "system", content: "be brief" }, { role: "user", content: "go" }],
      [tool],
    );

    expect(body.system).toBe("be brief");
    expect(body.max_tokens).toBe(8192);
    const tools = body.tools as { input_schema: unknown }[];
    expect(tools[0]?.input_schema).toEqual(tool.parameters);

    expect(response.text).toBe("OK");
    expect(response.toolCalls).toEqual([{ id: "tu_1", name: "write_file", arguments: '{"path":"a.ts"}' }]);
    expect(response.finishReason).toBe("tool_calls");
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 9 });
  });

  it("merges consecutive tool results into one user turn", () => {
    const translated = translateConversation([
      { role: "system", content: "rules" },
      { role: "user", content: "go" },
      { role: "assistant", content: "using tools", toolCalls: [{ id: "a", name: "x", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", name: "x", content: "1", isError: false },
      { role: "tool", toolCallId: "b", name: "y", content: "failed", isError: true },
    ]);

    expect(translated.system).toBe("rules");
    const last = translated.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toHaveLength(2);
    expect(last?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "a" });
    expect(last?.content[1]).toMatchObject({ type: "tool_result", tool_use_id: "b", is_error: true });
  });

  it("survives a malformed tool call replayed from history", () => {
    const translated = translateConversation([
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "x", arguments: "{oops" }] },
    ]);
    expect(translated.messages[0]?.content[0]).toMatchObject({ type: "tool_use", input: {} });
  });

  it("reports a mid-stream provider error with the provider's message", async () => {
    const fakeFetch = (async () =>
      new Response('data: {"type":"error","error":{"type":"overloaded","message":"try again"}}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch;

    const provider = new AnthropicProvider({ apiKey: "k-123456789", model: "m", fetch: fakeFetch });
    await expect(provider.generate([], [])).rejects.toThrow(/try again/);
  });
});
