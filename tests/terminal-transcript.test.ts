/**
 * The terminal's DOM mirror must never starve.
 *
 * The mirror is what a screen reader reads and what a browser test asserts on, and it is
 * fed through a throttling buffer. The regression these tests lock down is specific: a
 * chunk that arrives just after a flush used to sit in the buffer waiting for the *next*
 * chunk to carry it, and the last line of a command has no next chunk. In the browser
 * acceptance run that looked like a command whose output was on screen but absent from the
 * page's mirror — the run waited 30 s for a line the guest had already printed, then failed.
 *
 * So the rule is simple and testable without a browser: every chunk reaches `emit`, with no
 * further output required.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TranscriptBuffer } from "../src/ui/terminal-transcript";

describe("TranscriptBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the last chunk on its own timer, with nothing after it", () => {
    const chunks: string[] = [];
    const buffer = new TranscriptBuffer((chunk) => chunks.push(chunk), 100);

    // One command's output. This is the whole stream: nothing follows it, ever.
    buffer.push("LARPABLE-LS dist/index.html\r\n");
    expect(chunks).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(chunks).toEqual(["LARPABLE-LS dist/index.html\r\n"]);
    expect(buffer.pending).toBe("");
  });

  it("emits a chunk that arrives immediately after a flush without more output", () => {
    const chunks: string[] = [];
    const buffer = new TranscriptBuffer((chunk) => chunks.push(chunk), 100);

    buffer.push("echo\r\n");
    vi.advanceTimersByTime(100);
    expect(chunks).toHaveLength(1);

    // Arrives 1 ms after the flush — inside the interval, and last.
    vi.advanceTimersByTime(1);
    buffer.push("answer 42\r\n");
    vi.advanceTimersByTime(100);
    expect(chunks).toEqual(["echo\r\n", "answer 42\r\n"]);
  });

  it("coalesces a burst into one update instead of one per chunk", () => {
    const chunks: string[] = [];
    const buffer = new TranscriptBuffer((chunk) => chunks.push(chunk), 100);

    for (let index = 0; index < 50; index += 1) buffer.push(`${String(index)}\n`);
    expect(chunks).toEqual([]);

    vi.advanceTimersByTime(100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.split("\n")).toHaveLength(51);
  });

  it("flushes immediately on demand, cancelling the timer", () => {
    const chunks: string[] = [];
    const buffer = new TranscriptBuffer((chunk) => chunks.push(chunk), 100);

    buffer.push("bye");
    buffer.flush();
    expect(chunks).toEqual(["bye"]);
    // The cancelled timer must not emit "bye" a second time.
    vi.advanceTimersByTime(500);
    expect(chunks).toEqual(["bye"]);
  });

  it("drops pending text on dispose, so a closed tab writes nothing", () => {
    const chunks: string[] = [];
    const buffer = new TranscriptBuffer((chunk) => chunks.push(chunk), 100);

    buffer.push("half a line");
    buffer.dispose();
    vi.advanceTimersByTime(500);
    expect(chunks).toEqual([]);
    expect(buffer.pending).toBe("");
  });

  it("ignores empty pushes rather than scheduling pointless renders", () => {
    const emit = vi.fn();
    const buffer = new TranscriptBuffer(emit, 100);

    buffer.push("");
    vi.advanceTimersByTime(500);
    expect(emit).not.toHaveBeenCalled();
  });
});
