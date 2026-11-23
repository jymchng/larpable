/**
 * Server-sent events, as both supported providers stream them (PRD §9.2, "support
 * streaming responses").
 *
 * A stream is a sequence of `data: <json>` lines, and the interesting detail is that a
 * line can arrive split across chunk boundaries and that the terminating `[DONE]` is not
 * JSON. Getting this wrong looks like "the model said nothing", so it lives here once,
 * used by the OpenAI-compatible and Anthropic providers alike, and tested directly.
 */

/** One parsed `data:` payload, or the sentinel that ends an OpenAI-style stream. */
export type SseEvent = { data: string } | { done: true };

/**
 * Yield the `data` payloads of an SSE response as they arrive.
 *
 * Errors thrown by `body.getReader()` propagate: a truncated stream is a real failure,
 * not an empty answer.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const event = parseLine(line);
        if (event !== null) yield event;
      }
    }

    // A final line without a trailing newline is still a line.
    const tail = buffer.trim();
    if (tail.length > 0) {
      const event = parseLine(tail);
      if (event !== null) yield event;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseLine(line: string): SseEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith(":")) return null; // comment / keep-alive
  if (!trimmed.startsWith("data:")) return null; // event:, id:, retry:

  const data = trimmed.slice("data:".length).trim();
  if (data === "[DONE]") return { done: true };
  if (data.length === 0) return null;
  return { data };
}

/** Parse a streamed JSON payload, or null when the provider sent something unusable. */
export function parsePayload<T>(data: string): T | null {
  try {
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}
