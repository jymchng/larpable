/**
 * "DO NOT DUPLICATE: YOU ALREADY HAVE A TOAST" — as a test.
 *
 * The rule is about a sentence appearing twice: once in a pane, once in a toast, at the same
 * moment. This file renders the three panes that used to carry the machine's own words and
 * asserts that the words are *gone* from all of them, while the notification list still has them.
 *
 * It is deliberately written against the same string the user asked about, because that string is
 * the example the rule was made from: a person reading the screen should meet it once.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { INITIAL_ENVIRONMENT } from "../src/env/status";
import { ChatPanel } from "../src/ui/chat-panel";
import { initialChat } from "../src/ui/chat";
import { PreviewPane } from "../src/ui/preview-pane";
import { TerminalPanel } from "../src/ui/terminal-panel";
import type { PreviewPhase } from "../src/preview/controller";
import { PREVIEW_PREFIX } from "../src/preview/routing";
import { chatProblem } from "../src/ui/availability";
import { notificationsFor } from "../src/ui/notifications";
import { defaultSettings } from "../src/llm/settings";

/** The sentence the rule was made from, produced by the module that owns it. */
const MACHINE_SENTENCE = chatProblem("booting", defaultSettings());

const ready: PreviewPhase = {
  kind: "ready",
  buildId: "build-mf3k2-1",
  url: `${PREVIEW_PREFIX}/build-mf3k2-1/`,
  files: 3,
  served: "worker",
  note: null,
};

describe("the machine's state is announced once", () => {
  it("is the toast's sentence, and it is still produced", () => {
    expect(MACHINE_SENTENCE).toBe(
      "The Linux machine is booting, so the agent has no filesystem to work in yet.",
    );
    const notes = notificationsFor({
      environment: { ...INITIAL_ENVIRONMENT, status: "booting" },
      bootStage: "compiled",
      build: { kind: "none" },
      preview: { kind: "idle" },
      app: undefined,
      netlify: { kind: "unknown" },
    });
    expect(notes.map((note) => note.id)).toEqual(["machine"]);
    expect(notes[0]?.message).toBe("Starting the Linux machine: compiled");
  });

  it("is not printed under the prompt box", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        state={initialChat()}
        onSend={() => undefined}
        onStop={() => undefined}
        unavailableReason={null}
        blocked
        blockedReason={MACHINE_SENTENCE}
      />,
    );

    // No inline paragraph — not even the empty container for one.
    expect(html).not.toContain('data-testid="chat-unavailable"');
    // The sentence appears exactly once in the whole pane: as the send button's tooltip.
    expect(html.split("has no filesystem to work in yet")).toHaveLength(2);
    // The composer is still gated, and the reason still reachable without being laid out.
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).toContain(`title="${MACHINE_SENTENCE}"`);
  });

  it("is not printed at the bottom of the terminal", () => {
    const html = renderToStaticMarkup(
      <TerminalPanel
        ready={false}
        cwd="/workspace"
        openShell={null}
        unavailableReason="The Linux machine is booting, so the terminal has no shell yet."
      />,
    );

    expect(html).toContain('data-testid="terminal-empty"');
    expect(html).not.toContain("the terminal has no shell yet");
  });

  it("is not printed above the preview frame", () => {
    const html = renderToStaticMarkup(
      <PreviewPane
        phase={ready}
        onRefresh={() => undefined}
        available
        build={{
          status: { kind: "none" },
          busy: false,
          problem: "The Linux machine is booting, so the build has nowhere to run yet.",
          run: () => undefined,
          cancel: () => undefined,
          port: null,
        }}
      />,
    );

    // No line above the frame, and no strip for a build that has not even started.
    expect(html).not.toContain('data-testid="preview-build-problem"');
    expect(html).not.toContain('data-testid="preview-build-strip"');
    // The sentence survives exactly once, and as the disabled hammer's *tooltip* — a place a user
    // asks, rather than a line every user reads twice.
    expect(html.split("the build has nowhere to run yet")).toHaveLength(2);
    expect(html).toContain('title="The Linux machine is booting, so the build has nowhere to run yet."');
  });
});
