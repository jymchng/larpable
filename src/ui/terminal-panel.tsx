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
import { StatusDot, type StatusTone } from "@/ui/components/status-dot";
import { IconButton } from "@/ui/components/icon-button";
import {
  NO_MODIFIERS,
  TERMINAL_KEYS,
  encodeModifiedInput,
  toggleModifier,
  type KeyDefinition,
  type ModifierState,
} from "@/ui/terminal-keys";
import { activeTabOf, addTab, closeTab, type ShellTab } from "@/ui/terminal-tabs";
import {
  clipboardKeyAction,
  copySelection as copyFromTerminal,
  cutSelection as cutFromTerminal,
  pasteClipboard,
  type ClipboardPort,
  type ClipboardResult,
} from "@/ui/terminal-clipboard";
import { TranscriptBuffer } from "@/ui/terminal-transcript";
import { TOUCH_TARGET_BLOCK, TOUCH_TARGET_ICON } from "@/ui/touch";
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

/**
 * The transcript mirror's classes, in one place because a unit test pins two of them.
 *
 * `sr-only` keeps it out of sight; `select-none` keeps it out of *selections*. Measured in
 * Chromium: a drag that left the terminal extended the document's selection over the pane and a
 * copy put 51 characters of pane text (rows plus prompt) on the clipboard — the mirror holds the
 * entire transcript, so it must never be selectable. It stays in the accessibility tree.
 */
export const TRANSCRIPT_MIRROR_CLASS = "sr-only select-none";

