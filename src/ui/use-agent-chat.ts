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
import { statusLabel } from "@/env/status";
import type { BuildPort, NetlifyPort, PreviewPort } from "@/agent/tools/types";
import { describeFindings } from "@/agent/claims";
import { createProvider, settingsProblem, type LlmSettings } from "@/llm/settings";
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
  problem: string | null;
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

  const problem = useMemo(() => {
    if (environment === null) return "Boot the Linux environment before asking the agent to build anything.";
    const status = environment.status();
    if (status !== "ready") {
      return `The Linux machine is ${statusLabel(status).toLowerCase()}, so the agent has no filesystem to work in yet.`;
    }
    return settingsProblem(settings);
  }, [environment, settings]);

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

  return { state, send, stop, reset, problem };
}
