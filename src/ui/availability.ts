/**
 * Whether a control can do its job yet — as a function of the machine's *current* status.
 *
 * This module exists because of a measured bug, not a theory. `useAgentChat` and `useBuild`
 * both decided "why can't I act?" inside a `useMemo` that listed the environment object as its
 * only dependency. The environment object is stable across a boot (same instance, new status),
 * so the sentence computed while the machine was idle — and the `disabled` attribute derived
 * from it — survived the transition to `ready`. The browser acceptance run found it exactly
 * where a user would: the prompt box stayed disabled with "The agent is not available yet."
 * after the guest reported Ready.
 *
 * The fix has two halves, and only the second one is interesting:
 *
 * - the hooks now subscribe (`useEnvironmentStatus`), so a status change is a re-render;
 * - the sentence itself is here, a pure function of a status value, so the wording is testable
 *   without a React tree — and a stale closure cannot hide inside it.
 *
 * `missing` is its own case rather than `null`: "there is no machine" and "the machine is
 * stopped" are different sentences, and the first one is what a page shows before anything has
 * been booted at all.
 */

import { statusLabel, type EnvironmentStatus } from "@/env/status";
import { settingsProblem, type LlmSettings } from "@/llm/settings";

/** The machine as a control sees it: a real state, or no machine at all. */
export type MachineStatus = EnvironmentStatus | "missing";

/** A status in the product's own words, lower-case, for the middle of a sentence. */
export function describeMachine(status: MachineStatus): string {
  return status === "missing" ? "not booted" : statusLabel(status).toLowerCase();
}

/**
 * Why the conversation cannot start, or null when it can.
 *
 * Ordered deliberately: a missing key is not worth mentioning while there is no machine to use
 * it with, and a stopped machine is the more actionable problem.
 */
export function chatProblem(status: MachineStatus, settings: LlmSettings): string | null {
  if (status === "missing") {
    return "Boot the Linux environment before asking the agent to build anything.";
  }
  if (status !== "ready") {
    return `The Linux machine is ${describeMachine(status)}, so the agent has no filesystem to work in yet.`;
  }
  return settingsProblem(settings);
}

/** Why a build cannot start, or null when it can. */
export function buildProblem(status: MachineStatus): string | null {
  if (status === "missing") {
    return "Boot the Linux machine before building anything: there is no guest to run the build in.";
  }
  if (status !== "ready") {
    return `The Linux machine is ${describeMachine(status)}, so the build has nowhere to run yet.`;
  }
  return null;
}

/** The machine's status as the two hooks pass it in. */
export function machineStatusOf(environment: { status(): EnvironmentStatus } | null): MachineStatus {
  return environment === null ? "missing" : environment.status();
}
