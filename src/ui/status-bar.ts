/**
 * The live status bar: six facts about the machine, each traced to the thing that owns it.
 *
 * PRD §13 asks for an environment status bar driven by *real* state — Linux, runtime, project,
 * build, Netlify and preview. The temptation is to paint a plausible stripe ("Ready · node ·
 * demo · built · deployed · live") and update it from ad-hoc component state, which is how a
 * status bar ends up lying: green while the kernel is still booting, "valid" for a
 * `netlify.toml` no one validated, a build id from a build that failed.
 *
 * So the derivation is a pure function over the four objects that already know the answers —
 * `EnvironmentSnapshot`, the build status the build hook publishes, the Netlify verdict the
 * agent session recorded, and the preview controller's phase. `tests/status-bar.test.ts`
 * asserts every state, including the ones that must *not* be green.
 *
 * The rule the tests enforce: a segment is green only when its own source says so, grey when
 * nothing has been attempted yet, amber while something is in progress, red on failure.
 */

import type { EnvironmentSnapshot } from "@/env/status";
import { statusLabel } from "@/env/status";
import type { PreviewPhase } from "@/preview/controller";
import type { BuildStatus } from "@/ui/build-state";
import type { StatusTone } from "@/ui/components/status-dot";

/**
 * The build, as the UI knows it.
 *
 * The type is *owned* by `src/ui/build-state.ts`, which has the build manager's records to
 * derive it from; this module only renders it. Re-exported so a consumer that derives the bar
 * has one import.
 */
export type { BuildStatus };

/** `netlify.toml`, as the agent's own validation reported it. */
export type NetlifyStatus =
  | { kind: "unknown" }
  | { kind: "ok" }
  | { kind: "invalid"; errors: readonly string[] };

export interface ProjectStatus {
  /** The project's name, when a project is open. */
  name: string | null;
  /** Guest-absolute workspace root, always known once a machine exists. */
  root: string;
}

export type StatusKey = "linux" | "runtime" | "project" | "build" | "netlify" | "preview";

export interface StatusSegment {
  key: StatusKey;
  /** The static word for this fact, e.g. `Linux`. */
  label: string;
  /** The current value, short enough for a toolbar. */
  value: string;
  tone: StatusTone;
  /** The full sentence, for `title` and the accessible name. */
  detail: string;
}

export interface StatusInput {
  environment: EnvironmentSnapshot;
  project: ProjectStatus | null;
  build: BuildStatus;
  netlify: NetlifyStatus;
  preview: PreviewPhase;
}

function linuxSegment(snapshot: EnvironmentSnapshot): StatusSegment {
  const tone: StatusTone =
    snapshot.status === "ready"
      ? "green"
      : snapshot.status === "error"
        ? "red"
        : snapshot.status === "booting" || snapshot.status === "initializing"
          ? "amber"
          : "grey";
  const detail = [
    `Linux: ${statusLabel(snapshot.status)}`,
    snapshot.distro === null ? "" : snapshot.distro,
    snapshot.cpus === null ? "" : `${String(snapshot.cpus)} CPUs`,
    snapshot.memoryMiB === null ? "" : `${String(snapshot.memoryMiB)} MiB`,
    snapshot.error === null ? "" : snapshot.error,
  ]
    .filter((part) => part.length > 0)
    .join(" · ");
  return { key: "linux", label: "Linux", value: statusLabel(snapshot.status), tone, detail };
}

function runtimeSegment(snapshot: EnvironmentSnapshot): StatusSegment {
  const detected = snapshot.runtime !== null && snapshot.runtime.trim().length > 0;
  const tone: StatusTone = detected ? "green" : snapshot.status === "error" ? "red" : "grey";
  return {
    key: "runtime",
    label: "Runtime",
    value: detected ? snapshot.runtime ?? "" : "not detected",
    tone,
    detail: detected
      ? `Runtime: ${snapshot.runtime ?? ""} (detected in the guest)`
      : "Runtime: not detected yet — the guest's node/npm is warmed on first use.",
  };
}

function projectSegment(project: ProjectStatus | null): StatusSegment {
  if (project === null) {
    return {
      key: "project",
      label: "Project",
      value: "none",
      tone: "grey",
      detail: "Project: no project is open.",
    };
  }
  const name = project.name;
  return {
    key: "project",
    label: "Project",
    value: name ?? project.root,
    tone: name === null ? "grey" : "green",
    detail:
      name === null
        ? `Project: the default workspace at ${project.root}.`
        : `Project: ${name} at ${project.root}`,
  };
}