/** The clipboard API, or null when this context has none (plain http, an old browser). */
function clipboard(): ClipboardPort | null {
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
  const rootRef = useRef<HTMLDivElement>(null);

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

  /**
   * Every clipboard action reports the result the same way, and never touches the DOM: the text
   * comes from `terminal.getSelection()` inside `terminal-clipboard.ts` (see that file for the
   * measured reason — the browser's own copy takes the *document's* selection, which includes the
   * pane's transcript mirror).
   */
  const reportClipboard = useCallback((result: ClipboardResult) => {
    setNotice({ kind: result.ok ? "ok" : "error", text: result.notice });
  }, []);

  const copySelection = useCallback(async (): Promise<string | null> => {
    const result = await copyFromTerminal(currentHandle()?.terminal ?? null, clipboard());
    reportClipboard(result);
    return result.ok ? result.text : null;
  }, [reportClipboard]);

  const paste = useCallback(async (): Promise<void> => {
    reportClipboard(await pasteClipboard(currentHandle()?.terminal ?? null, clipboard()));
  }, [reportClipboard]);

  const cut = useCallback(async (): Promise<void> => {
    reportClipboard(await cutFromTerminal(currentHandle()?.terminal ?? null, clipboard()));
  }, [reportClipboard]);

  const clearScreen = useCallback(() => {
    const handle = currentHandle();
    handle?.terminal.clear();
    handle?.focus();
    setNotice({ kind: "ok", text: "Terminal cleared." });
  }, []);

  /**
   * Ctrl/Cmd+C and Ctrl/Cmd+X, handled here rather than by the browser.
   *
   * Measured in Chromium: the header buttons move focus out of the terminal, and after that the
   * browser's own copy takes the *document's* selection — which is the pane, its header and the
   * sr-only transcript mirror — while xterm's copy handler (bound to the terminal element) never
   * runs at all. This listener sits on the panel in the capture phase, so it runs before xterm's
   * textarea handler and can stop the event; with nothing selected it does nothing, because `^C`
   * is how a user interrupts a build.
   */
  useEffect(() => {
    const element = rootRef.current;
    if (element === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = clipboardKeyAction(
        event.key,
        event.ctrlKey || event.metaKey,
        currentHandle()?.terminal.getSelection() ?? "",
      );
      if (action === "passthrough") return;
      event.preventDefault();
      event.stopPropagation();
      void (action === "copy" ? copySelection() : cut());
    };
    element.addEventListener("keydown", onKeyDown, true);
    return () => {
      element.removeEventListener("keydown", onKeyDown, true);
    };
  }, [copySelection, cut]);

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
  const badge: { label: string; tone: StatusTone } =
    active === null
      ? { label: "No shell", tone: "grey" }
      : describeConnection(activeStatus?.connection ?? "connecting");
  const attached = activeStatus?.connection === "connected";
  const modifierHints = [modifiers.ctrl ? "CTRL" : null, modifiers.alt ? "ALT" : null].filter(
    (value): value is string => value !== null,
  );

  return (
    <div
      ref={rootRef}
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
                // A tab is a word, not a pictogram, so it takes the block floor: 44 px tall below
                // `lg` (a 17 px baseline is a thumb miss), its own text height above it.
                className={cn("font-mono text-[11px]", TOUCH_TARGET_BLOCK)}
              >
                {tab.label}
              </button>
              <button
                type="button"
                data-testid={`terminal-tab-close-${tab.id}`}
                // Inline in a 24 px tab row, so it takes the WCAG 2.5.8 floor (24 px) rather
                // than the 32 px the standalone actions use; the test reads `data-inline`.
                data-inline="true"
                aria-label={`Close ${tab.label}`}
                title={`Close ${tab.label}`}
                onClick={() => closeShell(tab.id)}
                className="flex size-6 shrink-0 items-center justify-center rounded text-slate-500 outline-none hover:bg-slate-700 hover:text-slate-100 focus-visible:ring-[3px] focus-visible:ring-sky-400/70"
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
          // 32 px is a pointer's size; a thumb gets the 44 px floor below `lg`, same as every
          // other icon button in the app.
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded text-slate-400 outline-none hover:bg-slate-800 hover:text-slate-100 focus-visible:ring-[3px] focus-visible:ring-sky-400/70 disabled:opacity-40",
            TOUCH_TARGET_ICON,
          )}
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 py-1.5">
        <SquareTerminal aria-hidden="true" className="size-3.5 text-slate-400" />
        <span className="font-mono text-[11px] text-slate-200">{cwd}</span>
        <StatusDot testId="terminal-status" tone={badge.tone} label={badge.label} className="ml-auto" />

        <div className="flex items-center gap-0.5">
          {/* Pictograms, and the terminal's own palette rather than the app's: this strip sits on
              a near-black screen, where `text-muted-foreground` would be unreadable. `IconButton`
              still supplies the accessible name, the tooltip and the 32 px target. */}
          <IconButton
            testId="terminal-copy"
            label="Copy the selection"
            hint="Copy the terminal's selection, not the page's"
            className="size-8 text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
            onClick={() => void copySelection()}
            disabled={!attached}
          >
            <Copy aria-hidden="true" className="size-3.5" />
          </IconButton>
          <IconButton
            testId="terminal-paste"
            label="Paste from the clipboard"
            hint="Paste into the shell at the cursor"
            className="size-8 text-slate-300 hover:bg-slate-800 hover:text-slate-100 disabled:opacity-40"
            onClick={() => void paste()}
            disabled={!attached}
          >
            <ClipboardPaste aria-hidden="true" className="size-3.5" />
          </IconButton>
          <IconButton
            testId="terminal-cut"
            label="Cut: copy the selection and clear the highlight"
            hint="Copy the selection and clear the highlight (a shell's scrollback cannot be removed)"
            tone="stop"
            className="size-8 text-red-300 hover:bg-red-950/60 hover:text-red-100 disabled:opacity-40"
            onClick={() => void cut()}
            disabled={!attached}
          >
            <Scissors aria-hidden="true" className="size-3.5" />
          </IconButton>
          <IconButton
            testId="terminal-clear"
            label="Clear the terminal"
            hint="Clear the terminal's scrollback"
            tone="stop"
            className="size-8 text-red-300 hover:bg-red-950/60 hover:text-red-100 disabled:opacity-40"
            onClick={clearScreen}
            disabled={!attached}
          >
            <Trash2 aria-hidden="true" className="size-3.5" />
          </IconButton>
        </div>
      </div>

      {/* The keys a touch screen does not have. Sticky modifiers show their armed state. */}
      <div
        data-testid="terminal-keys"
        role="toolbar"
        aria-label="Terminal keys"
        // One row that must stay on one line, so the keys share the width: at 44 px per key
        // eight keys plus 2 px gaps fit 390 px exactly, and a wider set scrolls in place rather
        // than pushing the page sideways.
        className="flex items-center gap-1 overflow-x-auto border-b border-slate-800 px-2 py-1 max-lg:gap-0.5 max-lg:px-1"
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
                // A keycap is 22 px tall, which is right for a hardware keyboard's row and wrong
                // for a thumb: below `lg` each key is a 44 x 44 target, still in one row.
                TOUCH_TARGET_ICON,
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
            className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-3 text-center"
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

    // The transcript is buffered and flushed on a timer, so a command that prints
    // thousands of lines costs a handful of renders instead of thousands. The buffer
    // always schedules its own flush: a chunk that arrives moments after the previous
    // flush must not wait for the *next* chunk, because the last line of a command has
    // nothing after it and would otherwise never reach the DOM.
    const transcriptBuffer = new TranscriptBuffer((chunk: string) => {
      setTranscript((previous) => {
        const next = previous + chunk;
        return next.length > TRANSCRIPT_LIMIT ? next.slice(next.length - TRANSCRIPT_LIMIT) : next;
      });
    }, TRANSCRIPT_INTERVAL_MS);

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
          transcriptBuffer.push(text);
        }

        const tail = decoder.decode();
        if (tail.length > 0) {
          terminal.write(tail);
          transcriptBuffer.push(tail);
        }
        transcriptBuffer.flush();

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
      transcriptBuffer.dispose();
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

        `select-none`: the mirror holds the *whole* transcript, and a mouse drag that
        leaves the terminal can otherwise extend the document's selection over it — which
        is how a "copy" of three words could put the entire pane on the clipboard. It stays
        in the accessibility tree; it is only kept out of selections.
      */}
      <pre
        data-testid="terminal-output"
        aria-live="polite"
        aria-atomic="false"
        className={TRANSCRIPT_MIRROR_CLASS}
      >
        {transcript}
      </pre>
    </div>
  );
}

/**
 * The terminal's connection state as one dot, with the words that go in its label.
 *
 * Exported because this mapping is the contract the user reads: a state that is not
 * `connected` must never paint green, and `error` must never paint anything but red. The
 * component test asserts every case, so a new `Connection` member cannot compile without
 * a decision here (the switch is exhaustive and the return type is checked).
 */
export function describeConnection(connection: Connection): {
  label: string;
  tone: StatusTone;
} {
  switch (connection) {
    case "connected":
      return { label: "Connected", tone: "green" };
    case "connecting":
      return { label: "Connecting", tone: "amber" };
    case "ended":
      return { label: "Exited", tone: "grey" };
    case "error":
      return { label: "Failed", tone: "red" };
    case "waiting":
      return { label: "Not connected", tone: "grey" };
  }
}
