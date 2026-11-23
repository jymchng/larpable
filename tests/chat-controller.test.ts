/**
 * The turn, driven without React.
 *
 * The panel is markup; this file drives the object the buttons actually call, so "one turn at a
 * time", "Stop aborts the signal", "a cancellation is shown once" and "a thrown error ends the
 * turn" are properties of the controller rather than of a screenshot.
 */

import { describe, expect, it } from "vitest";

import { createChatController, type ChatTurnRequest } from "../src/ui/chat-controller";
import type { ChatState } from "../src/ui/chat";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Let a settled promise's continuations run. */
function tick(): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, 0);
  });
}

function notices(state: ChatState) {
  return state.entries.filter((entry) => entry.kind === "notice");
}

describe("createChatController", () => {
  it("puts the user's words in the transcript before the loop starts", () => {
    const gate = deferred<never>();
    const controller = createChatController({
      sendTurn: () => gate.promise,
      nextId: () => "user-1",
    });

    controller.send("  build me a landing page  ");

    const state = controller.state();
    expect(state.running).toBe(true);
    expect(state.entries[0]).toMatchObject({ kind: "user", id: "user-1", text: "build me a landing page" });
  });

  it("ignores a blank prompt", () => {
    const controller = createChatController({ sendTurn: () => deferred<never>().promise });
    controller.send("   ");
    expect(controller.state().entries).toHaveLength(0);
    expect(controller.state().running).toBe(false);
  });

  it("runs one turn at a time rather than queueing a second", () => {
    const gate = deferred<never>();
    const prompts: string[] = [];
    const controller = createChatController({
      sendTurn: (request) => {
        prompts.push(request.prompt);
        return gate.promise;
      },
    });

    controller.send("first");
    controller.send("second");

    expect(prompts).toEqual(["first"]);
    expect(controller.state().entries).toHaveLength(1);
  });

  it("folds the loop's events into the transcript as they arrive", () => {
    const gate = deferred<never>();
    const seen: { request: ChatTurnRequest | null } = { request: null };
    const controller = createChatController({
      sendTurn: (request) => {
        seen.request = request;
        return gate.promise;
      },
    });

    controller.send("build it");
    seen.request?.onEvent({ type: "text", delta: "Writing index.html", iteration: 1 });
    seen.request?.onEvent({
      type: "tool-start",
      call: { id: "call-1", name: "build_project", arguments: '{"path":"/workspace"}' },
      iteration: 1,
      parallel: false,
    });

    expect(controller.state().entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant", text: "Writing index.html" }),
        expect.objectContaining({ kind: "tool", name: "build_project", status: "running" }),
      ]),
    );
    expect(controller.state().toolsRunning).toBe(1);
  });

  it("publishes every change to its subscribers", () => {
    const gate = deferred<never>();
    const controller = createChatController({ sendTurn: () => gate.promise });
    const seen: boolean[] = [];
    const unsubscribe = controller.subscribe((state) => seen.push(state.running));

    controller.send("go");
    unsubscribe();
    controller.stop();

    expect(seen).toEqual([true]);
  });

  it("aborts the turn's signal on stop, and never shows two notices for it", async () => {
    const gate = deferred<{ stop: "cancelled"; reason: string }>();
    const controller = createChatController({ sendTurn: () => gate.promise });

    controller.send("go");
    const signal = controller.activeSignal();
    expect(signal).not.toBeNull();

    controller.stop();

    expect(signal?.aborted).toBe(true);
    expect(controller.state().running).toBe(false);
    expect(notices(controller.state())).toHaveLength(1);

    // The loop settles late with its own cancelled outcome; the turn is already closed.
    gate.resolve({ stop: "cancelled", reason: "You cancelled this run." });
    await tick();

    expect(notices(controller.state())).toHaveLength(1);
    expect(controller.activeSignal()).toBeNull();
  });

  it("ends the turn with a notice when sendTurn throws", async () => {
    const controller = createChatController({
      sendTurn: async () => {
        throw new Error("OpenAI needs an API key.");
      },
    });

    controller.send("go");
    await tick();

    const state = controller.state();
    expect(state.running).toBe(false);
    expect(state.lastStop).toBe("provider-error");
    expect(notices(state).map((notice) => notice.text)).toEqual(["OpenAI needs an API key."]);
  });

  it("appends the claims verdict when the reply claimed more than the tools showed", async () => {
    const controller = createChatController({
      sendTurn: async () => ({
        stop: "complete",
        reason: "Done.",
        claim: { ok: false, summary: "build-not-verified: the build was never run." },
      }),
    });

    controller.send("ship it");
    await tick();

    expect(controller.state().lastStop).toBe("complete");
    expect(notices(controller.state()).map((notice) => notice.text)).toEqual([
      "That reply claims more than the tools showed: build-not-verified: the build was never run.",
    ]);
  });

  it("adds no notice for a clean finish", async () => {
    const controller = createChatController({
      sendTurn: async () => ({ stop: "complete", reason: "Ready for the next instruction." }),
    });

    controller.send("ship it");
    await tick();

    expect(notices(controller.state())).toHaveLength(0);
  });

  it("forgets the transcript and cancels work on reset", async () => {
    const gate = deferred<never>();
    const controller = createChatController({ sendTurn: () => gate.promise });

    controller.send("go");
    const signal = controller.activeSignal();
    controller.reset();

    expect(signal?.aborted).toBe(true);
    expect(controller.state().entries).toHaveLength(0);
    expect(controller.state().running).toBe(false);
    expect(controller.activeSignal()).toBeNull();
  });
});
