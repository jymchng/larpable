/**
 * The chat pane's markup.
 *
 * Rendered with `renderToStaticMarkup` like the rest of the UI tests, because what matters is
 * what the browser receives: a prompt box that is present, a *reason* next to a disabled one,
 * a tool row whose status is the loop's own, and a visible admission when a log was clipped.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatPanel } from "../src/ui/chat-panel";
import { initialChat, type ChatState, type ChatToolEntry } from "../src/ui/chat";

function render(state: ChatState, unavailableReason: string | null = null): string {
  return renderToStaticMarkup(
    <ChatPanel state={state} onSend={() => undefined} onStop={() => undefined} unavailableReason={unavailableReason} />,
  );
}

const failedTool: ChatToolEntry = {
  kind: "tool",
  id: "call-1",
  name: "build_project",
  label: "Building the site",
  summary: "/workspace",
  parallel: false,
  status: "failed",
  error: "compile",
  durationMs: 1200,
  output: "vite build\n",
  result: "The build failed: TS2307",
  truncated: true,
};

describe("ChatPanel", () => {
  it("always has a prompt box and a send control, §13's starting point", () => {
    const html = render(initialChat());
    expect(html).toContain('data-testid="chat-input"');
    expect(html).toContain('data-testid="chat-send"');
    expect(html).toContain('data-testid="chat-form"');
    expect(html).toContain('id="chat-prompt"');
  });

  it("explains an empty transcript without a status line saying there are no messages", () => {
    const html = render(initialChat());
    expect(html).toContain('data-testid="chat-empty"');
    expect(html).toContain("Describe the site you want.");
    // Removed on request: "No messages yet." was a band of chrome over an empty pane that the
    // hint below already explains. With nothing to say, there is no row at all.
    expect(html).not.toContain("No messages yet.");
    expect(html).not.toContain('data-testid="chat-status"');
  });

  it("cannot send an empty draft", () => {
    const html = render(initialChat());
    expect(html).toMatch(/data-testid="chat-send"[^>]*disabled=""/);
  });

  it("disables the box with a stated reason, not a silent one", () => {
    const html = render(initialChat(), "Boot the Linux environment before asking the agent to build anything.");
    expect(html).toMatch(/data-testid="chat-input"[^>]*disabled=""/);
    expect(html).toContain('data-testid="chat-unavailable"');
    expect(html).toContain("Boot the Linux environment");
    expect(html).toContain("The agent is not available yet.");
  });

  it("offers Stop only while a run is in flight", () => {
    expect(render({ ...initialChat(), running: true })).toContain('data-testid="chat-stop"');
    expect(render(initialChat())).not.toContain('data-testid="chat-stop"');
  });

  it("reports a tool row with the loop's own status", () => {
    const html = render({
      entries: [failedTool],
      running: false,
      toolsRunning: 0,
      lastStop: "tool-errors",
    });
    expect(html).toContain('data-tool="build_project"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain("Building the site");
    expect(html).toContain("1.2 s");
    expect(html).toContain('data-testid="chat-tool-error"');
  });

  it("keeps a clipped tool log openable, and says it was shortened", () => {
    const html = render({ entries: [failedTool], running: false, toolsRunning: 0, lastStop: null });
    expect(html).toContain("<details");
    expect(html).toContain('data-testid="chat-tool-output"');
    expect(html).toContain("Output (shortened)");
  });

  it("renders a stop as a notice with its tone", () => {
    const html = render({
      entries: [{ kind: "notice", id: "stop-cancelled", tone: "info", text: "You cancelled this run." }],
      running: false,
      toolsRunning: 0,
      lastStop: "cancelled",
    });
    expect(html).toContain('data-testid="chat-notice"');
    expect(html).toContain('data-tone="info"');
    expect(html).toContain("You cancelled this run.");
    expect(html).toContain("The last run was cancelled.");
  });

  it("marks a streamed answer as still streaming, and a finished one as not", () => {
    const streaming = render({
      entries: [{ kind: "assistant", id: "assistant-1", iteration: 1, text: "Writing index.html", streaming: true }],
      running: true,
      toolsRunning: 0,
      lastStop: null,
    });
    expect(streaming).toContain('data-streaming="true"');

    const finished = render({
      entries: [{ kind: "assistant", id: "assistant-1", iteration: 1, text: "Writing index.html", streaming: false }],
      running: false,
      toolsRunning: 0,
      lastStop: "complete",
    });
    expect(finished).toContain('data-streaming="false"');
    expect(finished).toContain("Ready for the next instruction.");
  });

  it("shows the user's own words in the transcript", () => {
    const html = render({
      entries: [{ kind: "user", id: "user-1", text: "Build me a portfolio" }],
      running: false,
      toolsRunning: 0,
      lastStop: null,
    });
    expect(html).toContain('data-testid="chat-user"');
    expect(html).toContain("Build me a portfolio");
  });

  it("counts running tool calls in the status line", () => {
    const html = render({ ...initialChat(), running: true, toolsRunning: 2 });
    expect(html).toContain("2 tool calls running");
  });
});
