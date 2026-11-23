/**
 * The chat pane: the transcript above, one prompt box below.
 *
 * It renders `ChatState` from `src/ui/chat.ts` and nothing else — no fetching, no session, no
 * timers — so a component test can render a transcript that a scripted loop produced and
 * assert the words. Everything a user must be able to do is a control with a testid:
 *
 * - **type and send** (`chat-input`, `chat-send`), disabled with a *reason* when there is
 *   nothing to send to (no machine, no provider, a run in flight);
 * - **stop a run** (`chat-stop`), which is the §13 "cancellation" half of build progress;
 * - **inspect a tool call** (`chat-tool-output`), which is a `<details>` element rather than
 *   conditional rendering: the output is in the DOM and openable without JavaScript state, so
 *   a static-markup test can prove it is there and a keyboard user can open it.
 *
 * Two honesty rules are in the markup rather than in a comment elsewhere:
 *
 * - A tool row's `data-status` is the loop's own status (`running`/`ok`/`failed`); there is no
 *   fifth "probably fine" state.
 * - When a tool's output or result was clipped, the pane says so (`data-truncated` plus a
 *   sentence), because a silently shortened build log reads as a shorter build.
 */

import { CircleAlert, CircleStop, Info, Loader2, Send } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { IconButton } from "@/ui/components/icon-button";
import { describeChat, type ChatEntry, type ChatState, type ChatToolEntry } from "@/ui/chat";
import { cn } from "@/lib/utils";

export interface ChatPanelProps {
  state: ChatState;
  onSend: (text: string) => void;
  onStop: () => void;
  /**
   * Why the prompt cannot be used right now, or null when it can.
   *
   * A disabled box with no explanation is the single most common way this kind of UI lies;
   * the reason is rendered next to the control, not only in a tooltip.
   */
  unavailableReason: string | null;
  className?: string;
  /** Placeholder for the empty transcript; the caller supplies the product's wording. */
  emptyHint?: string;
}

