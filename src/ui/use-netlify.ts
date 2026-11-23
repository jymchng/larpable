/**
 * The Netlify verdict, wired to one booted guest.
 *
 * `src/netlify/flow.ts` already does the work (inspect, sync, read back, validate) and
 * `src/ui/netlify-port.ts` narrows it to the port the agent's `ensure_netlify_config` tool
 * receives. What was missing is the *report*: the status bar kept saying "not validated"
 * because nothing carried the flow's outcome out of the tool call.
 *
 * Two properties make this the right seam:
 *
 * - **The verdict comes from the run, not from the conversation.** `onVerdict` fires inside
 *   `ensure`, so the bar turns green only for a run whose `ok` was computed from the file that
 *   is actually on disk. Parsing tool messages would make the bar a second validator.
 * - **The build is read at call time.** `lastBuild` is forwarded lazily, so a validation after
 *   a build checks `publish` against that build's real output, and one before it does not
 *   pretend a `dist/` exists.
 *
 * The hook itself is only lifetime: one port per machine, and a verdict belongs to the machine
 * and project it was measured on, so a new guest resets the segment to "not validated".
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { NetlifyPort } from "@/agent/tools/types";
import type { BuildResult } from "@/build/manager";
import type { ExecutionEnvironment } from "@/env/execution";
import { createNetlifyPort } from "@/ui/netlify-port";
import type { NetlifyStatus } from "@/ui/status-bar";

export interface UseNetlifyOptions {
  /** The booted machine, or null before boot. */
  environment: ExecutionEnvironment | null;
  /** Guest project root. Defaults to the environment's workspace. */
  root?: string;
  /** The last successful build, read at call time so a later call sees the newer answer. */
  lastBuild?: () => BuildResult | null;
}

export interface NetlifyControl {
  /** What the last run concluded, for the status bar. */
  status: NetlifyStatus;
  /** The port the agent's Netlify tool receives, or null before the machine exists. */
  port: NetlifyPort | null;
}

const UNKNOWN: NetlifyStatus = { kind: "unknown" };

export function useNetlify(options: UseNetlifyOptions): NetlifyControl {
  const { environment, root, lastBuild } = options;

  // Read at call time: a build that finished after this render must still be seen.
  const lastBuildRef = useRef(lastBuild);
  lastBuildRef.current = lastBuild;

  const [status, setStatus] = useState<NetlifyStatus>(UNKNOWN);

  const port = useMemo(() => {
    if (environment === null) return null;
    return createNetlifyPort({
      environment,
      ...(root === undefined ? {} : { root }),
      lastBuild: () => lastBuildRef.current?.() ?? null,
      onVerdict: setStatus,
    });
  }, [environment, root]);

  useEffect(() => {
    setStatus(UNKNOWN);
  }, [port]);

  return { status, port };
}
