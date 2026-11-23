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
import { ensureNetlifyConfig } from "@/netlify/flow";
import type { NetlifyBuildOutput } from "@/netlify/validator";

export interface NetlifyPortOptions {
  environment: ExecutionEnvironment;
  /** Default guest-absolute project root. A call's own `root` still wins. */
  root?: string;
  /** Read lazily, so a call after a build validates against that build. */
  lastBuild?: () => BuildResult | null;
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
      return ensureNetlifyConfig(options.environment, {
        ...(root === undefined ? {} : { root }),
        build: toNetlifyBuildOutput(options.lastBuild?.() ?? null),
      });
    },
  };
}
