/**
 * The user's own terminal: tabs of real shells, attached to the guest's ptys.
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
 * - **A shell lives in a tab.** `+` opens another shell, and the `×` on a tab closes that
 *   tab's pty and nothing else — which is what makes `+` mean "another shell" instead of
 *   "throw this one away". Tabs are pure state (`terminal-tabs.ts`); a session hangs off its
 *   tab, so closing a tab cannot leave a pty running in a worker nobody can see.
 * - Every failure is shown. A terminal that silently does nothing is worse than one
 *   that says why it could not connect.
 * - `data-testid="terminal-output"` mirrors each tab's transcript in the DOM: xterm renders
 *   to its own canvas/layers, which a test (and a screen reader) cannot read.
 *
 * ## The chrome: clipboard actions and keys a touch screen does not have
 *
 * A terminal in a browser is missing two things a desktop terminal has: the ability to
 * select text with a mouse *and* reach the system clipboard, and modifier keys. So the
 * header carries copy / paste / cut-with-a-caveat / clear, and a key row above the screen
 * carries `CTRL`, `ALT`, `ESC`, `TAB` and the arrows (see `terminal-keys.ts` for why the two
 * modifiers are sticky rather than held).
 *
 * Each of those actions is honest about what it can do. "Cut" copies the selection and
 * clears the highlight, because nothing can remove a line from a shell's scrollback. "Clear"
 * drops the local scrollback, not the shell's history. A refused clipboard permission is
 * reported in the pane instead of a button that appears to work and does nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ClipboardPaste,
  Copy,
  Plus,
  Scissors,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import type { ShellOptions, TerminalSession } from "@/env/execution";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import {
  NO_MODIFIERS,
  TERMINAL_KEYS,
  encodeModifiedInput,
  toggleModifier,
  type KeyDefinition,
  type ModifierState,
} from "@/ui/terminal-keys";
import { activeTabOf, addTab, closeTab, type ShellTab } from "@/ui/terminal-tabs";
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

/** The slice of xterm this component drives, so a type import stays a type import. */
interface TerminalLike {
  cols: number;
  rows: number;
  getSelection(): string;
  clearSelection(): void;
  clear(): void;
  paste(data: string): void;
  focus(): void;
  dispose(): void;
}

/** One live tab, published upwards so the header can act on whichever tab is selected. */
interface TabHandle {
  terminal: TerminalLike;
  session: TerminalSession;
  fit(): void;
  focus(): void;
}

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

type Notice = { kind: "ok" | "error"; text: string };

