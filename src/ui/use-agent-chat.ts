/**
 * The chat, wired to one agent session and one guest.
 *
 * This is the seam between `src/agent/session.ts` (which owns the provider, the tools and the
 * conversation) and `src/ui/chat-controller.ts` (which owns the transcript). Both are already
 * testable on their own; what this hook adds is *lifetime*, and that is the part with the bug
 * surface:
 *
 * - **One session per (guest, provider, model, key).** Changing any of them would otherwise
 *   keep talking to the old API with the old key, or to a guest that no longer exists.
 * - **No session before the machine is ready.** Creating one against a stopped kernel produces
 *   tools that fail in their own words, which reads as the agent's fault rather than the
 *   machine's; the hook refuses instead and the panel prints the reason.
 * - **The key travels as a secret.** `secrets` is what `session.send` redacts out of every
 *   tool result and out of the transcript, so a key in an error message cannot reach the
 *   screen, the guest or the persisted conversation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ExecutionEnvironment } from "@/env/execution";
import type { AgentSession } from "@/agent/session";
import { createAgentSession } from "@/agent/session";
import { chatProblem } from "@/ui/availability";
import { settingsProblem } from "@/llm/settings";
import { useMachineStatus } from "@/ui/use-environment-status";
import type { BuildPort, NetlifyPort, PreviewPort } from "@/agent/tools/types";
import { describeFindings } from "@/agent/claims";
import { createProvider, type LlmSettings } from "@/llm/settings";
import { createChatController, type ChatController } from "@/ui/chat-controller";
import type { ChatState } from "@/ui/chat";
import { initialChat } from "@/ui/chat";

export interface UseAgentChatOptions {
  environment: ExecutionEnvironment | null;
  settings: LlmSettings;
  build?: BuildPort | null;
  netlify?: NetlifyPort | null;
  preview?: PreviewPort | null;
  /** Guest-absolute project root. Defaults to the environment's workspace. */
  root?: string;
}

export interface AgentChatControl {
  state: ChatState;
  send: (text: string) => void;
  stop: () => void;
  reset: () => void;
  /** Why the prompt is unusable right now, or null. Rendered next to the box. */
  /**
   * The *configuration* gap: a missing key, a model that is not set. Printed in the composer,
   * because nothing else says it and nothing happened that a toast could announce.
   *
   * The machine's own state is deliberately not in here any more (user request: "DO NOT
   * DUPLICATE: YOU ALREADY HAVE A TOAST"): "The Linux machine is booting, so the agent has no
   * filesystem to work in yet." was printed under the prompt *and* announced as a blue toast at
   * the top of the same window. `blocked` and `blockedReason` below carry that half without
   * laying it out.
   */
  problem: string | null;
  /** True when a turn cannot be sent at all, whatever the draft says. */
  blocked: boolean;
  /** The whole reason, machine included — for the send button's tooltip, never for the layout. */
  blockedReason: string | null;
}

export function useAgentChat(options: UseAgentChatOptions): AgentChatControl {
  const { environment, settings, build, netlify, preview, root } = options;

  const [state, setState] = useState<ChatState>(initialChat());
  const sessionRef = useRef<AgentSession | null>(null);
  const controllerRef = useRef<ChatController | null>(null);

  // The session reads the *current* options; the ref is what `send` sees, so a re-render with
  // new ports does not force a new conversation.
  const optionsRef = useRef({ environment, settings, build, netlify, preview, root });
  optionsRef.current = { environment, settings, build, netlify, preview, root };

  // The status is subscribed state, not a call made during render: a memo over the
  // environment object would freeze the "not available yet" sentence at boot time — measured
  // in the browser run, where the prompt stayed disabled after the guest reported Ready.
  const machine = useMachineStatus(environment);
  const blockedReason = useMemo(() => chatProblem(machine, settings), [machine, settings]);
  // Only the settings half is rendered: the machine half is a toast (see `notifications.ts`).
  const problem = useMemo(() => settingsProblem(settings), [settings]);

  const controller = useMemo(() => {
    return createChatController({
      sendTurn: async ({ prompt, signal, onEvent }) => {
        const current = optionsRef.current;
        const machine = current.environment;
        if (machine === null) {
          throw new Error("There is no Linux machine to run this turn against.");
        }
        if (sessionRef.current === null) {
          sessionRef.current = createAgentSession({
            provider: createProvider(current.settings),
            environment: machine,
            ...(current.root === undefined ? {} : { root: current.root }),
            build: current.build ?? null,
            netlify: current.netlify ?? null,
            preview: current.preview ?? null,
            secrets: current.settings.apiKey.trim().length > 0 ? [current.settings.apiKey] : [],
          });
        }
        const session = sessionRef.current;
        const result = await session.send(prompt, { signal, onEvent });
        return {
          stop: result.stop,
          reason: result.reason,
          claim: { ok: result.claims.ok, summary: describeFindings(result.claims).join(" ") },
        };
      },
    });
  }, []);

  useEffect(() => {
    controllerRef.current = controller;
    setState(controller.state());
    return controller.subscribe(setState);
  }, [controller]);

  // A different guest, provider, model or key is a different conversation: the tool context
  // and the credentials both changed under it.
  useEffect(() => {
    sessionRef.current = null;
    controller.reset();
  }, [controller, environment, settings.provider, settings.model, settings.apiKey]);

  const send = useCallback(
    (text: string) => {
      if (problem !== null) return;
      controller.send(text);
    },
    [controller, problem],
  );

  const stop = useCallback(() => controller.stop(), [controller]);
  const reset = useCallback(() => {
    sessionRef.current = null;
    controller.reset();
  }, [controller]);

  return { state, send, stop, reset, problem, blocked: blockedReason !== null, blockedReason };
}
