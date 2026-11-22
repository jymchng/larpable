/**
 * The user's own terminal, attached to the guest's real pty.
 *
 * Why xterm and a pty, rather than a text box that calls `execute()`: the guest is a
 * Linux machine and people expect to *be* on it. A pty gives them a shell with a
 * controlling terminal, so `ls` colours, `cat` streams, `cd` persists between
 * commands, `Ctrl-C` interrupts, and the window size is real (`SIGWINCH`), which is
 * what a full-screen program needs to lay itself out.
 *
 * The rules this component follows:
 *
 * - xterm is imported lazily, so the app's first paint (and every Node-side test) does
 *   not pay for it, and a browser that never opens a terminal never downloads it.
 * - The session is opened once per mount and closed on unmount. A reload must not
 *   leave a shell running in a worker nobody can see.
 * - Every failure is shown. A terminal that silently does nothing is worse than one
 *   that says why it could not connect.
 * - `data-testid="terminal-output"` mirrors the transcript in the DOM: xterm renders to
 *   its own canvas/layers, which a test (and a screen reader) cannot read.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCcw, SquareTerminal, TriangleAlert } from "lucide-react";

import type { ShellOptions, TerminalSession } from "@/env/execution";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { cn } from "@/lib/utils";

export interface TerminalPanelProps {
  /** True once the environment reports ready; before that there is nothing to attach to. */
  ready: boolean;
  /** Guest path the shell starts in, shown in the header. */
  cwd: string;
  /** Opens a pty in the guest. Null until the environment exists. */
  openShell: ((options?: ShellOptions) => Promise<TerminalSession>) | null;
  /** Debug text when `openShell` rejects, e.g. "environment not ready". */
  unavailableReason?: string | null;
}

type Connection = "waiting" | "connecting" | "connected" | "ended" | "error";

const TRANSCRIPT_LIMIT = 12_000;
/** Transcript flushes are throttled: a build's progress bar can emit hundreds a second. */
const TRANSCRIPT_INTERVAL_MS = 100;

const TERMINAL_THEME = {
  background: "#0b1020",
  foreground: "#e7ecf5",
  cursor: "#7dd3fc",
  cursorAccent: "#0b1020",
  selectionBackground: "#2b3a5a",
  black: "#0b1020",
  red: "#ff8080",
  green: "#7ee787",
  yellow: "#ffd479",
  blue: "#82aaff",
  magenta: "#d2a8ff",
  cyan: "#7dd3fc",
  white: "#e7ecf5",
} as const;

