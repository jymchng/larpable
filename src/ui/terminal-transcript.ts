/**
 * The buffer between a pty's output stream and the DOM mirror of a terminal.
 *
 * A terminal prints in whatever chunks the pty hands over — a prompt, an echo, a line of
 * command output — and each chunk written straight into React state costs a render. So the
 * mirror is throttled: text accumulates here and is handed to React at most once per
 * interval.
 *
 * The bug this class exists to prevent: throttling must be *trailing*, not leading. The
 * earlier implementation flushed on arrival only when the previous flush was at least one
 * interval old, and otherwise left the text waiting for the *next* chunk to carry it. When
 * a command's output is the last thing that happens — which is exactly the case for a
 * one-line command — nothing ever follows it, so the final line never reached the DOM. In
 * the browser acceptance run that surfaced as a command whose output was on screen but not
 * in the mirror, and the run failed after a 30 s wait for a line the page had already
 * received (`docs/preview-browser-report.md`, "the build is in the guest's dist/").
 *
 * A timer that always fires is the whole fix: `push()` schedules a flush, and the flush
 * empties the buffer whatever else does or does not arrive.
 */
export class TranscriptBuffer {
  #pending = "";
  #timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param emit Called with the accumulated text. Every chunk eventually arrives here.
   * @param intervalMs Longest time a chunk may wait for company before being emitted.
   */
  constructor(
    private readonly emit: (chunk: string) => void,
    private readonly intervalMs: number,
  ) {}

  /** Text accepted but not yet emitted. For tests and diagnostics. */
  get pending(): string {
    return this.#pending;
  }

  /** Add output and make sure a flush is on its way. */
  push(text: string): void {
    if (text.length === 0) return;
    this.#pending += text;
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#drain();
    }, this.intervalMs);
  }

  /** Emit now — for the end of a stream, where waiting would delay the last line. */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#drain();
  }

  /** Drop anything pending: the terminal is going away, so nobody will read it. */
  dispose(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#pending = "";
  }

  #drain(): void {
    if (this.#pending.length === 0) return;
    const chunk = this.#pending;
    this.#pending = "";
    this.emit(chunk);
  }
}
