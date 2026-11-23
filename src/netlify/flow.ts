/**
 * The deployment-configuration step an agent workflow calls.
 *
 * PRD §10's create-project procedure (and its §18.3 counterpart) has three numbered steps
 * for Netlify: generate, validate, and only then claim readiness. This module is that
 * sequence as one call, so the agent cannot perform half of it: inspect the project, sync
 * `netlify.toml`, read the file that is actually on disk, and validate *that* against the
 * same facts — plus the real build output when a build has run.
 *
 * The result carries every intermediate decision, because the whole point of the exercise
 * is to show the user what was concluded and on what evidence. `ok` is the conjunction of
 * "the sync did not block" and "validation found no errors"; warnings survive in `issues`.
 */

import type { ExecutionEnvironment } from "../env/execution";
import {
  inspectProjectFacts,
  type FactsHints,
  type ProjectFacts,
} from "./facts";
import { NETLIFY_CONFIG_FILE, syncNetlifyConfig, type NetlifySyncOutcome } from "./generator";
import { validateNetlifyConfig, type NetlifyBuildOutput, type NetlifyValidation } from "./validator";

export interface EnsureNetlifyConfigOptions {
  /** Project root in the guest. Defaults to the environment's workspace. */
  root?: string;
  /** What the runtime manager measured, and the framework the scaffold chose. */
  hints?: FactsHints;
  /** The last successful build, so `publish` is checked against real output. */
  build?: NetlifyBuildOutput | null;
}

export interface EnsureNetlifyConfigResult {
  facts: ProjectFacts;
  sync: NetlifySyncOutcome;
  /** Validation of the file as it exists on disk *after* the sync. */
  validation: NetlifyValidation;
  /** One line per setting chosen, for the agent's log. */
  decisions: readonly string[];
  /** Guest-absolute path of `netlify.toml`. */
  path: string;
  ok: boolean;
}

export async function ensureNetlifyConfig(
  environment: ExecutionEnvironment,
  options: EnsureNetlifyConfigOptions = {},
): Promise<EnsureNetlifyConfigResult> {
  const facts = await inspectProjectFacts(environment, {
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(options.hints ?? {}),
  });

  const sync = await syncNetlifyConfig(
    environment,
    facts,
    options.root === undefined ? {} : { root: options.root },
  );

  let toml: string | null = null;
  try {
    toml = new TextDecoder().decode(await environment.readFile(sync.path));
  } catch {
    toml = null;
  }

  const validation = validateNetlifyConfig({
    toml,
    // Always validated as the project-root file: that is where the sync writes it, and
    // "exists at the root" is a property of the path the agent promises Netlify.
    path: NETLIFY_CONFIG_FILE,
    facts,
    ...(options.build === undefined ? {} : { build: options.build }),
  });

  return {
    facts,
    sync,
    validation,
    decisions: sync.plan.decisions,
    path: sync.path,
    ok: sync.action !== "blocked" && validation.ok,
  };
}