/** The clipboard API, or null when this context has none (plain http, an old browser). */
function clipboard(): { readText(): Promise<string>; writeText(text: string): Promise<void> } | null {
  const api = (globalThis.navigator as Navigator | undefined)?.clipboard as
    | { readText?: () => Promise<string>; writeText?: (text: string) => Promise<void> }
    | undefined;
  if (!api || typeof api.readText !== "function" || typeof api.writeText !== "function") {
    return null;
  }
  return { readText: () => api.readText!(), writeText: (text) => api.writeText!(text) };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function TerminalPanel({ ready, cwd, openShell, unavailableReason }: TerminalPanelProps) {
  const [tabs, setTabs] = useState<ShellTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<
    Record<string, { connection: Connection; error: string | null }>
  >({});
  const [modifiers, setModifiers] = useState<ModifierState>(NO_MODIFIERS);
  const [notice, setNotice] = useState<Notice | null>(null);

  const handlesRef = useRef(new Map<string, TabHandle>());
  const modifiersRef = useRef<ModifierState>(NO_MODIFIERS);
  const tabsRef = useRef<ShellTab[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const nextNumberRef = useRef(1);
  const autoOpenedRef = useRef(false);

  const applyModifiers = useCallback((next: ModifierState) => {
    modifiersRef.current = next;
    setModifiers(next);
  }, []);

  const openTab = useCallback(() => {
    const result = addTab(tabsRef.current, nextNumberRef.current);
    nextNumberRef.current = result.nextNumber;
    tabsRef.current = result.tabs;
    activeIdRef.current = result.tab.id;
    setTabs(result.tabs);
    setActiveId(result.tab.id);
    setNotice(null);
  }, []);

  const closeShell = useCallback((id: string) => {
    const result = closeTab(tabsRef.current, id, activeIdRef.current);
    tabsRef.current = result.tabs;
    activeIdRef.current = result.activeId;
    setTabs(result.tabs);
    setActiveId(result.activeId);
    handlesRef.current.delete(id);
    setStatuses((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setNotice(null);
  }, []);

  const reportStatus = useCallback((id: string, connection: Connection, error: string | null) => {
    setStatuses((current) => {
      const previous = current[id];
      if (previous?.connection === connection && previous.error === error) return current;
      return { ...current, [id]: { connection, error } };
    });
  }, []);

  const register = useCallback((id: string, handle: TabHandle | null) => {
    if (handle === null) handlesRef.current.delete(id);
    else handlesRef.current.set(id, handle);
  }, []);

  // The first shell opens itself once the guest is ready — but only once: after the user
  // closes every tab, an automatic re-open would fight them.
  useEffect(() => {
    if (!ready || openShell === null || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    openTab();
  }, [ready, openShell, openTab]);

  const selectTab = useCallback((id: string) => {
    activeIdRef.current = id;
    setActiveId(id);
    setNotice(null);
  }, []);

  const currentHandle = (): TabHandle | null => {
    const id = activeIdRef.current;
    return id === null ? null : (handlesRef.current.get(id) ?? null);
  };

  const copySelection = useCallback(async (): Promise<string | null> => {
    const handle = currentHandle();
    if (handle === null) return null;
    const selection = handle.terminal.getSelection();
    if (selection.length === 0) {
      setNotice({ kind: "error", text: "Nothing is selected: drag across the terminal text first." });
      return null;
    }
    const api = clipboard();
    if (api === null) {
      setNotice({
        kind: "error",
        text: "This browser exposes no clipboard API here (it needs https or localhost), so copy is unavailable.",
      });
      return null;
    }
    try {
      await api.writeText(selection);
      setNotice({ kind: "ok", text: `Copied ${String(selection.length)} characters.` });
      return selection;
    } catch (cause) {
      setNotice({ kind: "error", text: `The browser refused the copy: ${messageOf(cause)}` });
      return null;
    }
  }, []);

  const paste = useCallback(async () => {
    const handle = currentHandle();
    if (handle === null) return;
    const api = clipboard();
    if (api === null) {
      setNotice({
        kind: "error",
        text: "This browser exposes no clipboard API here (it needs https or localhost), so paste is unavailable.",
      });
      return;
    }
    try {
      const text = await api.readText();
      if (text.length === 0) {
        setNotice({ kind: "error", text: "The clipboard is empty." });
        return;
      }
      // `paste()` runs the text through the terminal, so it reaches the pty exactly as a
      // typed paste would (newlines converted, bracketed-paste mode honoured).
      handle.terminal.paste(text);
      handle.focus();
      setNotice({ kind: "ok", text: `Pasted ${String(text.length)} characters.` });
    } catch (cause) {
      setNotice({ kind: "error", text: `The browser refused the paste: ${messageOf(cause)}` });
    }
  }, []);

  const cut = useCallback(async () => {
    const copied = await copySelection();
    if (copied === null) return;
    // A terminal has no "cut": the shell's scrollback is the guest's output, and nothing in
    // the browser can delete a line from it. So the selection is copied and then
    // unhighlighted, and the notice says so rather than implying the text was removed.
    currentHandle()?.terminal.clearSelection();
    setNotice({
      kind: "ok",
      text: `Copied ${String(copied.length)} characters and cleared the selection (the shell's scrollback is untouched).`,
    });
  }, [copySelection]);

  const clearScreen = useCallback(() => {
    const handle = currentHandle();
    handle?.terminal.clear();
    handle?.focus();
    setNotice({ kind: "ok", text: "Terminal cleared." });
  }, []);

  const pressKey = useCallback(
    (key: KeyDefinition) => {
      const handle = currentHandle();
      if (key.modifier !== undefined) {
        applyModifiers(toggleModifier(modifiersRef.current, key.modifier));
        handle?.focus();
        return;
      }
      handle?.session.write(key.sequence).catch((cause: unknown) => {
        setNotice({ kind: "error", text: messageOf(cause) });
      });
      handle?.focus();
      setNotice(null);
    },
    [applyModifiers],
  );

  const active = activeTabOf(tabs, activeId);
  const activeStatus = active === null ? null : (statuses[active.id] ?? null);
  const badge =
    active === null
      ? { label: "No shell", variant: "muted" as const }
      : describeConnection(activeStatus?.connection ?? "connecting");
  const attached = activeStatus?.connection === "connected";
  const modifierHints = [modifiers.ctrl ? "CTRL" : null, modifiers.alt ? "ALT" : null].filter(
    (value): value is string => value !== null,
  );

  return (
    <div
      data-testid="terminal-panel"
      data-connection={activeStatus?.connection ?? "waiting"}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-slate-800 bg-[#0b1020]"
    >
      {/* Tabs: one shell each. `+` opens another; the × closes only that one. */}
      <div
        data-testid="terminal-tabs"
        role="tablist"
        aria-label="Shells"
        className="flex items-center gap-1 overflow-x-auto border-b border-slate-800 px-2 py-1"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active?.id;
          const status = statuses[tab.id]?.connection ?? "connecting";
          return (
            <span
              key={tab.id}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5",
                selected
                  ? "border-slate-600 bg-slate-800/80 text-slate-100"
                  : "border-transparent bg-slate-900/60 text-slate-400 hover:border-slate-700 hover:text-slate-200",
              )}
            >
              <button
                type="button"
                role="tab"
                id={`terminal-tab-${tab.id}`}
                data-testid={`terminal-tab-${tab.id}`}
                aria-selected={selected}
                aria-controls={`terminal-tabpanel-${tab.id}`}
                aria-label={`${tab.label} (${status})`}
                title={`${tab.label} (${status})`}
                onClick={() => selectTab(tab.id)}
                className="font-mono text-[11px]"
              >
                {tab.label}
              </button>
              <button
                type="button"
                data-testid={`terminal-tab-close-${tab.id}`}
                aria-label={`Close ${tab.label}`}
                title={`Close ${tab.label}`}
                onClick={() => closeShell(tab.id)}
                className="rounded p-0.5 text-slate-500 hover:bg-slate-700 hover:text-slate-100"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </span>
          );
        })}
        <button
          type="button"
          data-testid="terminal-new-shell"
          aria-label="New shell tab"
          title="New shell tab"
          onClick={openTab}
          disabled={!ready}
          className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5">
        <SquareTerminal aria-hidden="true" className="size-3.5 text-slate-400" />
        <span className="font-mono text-[11px] text-slate-200">{cwd}</span>
        <Badge data-testid="terminal-status" variant={badge.variant} className="ml-auto text-[10px]">
          {badge.label}
        </Badge>

        <div className="flex items-center gap-0.5">
          <Button
            data-testid="terminal-copy"
            aria-label="Copy the selection"
            title="Copy the selection"
            size="sm"
            variant="ghost"
            className="size-7 p-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            onClick={() => void copySelection()}
            disabled={!attached}
          >
            <Copy aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            data-testid="terminal-paste"
            aria-label="Paste from the clipboard"
            title="Paste from the clipboard"
            size="sm"
            variant="ghost"
            className="size-7 p-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            onClick={() => void paste()}
            disabled={!attached}
          >
            <ClipboardPaste aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            data-testid="terminal-cut"
            aria-label="Cut: copy the selection and clear the highlight"
            title="Cut: copy the selection and clear the highlight (a shell's scrollback cannot be removed)"
            size="sm"
            variant="ghost"
            className="size-7 p-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            onClick={() => void cut()}
            disabled={!attached}
          >
            <Scissors aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            data-testid="terminal-clear"
            aria-label="Clear the terminal"
            title="Clear the terminal's scrollback"
            size="sm"
            variant="ghost"
            className="size-7 p-0 text-slate-300 hover:bg-slate-800 hover:text-slate-100"
            onClick={clearScreen}
            disabled={!attached}
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* The keys a touch screen does not have. Sticky modifiers show their armed state. */}
      <div
        data-testid="terminal-keys"
        role="toolbar"
        aria-label="Terminal keys"
        className="flex items-center gap-1 overflow-x-auto border-b border-slate-800 px-2 py-1"
      >
        {TERMINAL_KEYS.map((key) => {
          const armed =
            key.modifier === "ctrl" ? modifiers.ctrl : key.modifier === "alt" ? modifiers.alt : false;
          return (
            <button
              key={key.id}
              type="button"
              data-testid={`terminal-key-${key.id}`}
              aria-label={key.description}
              aria-pressed={key.modifier === undefined ? undefined : armed}
              title={key.description}
              disabled={!attached}
              onClick={() => pressKey(key)}
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10.5px] leading-4 transition-colors",
                "disabled:opacity-40",
                armed
                  ? "border-sky-400 bg-sky-500/20 text-sky-200"
                  : "border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-500 hover:text-slate-100",
              )}
            >
              {key.label}
            </button>
          );
        })}
        {modifierHints.length > 0 && (
          <span
            data-testid="terminal-modifiers"
            aria-live="polite"
            className="ml-1 shrink-0 font-mono text-[10.5px] text-sky-300"
          >
            {modifierHints.join("+")} armed: press a character
          </span>
        )}
      </div>

      {notice !== null && (
        <p
          data-testid="terminal-notice"
          data-kind={notice.kind}
          role="status"
          className={cn(
            "px-3 py-1 font-mono text-[11px]",
            notice.kind === "error" ? "bg-red-950/60 text-red-200" : "bg-slate-900/80 text-slate-300",
          )}
        >
          {notice.text}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {tabs.map((tab) => (
          <ShellTab
            key={tab.id}
            tab={tab}
            active={tab.id === active?.id}
            ready={ready}
            cwd={cwd}
            openShell={openShell}
            unavailableReason={unavailableReason ?? null}
            modifiersRef={modifiersRef}
            onConsumeModifiers={applyModifiers}
            onStatus={reportStatus}
            register={register}
          />
        ))}

        {tabs.length === 0 && (
          <div
            data-testid="terminal-empty"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center"
          >
            <SquareTerminal aria-hidden="true" className="size-5 text-slate-600" />
            <p className="font-mono text-[11.5px] text-slate-400">
              {ready ? "No shell open. Press + for a new shell." : "Boot Linux to get a shell in /workspace."}
            </p>
            {!ready && typeof unavailableReason === "string" && unavailableReason.length > 0 && (
              <p className="font-mono text-[11px] text-slate-500">{unavailableReason}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface ShellTabProps {
  tab: ShellTab;
  active: boolean;
  ready: boolean;
  cwd: string;
  openShell: ((options?: ShellOptions) => Promise<TerminalSession>) | null;
  unavailableReason: string | null;
  /** The panel's sticky-modifier state, shared by every tab (a ref, so it never re-subscribes). */
  modifiersRef: { current: ModifierState };
  onConsumeModifiers(next: ModifierState): void;
  onStatus(id: string, connection: Connection, error: string | null): void;
  register(id: string, handle: TabHandle | null): void;
}

/**
 * One shell in one tab.
 *
 * Its own effect, its own pty, its own transcript: closing the tab unmounts this component,
 * which closes the pty — that is the whole reason a session hangs off a tab rather than off
 * the panel. A hidden tab keeps its shell running (a build started in one tab must not die
 * because the user looked at another); it simply is not measured or focused until selected.
 */
function ShellTab({
  tab,
  active,
  ready,
  cwd,
  openShell,
  unavailableReason,
  modifiersRef,
  onConsumeModifiers,
  onStatus,
  register,
}: ShellTabProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<TabHandle | null>(null);
  const [connection, setConnection] = useState<Connection>("waiting");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");

  useEffect(() => {
    onStatus(tab.id, connection, error);
  }, [tab.id, connection, error, onStatus]);

  // A tab that becomes visible again has to re-measure: xterm cannot fit inside
  // `display: none`, so a hidden tab keeps its old size until it is shown.
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      try {
        handleRef.current?.fit();
        handleRef.current?.focus();
      } catch {
        // A collapsed container has no size to fit; the next resize fixes it.
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [active]);

  useEffect(() => {
    if (!ready || !openShell || !containerRef.current) {
      setConnection("waiting");
      return;
    }

    let disposed = false;
    let term: TerminalLike | null = null;
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
        term = terminal as unknown as TerminalLike;

        session = await openShell({ cwd, cols: terminal.cols, rows: terminal.rows });
        if (disposed) {
          await session.close().catch(() => undefined);
          return;
        }
        handleRef.current = {
          terminal: term,
          session,
          fit: () => fit.fit(),
          focus: () => terminal.focus(),
        };
        register(tab.id, handleRef.current);
        setConnection("connected");

        onData = terminal.onData((raw) => {
          // Sticky modifiers are applied here, at the one place bytes leave the pane, so
          // the key row and the keyboard cannot disagree about what Ctrl-C means.
          const { data, consumed } = encodeModifiedInput(raw, modifiersRef.current);
          if (consumed !== modifiersRef.current) onConsumeModifiers(consumed);
          if (data.length === 0) return;
          void session?.write(data).catch((cause: unknown) => {
            if (disposed) return;
            setError(messageOf(cause));
          });
        });

        // A 60-column pane inside a wider window still needs the reflow, so one resize
        // observer serves both the layout change and the initial fit.
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => {
            if (term === null) return;
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
        handleRef.current = null;
        register(tab.id, null);
      }
    })();

    return () => {
      disposed = true;
      observer?.disconnect();
      onData?.dispose();
      void session?.close().catch(() => undefined);
      term?.dispose();
      handleRef.current = null;
      register(tab.id, null);
    };
  }, [ready, openShell, cwd, tab.id, register, modifiersRef, onConsumeModifiers]);

  return (
    <div
      id={`terminal-tabpanel-${tab.id}`}
      role="tabpanel"
      aria-labelledby={`terminal-tab-${tab.id}`}
      data-tab-id={tab.id}
      className={cn("absolute inset-0", !active && "hidden")}
    >
      <div
        ref={containerRef}
        data-testid="terminal-screen"
        className="absolute inset-0 px-2 py-1.5"
      />

      {connection !== "connected" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 px-3 py-2">
          <p
            className={cn(
              "font-mono text-[11.5px]",
              connection === "error" ? "text-red-300" : "text-slate-400",
            )}
          >
            {connection === "waiting"
              ? "Waiting for the guest…"
              : connection === "connecting"
                ? "Opening a shell in /workspace…"
                : connection === "ended"
                  ? "The shell exited. Press + for a new shell."
                  : (error ?? (unavailableReason ?? "The terminal could not connect."))}
          </p>
        </div>
      )}

      {error && connection === "connected" && (
        <p className="absolute inset-x-0 bottom-0 bg-red-950/70 px-3 py-1 font-mono text-[11px] text-red-200">
          <TriangleAlert aria-hidden="true" className="mr-1 inline size-3" />
          {error}
        </p>
      )}

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