export function ChatPanel({
  state,
  onSend,
  onStop,
  unavailableReason,
  className,
  emptyHint = "Describe the site you want. The agent writes files in the guest, builds them and previews the result.",
}: ChatPanelProps) {
  const [draft, setDraft] = useState("");
  const blocked = unavailableReason !== null;
  const canSend = !blocked && !state.running && draft.trim().length > 0;

  const submit = () => {
    const text = draft.trim();
    if (text.length === 0 || blocked || state.running) return;
    setDraft("");
    onSend(text);
  };

  return (
    <section
      data-testid="chat-panel"
      aria-label="Agent conversation"
      className={cn("flex min-h-0 flex-1 flex-col", className)}
    >
      <div className="flex items-center gap-1.5 border-b px-2 py-1">
        <p
          data-testid="chat-status"
          aria-live="polite"
          className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]"
        >
          {describeChat(state)}
        </p>
        {state.running ? (
          <IconButton
            testId="chat-stop"
            label="Stop the run"
            hint="Stop the agent after the current tool call"
            tone="stop"
            onClick={onStop}
          >
            <CircleStop aria-hidden="true" />
          </IconButton>
        ) : null}
      </div>

      <ol
        data-testid="chat-transcript"
        aria-label="Transcript"
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-2 py-1.5"
      >
        {state.entries.length === 0 ? (
          <li data-testid="chat-empty" className="text-muted-foreground px-1 py-1.5 text-[13px]">
            {emptyHint}
          </li>
        ) : (
          state.entries.map((entry) => <ChatRow key={entry.id} entry={entry} />)
        )}
      </ol>

      <form
        data-testid="chat-form"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="border-t p-1.5"
      >
        <label htmlFor="chat-prompt" className="sr-only">
          Ask the agent to build or change something
        </label>
        <div className="flex items-end gap-1.5">
          <textarea
            id="chat-prompt"
            data-testid="chat-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a newline: the convention every chat box has, and
              // the only one that lets a user write a multi-line instruction.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            // Focusing the box on a phone scrolls the keyboard up over the composer unless the
            // browser is told to keep it in view; `block: nearest` is the least jarring scroll.
            onFocus={(event) => {
              event.currentTarget.scrollIntoView({ block: "nearest" });
            }}
            rows={2}
            disabled={blocked}
            // The keyboard's action key says "send" instead of "return", which is the one label
            // that makes Enter-to-send discoverable without the tooltip nobody has on a phone.
            enterKeyHint="send"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={
              blocked ? "The agent is not available yet." : "Build me a landing page with a hero…"
            }
            // 16 px below `lg` is not a style choice: iOS Safari zooms the page when a focused
            // field's text is smaller than that, and a zoomed app is a broken app. The laptop
            // size stays 12.5 px, where density is worth more than a magnifier.
            className="border-input bg-background focus-visible:ring-ring min-h-[44px] flex-1 resize-none rounded-md border px-2 py-1.5 font-mono text-base outline-none focus-visible:ring-[3px] disabled:opacity-60 sm:text-[12.5px]"
          />
          {/* Send is the prompt's primary action, so it keeps the filled (primary) variant
              rather than the ghost one: the pictogram is the label, the fill is the emphasis. */}
          <Button
            type="submit"
            size="icon"
            data-testid="chat-send"
            aria-label={state.running ? "Sending…" : "Send the prompt"}
            title="Send the prompt (Enter)"
            disabled={!canSend}
            className="size-11"
          >
            {state.running ? (
              <Loader2 aria-hidden="true" className="size-4 animate-spin" />
            ) : (
              <Send aria-hidden="true" className="size-4" />
            )}
          </Button>
        </div>
        {blocked ? (
          <p
            data-testid="chat-unavailable"
            className="text-muted-foreground mt-1 flex items-start gap-1 text-[11.5px]"
          >
            <Info aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
            {unavailableReason}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function ChatRow({ entry }: { entry: ChatEntry }): ReactNode {
  switch (entry.kind) {
    case "user":
      return (
        <li data-testid="chat-user" className="flex justify-end">
          <p className="bg-primary text-primary-foreground max-w-[85%] rounded-lg px-2 py-1 text-[13px] break-words whitespace-pre-wrap">
            {entry.text}
          </p>
        </li>
      );

    case "assistant":
      return (
        <li
          data-testid="chat-assistant"
          data-streaming={entry.streaming ? "true" : "false"}
          className="text-[13px] break-words whitespace-pre-wrap"
        >
          {entry.text}
          {entry.streaming ? (
            <span
              aria-hidden="true"
              className="bg-foreground ml-0.5 inline-block h-3.5 w-1.5 animate-pulse align-text-bottom"
            />
          ) : null}
        </li>
      );

    case "tool":
      return <ToolRow entry={entry} />;

    case "notice":
      return (
        <li
          data-testid="chat-notice"
          data-tone={entry.tone}
          className={cn(
            "flex items-start gap-1.5 rounded-md border px-1.5 py-1 text-[12px]",
            entry.tone === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : entry.tone === "warn"
                ? "border-warning/30 bg-warning/10"
                : "text-muted-foreground",
          )}
        >
          {entry.tone === "info" ? (
            <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          )}
          {entry.text}
        </li>
      );
  }
}

function ToolRow({ entry }: { entry: ChatToolEntry }): ReactNode {
  return (
    <li
      data-testid="chat-tool"
      data-tool={entry.name}
      data-status={entry.status}
      data-parallel={entry.parallel ? "true" : "false"}
      className="border-border/70 rounded-md border px-1.5 py-1"
    >
      <div className="flex items-center gap-1.5">
        {entry.status === "running" ? (
          <Loader2 aria-hidden="true" className="text-muted-foreground size-3 animate-spin" />
        ) : entry.status === "ok" ? (
          <Badge variant="success" className="px-1 py-0 font-mono text-[10px]">
            ok
          </Badge>
        ) : (
          <Badge variant="destructive" className="px-1 py-0 font-mono text-[10px]">
            failed
          </Badge>
        )}
        <span className="truncate text-[12.5px] font-medium">{entry.label}</span>
        {entry.summary.length > 0 ? (
          <code className="text-muted-foreground truncate font-mono text-[11px]">{entry.summary}</code>
        ) : null}
        {entry.parallel ? (
          <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]">parallel</span>
        ) : null}
        {entry.durationMs !== null ? (
          <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]">
            {entry.durationMs < 1000
              ? `${String(entry.durationMs)} ms`
              : `${(entry.durationMs / 1000).toFixed(1)} s`}
          </span>
        ) : null}
      </div>

      {entry.error !== null ? (
        <p data-testid="chat-tool-error" className="text-destructive mt-1 text-[11.5px]">
          {entry.error}
        </p>
      ) : null}

      {entry.output.length > 0 || entry.result !== null ? (
        <details data-testid="chat-tool-output" className="mt-1">
          <summary className="text-muted-foreground cursor-pointer font-mono text-[10.5px]">
            Output{entry.truncated ? " (shortened)" : ""}
          </summary>
          {entry.output.length > 0 ? (
            <pre className="bg-muted/40 mt-1 max-h-40 overflow-auto rounded p-1.5 font-mono text-[10.5px] break-words whitespace-pre-wrap">
              {entry.output}
            </pre>
          ) : null}
          {entry.result !== null ? (
            <pre className="bg-muted/40 mt-1 max-h-40 overflow-auto rounded p-1.5 font-mono text-[10.5px] break-words whitespace-pre-wrap">
              {entry.result}
            </pre>
          ) : null}
        </details>
      ) : null}
    </li>
  );
}