export function TerminalPanel({ ready, cwd, openShell, unavailableReason }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [connection, setConnection] = useState<Connection>("waiting");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [generation, setGeneration] = useState(0);

  const reconnect = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (!ready || !openShell || !containerRef.current) {
      setConnection("waiting");
      return;
    }

    let disposed = false;
    let term: { dispose: () => void; cols: number; rows: number } | null = null;
    let session: TerminalSession | null = null;
    let observer: ResizeObserver | null = null;
    let onData: { dispose: () => void } | null = null;

    // The transcript is buffered in a ref and flushed on a timer, so a command that
    // prints thousands of lines costs a handful of renders instead of thousands.
    let pending = "";
    let lastFlush = 0;
    const flush = (force: boolean) => {
      if (!force && pending.length === 0) return;
      const now = Date.now();
      if (!force && now - lastFlush < TRANSCRIPT_INTERVAL_MS) return;
      lastFlush = now;
      const chunk = pending;
      pending = "";
      if (chunk.length === 0) return;
      setTranscript((previous) => {
        const next = previous + chunk;
        return next.length > TRANSCRIPT_LIMIT ? next.slice(next.length - TRANSCRIPT_LIMIT) : next;
      });
    };

    void (async () => {
      setConnection("connecting");
      setError(null);
      setTranscript("");

      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        // Loaded with the terminal, not at module scope: the CSS is only needed here.
        await import("@xterm/xterm/css/xterm.css");
        if (disposed || !containerRef.current) return;

        const terminal = new Terminal({
          convertEol: true,
          cursorBlink: true,
          fontFamily:
            'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
          fontSize: 12.5,
          lineHeight: 1.25,
          scrollback: 5_000,
          theme: TERMINAL_THEME,
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.open(containerRef.current);
        fit.fit();
        terminal.focus();
        term = terminal;

        session = await openShell({ cwd, cols: terminal.cols, rows: terminal.rows });
        if (disposed) {
          await session.close().catch(() => undefined);
          return;
        }
        setConnection("connected");

        onData = terminal.onData((data) => {
          void session?.write(data).catch((cause: unknown) => {
            if (disposed) return;
            setError(cause instanceof Error ? cause.message : String(cause));
          });
        });

        // A 60-column pane inside a wider window still needs the reflow, so one resize
        // observer serves both the layout change and the initial fit.
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => {
            if (!term) return;
            try {
              fit.fit();
              session?.resize(term.cols, term.rows);
            } catch {
              // A collapsed container has no size to fit; the next resize fixes it.
            }
          });
          observer.observe(containerRef.current);
        }

        const reader = session.output.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;
          const text = decoder.decode(value, { stream: true });
          if (text.length === 0) continue;
          terminal.write(text);
          pending += text;
          flush(false);
        }

        const tail = decoder.decode();
        if (tail.length > 0) {
          terminal.write(tail);
          pending += tail;
        }
        flush(true);

        const end = await session.ended.catch(() => ({ type: "lost" as const }));
        if (disposed) return;
        if (end.type === "exit") {
          terminal.write(`\r\n\x1b[2m[shell exited with ${String(end.code)}]\x1b[0m\r\n`);
        } else if (end.type === "signal") {
          terminal.write(`\r\n\x1b[2m[shell killed by signal ${String(end.signal)}]\x1b[0m\r\n`);
        }
        setConnection("ended");
      } catch (cause) {
        if (disposed) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        setConnection("error");
        term?.dispose();
        term = null;
      }
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      onData?.dispose();
      void session?.close().catch(() => undefined);
      term?.dispose();
    };
  }, [ready, openShell, cwd, generation]);

  const badge = describeConnection(connection);

  return (
    <div
      data-testid="terminal-panel"
      data-connection={connection}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#0b1020]"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5">
        <SquareTerminal aria-hidden="true" className="size-3.5 text-slate-400" />
        <span className="font-mono text-[11px] text-slate-200">{cwd}</span>
        <Badge data-testid="terminal-status" variant={badge.variant} className="ml-auto text-[10px]">
          {badge.label}
        </Badge>
        <Button
          data-testid="terminal-reconnect"
          size="sm"
          variant="ghost"
          className="text-slate-300 hover:bg-slate-800 hover:text-slate-100"
          onClick={reconnect}
          disabled={!ready}
        >
          <RotateCcw aria-hidden="true" />
          New shell
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={containerRef}
          data-testid="terminal-screen"
          className="absolute inset-0 px-2 py-1.5"
        />

        {connection !== "connected" && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 py-2">
            <p className={cn("font-mono text-[11.5px]", connection === "error" ? "text-red-300" : "text-slate-400")}>
              {connection === "waiting"
                ? "Boot Linux to get a shell in /workspace."
                : connection === "connecting"
                  ? "Opening a shell in /workspace…"
                  : connection === "ended"
                    ? "The shell exited. Press New shell to start another."
                    : (error ?? unavailableReason ?? "The terminal could not connect.")}
            </p>
          </div>
        )}

        {error && connection === "connected" && (
          <p className="absolute inset-x-0 bottom-0 bg-red-950/70 px-3 py-1 font-mono text-[11px] text-red-200">
            <TriangleAlert aria-hidden="true" className="mr-1 inline size-3" />
            {error}
          </p>
        )}
      </div>

      {/*
        A readable mirror of what the terminal printed. xterm draws into its own
        layers, so without this neither a screen reader nor a browser test can see the
        output at all.
      */}
      <pre
        data-testid="terminal-output"
        aria-live="polite"
        aria-atomic="false"
        className="sr-only"
      >
        {transcript}
      </pre>
    </div>
  );
}

function describeConnection(connection: Connection): {
  label: string;
  variant: "muted" | "warning" | "success" | "destructive";
} {
  switch (connection) {
    case "connected":
      return { label: "Connected", variant: "success" };
    case "connecting":
      return { label: "Connecting", variant: "warning" };
    case "ended":
      return { label: "Exited", variant: "muted" };
    case "error":
      return { label: "Failed", variant: "destructive" };
    case "waiting":
      return { label: "Not connected", variant: "muted" };
  }
}