/** How a build states itself, and whether that may be green. */
export function describeBuildStatus(build: BuildStatus): StatusSegment {
  switch (build.kind) {
    case "none":
      return {
        key: "build",
        label: "Build",
        value: "none",
        tone: "grey",
        detail: "Build: no build has run in this session.",
      };
    case "running":
      return {
        key: "build",
        label: "Build",
        value: build.stage === "installing" ? "installing" : "building",
        tone: "amber",
        detail:
          build.stage === "installing"
            ? "Build: installing dependencies in the guest."
            : "Build: running the production build in the guest.",
      };
    case "ok":
      return {
        key: "build",
        label: "Build",
        value: build.id,
        tone: "green",
        detail:
          build.durationMs === null
            ? `Build: ${build.id} succeeded.`
            : `Build: ${build.id} succeeded in ${String(build.durationMs)} ms.`,
      };
    case "failed":
      return {
        key: "build",
        label: "Build",
        value: "failed",
        tone: "red",
        detail: `Build failed: ${build.summary}`,
      };
  }
}

function netlifySegment(netlify: NetlifyStatus): StatusSegment {
  switch (netlify.kind) {
    case "unknown":
      return {
        key: "netlify",
        label: "Netlify",
        value: "not validated",
        tone: "grey",
        detail: "netlify.toml: nothing has been generated or validated in this session.",
      };
    case "ok":
      return {
        key: "netlify",
        label: "Netlify",
        value: "valid",
        tone: "green",
        detail: "netlify.toml: written and validated with no errors.",
      };
    case "invalid":
      return {
        key: "netlify",
        label: "Netlify",
        value: `${String(netlify.errors.length)} error${netlify.errors.length === 1 ? "" : "s"}`,
        tone: "red",
        detail:
          netlify.errors.length === 0
            ? "netlify.toml: validation failed."
            : `netlify.toml: ${netlify.errors.join("; ")}`,
      };
  }
}

/** The preview, in the controller's own vocabulary. */
export function describePreviewStatus(phase: PreviewPhase): StatusSegment {
  switch (phase.kind) {
    case "idle":
      return {
        key: "preview",
        label: "Preview",
        value: "none",
        tone: "grey",
        detail: "Preview: no build has been published yet.",
      };
    case "starting":
      return { key: "preview", label: "Preview", value: "starting", tone: "amber", detail: phase.detail };
    case "publishing":
      return { key: "preview", label: "Preview", value: "publishing", tone: "amber", detail: phase.detail };
    case "ready":
      return {
        key: "preview",
        label: "Preview",
        value: phase.buildId,
        tone: phase.served === "worker" ? "green" : "amber",
        detail:
          phase.served === "worker"
            ? `Preview: ${String(phase.files)} files served at ${phase.url} by the preview worker.`
            : `Preview: served from the guest on demand at ${phase.url} (${String(phase.files)} files)${phase.note === null ? "" : ` — ${phase.note}`}.`,
      };
    case "failed":
      return { key: "preview", label: "Preview", value: "failed", tone: "red", detail: phase.message };
  }
}

/** All six segments, in the order the bar shows them. */
export function deriveStatusSegments(input: StatusInput): StatusSegment[] {
  return [
    linuxSegment(input.environment),
    runtimeSegment(input.environment),
    projectSegment(input.project),
    describeBuildStatus(input.build),
    netlifySegment(input.netlify),
    describePreviewStatus(input.preview),
  ];
}

/** The bar as one sentence: the accessible name, and what a screenshot cannot show. */
export function summarizeStatus(segments: readonly StatusSegment[]): string {
  return segments.map((segment) => `${segment.label}: ${segment.value}`).join(" · ");
}

/** The Netlify verdict from what an agent turn's evidence recorded. */
export function netlifyStatusFrom(evidence: {
  attempted: boolean;
  ok: boolean;
  errors: readonly string[];
}): NetlifyStatus {
  if (!evidence.attempted) return { kind: "unknown" };
  return evidence.ok ? { kind: "ok" } : { kind: "invalid", errors: evidence.errors };
}
