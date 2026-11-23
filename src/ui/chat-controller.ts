/**
 * The chat, driven without React.
 *
 * `src/ui/chat.ts` folds one event into one state; something has to own the *turn*: start it,
 * hand the loop an `AbortSignal`, fold every event while it runs, and turn whatever happened
 * (a clean stop, a cancellation, a thrown provider error) into a finished transcript. That is
 * this file, and it is deliberately not a hook: the acceptance run and the unit tests drive
 * the same object the panel subscribes to, so "Stop cancels the run" is asserted on the thing
 * the button actually calls.
 *
 * Three behaviours are load-bearing:
 *
 * - **One turn at a time.** A second `send()` while running is ignored rather than queued:
 *   `AgentSession.send` throws on a concurrent call, and two interleaved turns on one guest
 *   would mix their tool calls in the transcript.
 * - **Cancellation is a first-class ending.** `stop()` aborts the signal and the turn settles
 *   with a visible notice; an abort that arrives after the turn finished does nothing.
 * - **A thrown error ends the turn too.** If `sendTurn` rejects (a provider that cannot be
 *   constructed, a bug in the loop), the transcript gets a notice instead of a spinner that
 *   never stops.
 */

import type { AgentEvent, AgentStopReason } from "@/agent/loop";
import {
  applyAgentEvent,
  beginTurn,
  claimNotice,
  endTurn,
  initialChat,
  type ChatState,
} from "@/ui/chat";

/** What a finished turn reports back: how it stopped, why, and what the claims check found. */
export interface ChatTurnOutcome {
  stop: AgentStopReason;
  /** One sentence from the loop, already in the product's voice. */
  reason: string;
  /** The claims check's verdict, when the caller ran one. */
  claim?: { ok: boolean; summary: string };
}

export interface ChatTurnRequest {
  prompt: string;
  signal: AbortSignal;
  /** Every loop event, as it happens. */
  onEvent: (event: AgentEvent) => void;
}

export interface ChatControllerDeps {
  sendTurn: (request: ChatTurnRequest) => Promise<ChatTurnOutcome>;
  /** Id source for the user's entry. Injected so a test can be deterministic. */
  nextId?: () => string;
}

export interface ChatController {
  state(): ChatState;
  subscribe(listener: (state: ChatState) => void): () => void;
  /** Start a turn. Ignored while one is running, or when the text is blank. */
  send(text: string): void;
  /** Abort the turn in flight. Safe when nothing is running. */
  stop(): void;
  /** Forget the transcript, keeping the controller. */
  reset(): void;
  /** The signal of the turn in flight, so a test can assert that Stop aborted it. */
  activeSignal(): AbortSignal | null;
}

let fallbackSequence = 0;

export function createChatController(deps: ChatControllerDeps): ChatController {
  let state = initialChat();
  /**
   * The turn in flight. `settled` is what keeps Stop's immediate notice and the loop's own
   * ending from both landing: whichever happens first closes the turn, and the other is a
   * no-op. Without it a cancelled turn shows "You cancelled this run." twice.
   */
  let active: { controller: AbortController; settled: boolean } | null = null;
  const listeners = new Set<(state: ChatState) => void>();

  const nextId = deps.nextId ?? (() => {
    fallbackSequence += 1;
    return `user-${String(fallbackSequence)}`;
  });

  function publish(next: ChatState): void {
    state = next;
    for (const listener of listeners) listener(state);
  }

  function finish(outcome: ChatTurnOutcome): void {
    let next = endTurn(state, { stop: outcome.stop, detail: outcome.reason });
    if (outcome.claim !== undefined) {
      const notice = claimNotice(outcome.claim.ok, outcome.claim.summary);
      if (notice !== null) next = { ...next, entries: [...next.entries, notice] };
    }
    publish(next);
  }

  return {
    state() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    send(text) {
      const prompt = text.trim();
      if (prompt.length === 0) return;
      if (state.running) return;

      const turn = { controller: new AbortController(), settled: false };
      active = turn;
      publish(beginTurn(state, prompt, nextId()));

      const settle = (outcome: ChatTurnOutcome) => {
        if (turn.settled) return;
        turn.settled = true;
        finish(outcome);
      };

      void (async () => {
        try {
          const outcome = await deps.sendTurn({
            prompt,
            signal: turn.controller.signal,
            onEvent: (event) => {
              if (turn.settled) return;
              publish(applyAgentEvent(state, event));
            },
          });
          settle(outcome);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          settle({
            stop: turn.controller.signal.aborted ? "cancelled" : "provider-error",
            reason: turn.controller.signal.aborted ? "You cancelled this run." : message,
          });
        } finally {
          if (active === turn) active = null;
        }
      })();
    },

    stop() {
      const turn = active;
      if (turn === null) return;
      turn.controller.abort();
      active = null;
      // Immediate, so the button does what it says; the loop's own ending is then suppressed
      // by `settled`, because a second notice for one cancellation reads like two runs.
      if (!turn.settled) {
        turn.settled = true;
        publish(endTurn(state, { stop: "cancelled", detail: "You cancelled this run." }));
      }
    },

    reset() {
      if (active !== null) {
        active.settled = true;
        active.controller.abort();
        active = null;
      }
      publish(initialChat());
    },

    activeSignal() {
      return active?.controller.signal ?? null;
    },
  };
}
