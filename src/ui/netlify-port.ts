/**
 * The Netlify flow, narrowed to the port the agent's tools receive.
 *
 * `ensureNetlifyConfig` in `src/netlify/flow.ts` does the work: inspect the project, sync
 * `netlify.toml`, read the file back, validate it. This adapter adds one fact the flow cannot
 * know on its own — **the last successful build**. Without it the publish check can only say
 * "skipped", and §10 requires the agent to prove `publish` against real output before
 * claiming the project is deployable.
 *
 * The build is read at call time, not at construction: a tool may run before the first build
 * and again after it, and the second call must see the newer answer.
 */

import type { NetlifyPort } from "@/agent/tools/types";
import type { BuildResult } from "@/build/manager";
import type { ExecutionEnvironment } from "@/env/execution";
import { ensureNetlifyConfig, type EnsureNetlifyConfigResult } from "@/netlify/flow";
import type { NetlifyBuildOutput } from "@/netlify/validator";
import { netlifyStatusFrom, type NetlifyStatus } from "@/ui/status-bar";

export interface NetlifyPortOptions {
  environment: ExecutionEnvironment;
  /** Default guest-absolute project root. A call's own `root` still wins. */
  root?: string;
  /** Read lazily, so a call after a build validates against that build. */
  lastBuild?: () => BuildResult | null;
  /**
   * Every call's verdict, so the status bar can stop saying "not validated".
   *
   * The port is the only place in the app that runs the Netlify flow, so it is also the only
   * place that can report the outcome without guessing. The status bar is a *consumer*: it
   * receives the verdict rather than re-deriving it from the conversation.
   */
  onVerdict?: (verdict: NetlifyStatus) => void;
}

/**
 * The reasons a Netlify run did not pass, in the order a reader needs them.
 *
 * A blocked sync outranks the validator's summary: when the project could not justify a
 * configuration at all, "netlify.toml: nothing to validate" is the honest sentence, and the
 * planner's own problems say why. Validation errors win when they exist, because they name a
 * concrete setting in the file that was written.
 */
export function netlifyErrors(result: EnsureNetlifyConfigResult): string[] {
  const errors = result.validation.issues
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.message);
  if (errors.length > 0) return errors;
  if (result.sync.action === "blocked") return [result.sync.reason];
  if (!result.ok) return [result.validation.summary];
  return [];
}

/**
 * One run's outcome as the status bar's vocabulary.
 *
 * `attempted: true` even for a failure: "invalid" and "nothing tried yet" are different facts,
 * and a red segment is the honest one after a run that did not pass.
 */
export function netlifyVerdict(result: EnsureNetlifyConfigResult): NetlifyStatus {
  return netlifyStatusFrom({ attempted: true, ok: result.ok, errors: netlifyErrors(result) });
}

/**
 * A `BuildResult` as the validator's build evidence, or null.
 *
 * `entryExists` is `entryPoint !== null`: the manager only records an entry point after it
 * has read that file back and checked it looks like HTML, so "there is an entry point" and
 * "`dist/index.html` exists" are the same fact. A failed build is null — its output
 * directory may hold a half-written tree, and validating `publish` against that would be a
 * guess dressed as evidence.
 */
export function toNetlifyBuildOutput(result: BuildResult | null): NetlifyBuildOutput | null {
  if (result === null || !result.ok) return null;
  return { dir: result.outputDir, entryExists: result.entryPoint !== null };
}

export function createNetlifyPort(options: NetlifyPortOptions): NetlifyPort {
  return {
    ensure: async (ensureOptions = {}) => {
      const root = ensureOptions.root ?? options.root;
      const result = await ensureNetlifyConfig(options.environment, {
        ...(root === undefined ? {} : { root }),
        build: toNetlifyBuildOutput(options.lastBuild?.() ?? null),
      });
      // Published after the run, from the run's own record. A throw above reaches no verdict,
      // which is right: an exception is not an answer about `netlify.toml`.
      options.onVerdict?.(netlifyVerdict(result));
      return result;
    },
  };
}
