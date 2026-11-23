/**
 * "Can this control act yet?" — the question the browser run caught being answered once and
 * then never again.
 *
 * The measured bug: the prompt box stayed disabled with "The agent is not available yet." after
 * the guest reported Ready in 5.6 s, because the sentence was computed in a `useMemo` keyed on
 * the environment *object*, which does not change across a boot. The hooks now subscribe
 * (`useMachineStatus`) and the sentence lives here, as a pure function of a status value — so
 * the wording and the ordering of the reasons are covered without a React tree, and the
 * browser run covers the reactivity.
 */

import { describe, expect, it } from "vitest";

import { defaultSettings, type LlmSettings } from "../src/llm/settings";
import {
  buildProblem,
  chatProblem,
  describeMachine,
  machineStatusOf,
} from "../src/ui/availability";

const demo = defaultSettings();
const keyless: LlmSettings = { provider: "openai", model: "gpt-4o-mini", apiKey: "" };

describe("describeMachine", () => {
  it("says 'not booted' when there is no machine at all", () => {
    expect(describeMachine("missing")).toBe("not booted");
  });

  it("uses the status bar's own words, lower-cased for mid-sentence use", () => {
    expect(describeMachine("ready")).toBe("ready");
    expect(describeMachine("idle")).toBe("not started");
    expect(describeMachine("initializing")).toBe("initializing");
    expect(describeMachine("booting")).toBe("booting");
    expect(describeMachine("error")).toBe("error");
    expect(describeMachine("stopped")).toBe("stopped");
  });
});

describe("machineStatusOf", () => {
  it("keeps 'no environment' distinct from the environment's own idle", () => {
    expect(machineStatusOf(null)).toBe("missing");
    expect(machineStatusOf({ status: () => "idle" })).toBe("idle");
  });
});

describe("chatProblem", () => {
  it("says there is nothing to talk to before a machine exists", () => {
    expect(chatProblem("missing", demo)).toBe(
      "Boot the Linux environment before asking the agent to build anything.",
    );
  });

  it("names the machine's state while it is not ready, for every state", () => {
    for (const status of ["idle", "initializing", "booting", "error", "stopped"] as const) {
      const problem = chatProblem(status, demo);
      expect(problem).toBe(
        `The Linux machine is ${describeMachine(status)}, so the agent has no filesystem to work in yet.`,
      );
    }
  });

  it("is null when the machine is ready and the demo provider needs no key", () => {
    expect(chatProblem("ready", demo)).toBeNull();
  });

  it("defers to the settings problem only once the machine can act", () => {
    const problem = chatProblem("ready", keyless);
    expect(problem).not.toBeNull();
    expect(problem).toMatch(/key/i);
    // Before the machine is ready the key is not the more actionable problem.
    expect(chatProblem("booting", keyless)).toContain("booting");
  });
});

describe("buildProblem", () => {
  it("says there is no guest to run a build in before a machine exists", () => {
    expect(buildProblem("missing")).toBe(
      "Boot the Linux machine before building anything: there is no guest to run the build in.",
    );
  });

  it("names the machine's state while it is not ready", () => {
    expect(buildProblem("stopped")).toBe(
      "The Linux machine is stopped, so the build has nowhere to run yet.",
    );
    expect(buildProblem("idle")).toBe(
      "The Linux machine is not started, so the build has nowhere to run yet.",
    );
  });

  it("is null exactly when a build can start", () => {
    expect(buildProblem("ready")).toBeNull();
    for (const status of ["idle", "initializing", "booting", "error", "stopped"] as const) {
      expect(buildProblem(status)).not.toBeNull();
    }
  });
});
