/**
 * The build, as the UI knows it — derived from the build manager's own records.
 *
 * PRD §13 asks for build progress and cancellation. The temptation is to keep a boolean in the
 * pane ("building…") and flip it back on any answer; that is how a failed build ends up shown
 * as a success. `BuildManager` already returns a `BuildResult` per attempt with `ok`, a
 * failure record and a log, and keeps every attempt in `history()`. So this module does one
 * thing: turn that record of attempts into the four states the UI renders, and let the pane
 * say which attempt it is talking about.
 *
 * The type lives here (not in `status-bar.ts`) because the status bar is a *consumer* of it:
 * the bar must be derivable from a build status without importing the pane.
 */

import type { BuildResult } from "@/build/manager";

/** The build, as the UI knows it. */
export type BuildStatus =
  | { kind: "none" }
  | { kind: "running"; stage: "installing" | "building" }
  | { kind: "ok"; id: string; durationMs: number | null }
  | { kind: "failed"; summary: string };

export function initialBuild(): BuildStatus {
  return { kind: "none" };
}

/** What the build manager (or a test) reports while work is in flight. */
export type BuildProgressEvent =
  | { kind: "installing" }
  | { kind: "building" }
  | { kind: "built"; id: string; durationMs: number | null }
  | { kind: "failed"; summary: string }
  | { kind: "reset" };

/**
 * Fold one progress event into the status.
 *
 * `building` is deliberately *not* reachable from `ok`: an install step after a successful
 * build is a rebuild, so both progress events start a new attempt and both are amber. Nothing
 * here can turn a failure into a success — only a `built` event can, and it carries the id.
 */
export function applyBuildProgress(status: BuildStatus, event: BuildProgressEvent): BuildStatus {
  switch (event.kind) {
    case "installing":
      return { kind: "running", stage: "installing" };
    case "building":
      return { kind: "running", stage: "building" };
    case "built":
      return { kind: "ok", id: event.id, durationMs: event.durationMs };
    case "failed":
      return { kind: "failed", summary: event.summary };
    case "reset":
      return initialBuild();
  }
}

/** The failure sentence a build result carries, without inventing one when it has none. */
export function summarizeBuildFailure(result: BuildResult): string {
  if (result.ok) return "";
  const failure = result.failure;
  if (failure === null) return "the build failed without a recorded reason";
  const detail = failure.detail.trim();
  return detail.length > 0 ? detail : failure.kind;
}

/**
 * The status implied by a build history, oldest first.
 *
 * An empty history is `none` — not "ok", and not "failed". The last attempt decides: a
 * successful rebuild after a failure is an `ok` status, and a failure after a success is a
 * failure, because the newest attempt is the one the user is looking at. `lastSuccessfulBuild`
 * is still what the preview serves; that is a different question from "how did it go".
 */
export function buildStatusFromHistory(history: readonly BuildResult[]): BuildStatus {
  const last = history[history.length - 1];
  if (last === undefined) return initialBuild();
  if (last.ok) {
    return { kind: "ok", id: last.id, durationMs: last.durationMs };
  }
  return { kind: "failed", summary: summarizeBuildFailure(last) };
}

/**
 * One sentence for `aria-live`, so a screenshot-less reader knows what changed.
 *
 * Kept next to the derivation rather than in the component: the same sentence is asserted by
 * `tests/build-state.test.ts`, which is how "the bar says building while it builds" is a
 * property and not a screenshot.
 */
export function describeBuildProgress(status: BuildStatus): string {
  switch (status.kind) {
    case "none":
      // Silent when nothing has happened: the strip's own controls say what they would do, and a
      // sentence announcing that no build exists is noise on a fresh pane (removed on request).
      return "";
    case "running":
      return status.stage === "installing"
        ? "Installing dependencies in the guest…"
        : "Building the site in the guest…";
    case "ok":
      return status.durationMs === null
        ? `Build ${status.id} succeeded.`
        : `Build ${status.id} succeeded in ${(status.durationMs / 1000).toFixed(1)} s.`;
    case "failed":
      return `The build failed: ${status.summary}`;
  }
}
