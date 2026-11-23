/**
 * Every notification this app produces, derived from the objects that already know the answer.
 *
 * The rule this module exists to enforce is one sentence long: **a notification is a toast, and
 * its colour is its meaning.** Before it, each announcement had its own surface — a build strip
 * above the frame, a status sentence in the toolbar, a boot line in the header — and each surface
 * was a different distance from the thing it was about, in a different colour, and half of them
 * could not be dismissed. Now there is one list, in one place, with one vocabulary of tones.
 *
 * What a *notification* is, and what it is not:
 *
 * - It **is** something that just happened: a stage started, a build ended, a publish failed, a
 *   machine stopped booting, a `netlify.toml` came back invalid. It is news, it is transient, and
 *   it is worth interrupting for between two and eight seconds.
 * - It **is not** a fact you consult. The guest's served-by badge, the status bar's segments, the
 *   debug popover, a failed preview's own error surface and a failed build's reason in the strip
 *   all stay where they are: they are state, they are read on demand, and a state that vanished
 *   after five seconds would be a worse UI than the one this replaced. Toasts *announce*; panes
 *   *hold*.
 *
 * Two consequences worth stating out loud:
 *
 * - **One notification per source, keyed by `id`.** A build is `build`, the machine is `machine`,
 *   the preview is `preview`, the app server is `app`, the Netlify check is `netlify`. A source
 *   that changes its mind replaces its own toast rather than stacking a second one, and a source
 *   that goes quiet says nothing at all — which is how "installing…" is replaced by "building…"
 *   in the same box instead of piling up.
 * - **The words come from their owners.** `describeBuildProgress`, `describePreviewPhase` and
 *   `describeAppPreview` already speak for their state, and the tests for those sentences are the
 *   tests for these toasts: duplicating the phrasing here is how the two would drift apart.
 */

import { describeEnvironment, statusLabel, type EnvironmentSnapshot } from "@/env/status";
import type { PreviewPhase } from "@/preview/controller";
import { describeBuildProgress, type BuildStatus } from "@/ui/build-state";
import type { NetlifyStatus } from "@/ui/status-bar";
import type { ToastTone } from "@/ui/toast";
import { describeAppPreview, describePreviewPhase } from "@/ui/preview-pane";
import type { AppPreviewState } from "@/ui/use-app-preview";

export interface Notification {
  /** The source. One toast per source: a newer message replaces the older one. */
  id: string;
  message: string;
  tone: ToastTone;
}

export interface NotificationInput {
  environment: EnvironmentSnapshot;
  /** The boot's current stage word, when one is in flight (`use-environment.status`). */
  bootStage: string | null;
  build: BuildStatus;
  preview: PreviewPhase;
  app?: AppPreviewState | undefined;
  netlify: NetlifyStatus;
}

/** A build is news while it runs and when it ends; nothing before the first one. */
function buildNotification(status: BuildStatus): Notification | null {
  switch (status.kind) {
    case "none":
      return null;
    case "running":
      // Blue: work in progress. The step's own words, so "install" and "build" say which.
      return { id: "build", message: describeBuildProgress(status), tone: "info" };
    case "ok":
      // Green: something finished, and the sentence carries the id and the duration.
      return { id: "build", message: describeBuildProgress(status), tone: "success" };
    case "failed":
      // Red: it ended badly, and the reason is in the sentence.
      return { id: "build", message: describeBuildProgress(status), tone: "danger" };
  }
}

/**
 * The machine: starting, ready, or the reason it is not.
 *
 * `idle` and `stopped` say nothing. A machine that has not been asked to boot is not news, and a
 * machine the user shut down is an action they just took — announcing it back to them is noise.
 */
function machineNotification(snapshot: EnvironmentSnapshot, stage: string | null): Notification | null {
  switch (snapshot.status) {
    case "initializing":
    case "booting":
      return {
        id: "machine",
        message: stage === null ? "Starting the Linux machine…" : `Starting the Linux machine: ${stage}`,
        tone: "info",
      };
    case "ready":
      // Green, and one line: the details (distro, CPUs, memory) are facts, and they are in the
      // debug popover where facts belong.
      return { id: "machine", message: `Linux is ${statusLabel("ready").toLowerCase()}.`, tone: "success" };
    case "error":
      return {
        id: "machine",
        message:
          snapshot.error === null
            ? "The Linux machine could not start."
            : `The Linux machine could not start: ${snapshot.error}`,
        tone: "danger",
      };
    case "idle":
    case "stopped":
      return null;
  }
}

/**
 * The preview: a publish that is being prepared, and a publish that failed.
 *
 * A *ready* preview says nothing — the frame appearing is the announcement, and a green "the
 * preview loaded" toast on every publish would be a reward for pressing reload. A failure has its
 * own error surface inside the pane as well; the toast is what makes it visible from the other
 * pane, where the user is probably typing.
 */
function previewNotification(phase: PreviewPhase): Notification | null {
  switch (phase.kind) {
    case "starting":
    case "publishing":
      return { id: "preview", message: describePreviewPhase(phase), tone: "info" };
    case "failed":
      return { id: "preview", message: `The preview could not load: ${phase.message}`, tone: "danger" };
    case "idle":
    case "ready":
      return null;
  }
}

/** The project's own server ("Run the app"): starting, answering, or refusing to. */
function appNotification(state: AppPreviewState | undefined): Notification | null {
  const message = describeAppPreview(state);
  if (message === null) return null;

  const tone: ToastTone =
    state?.kind === "failed" ? "danger" : state?.kind === "running" ? "success" : "info";
  return { id: "app", message, tone };
}

/**
 * The Netlify check, as the agent's own validation reported it.
 *
 * `warning`, not `danger`: an invalid `netlify.toml` stops a deploy, not the machine, and the
 * agent can fix it on the next turn — which is exactly the difference between amber and red.
 */
function netlifyNotification(status: NetlifyStatus): Notification | null {
  switch (status.kind) {
    case "unknown":
      return null;
    case "ok":
      return { id: "netlify", message: "netlify.toml is valid.", tone: "success" };
    case "invalid":
      return {
        id: "netlify",
        message:
          status.errors.length === 1
            ? `netlify.toml has 1 problem: ${status.errors[0] ?? ""}`
            : `netlify.toml has ${String(status.errors.length)} problems: ${status.errors.join("; ")}`,
        tone: "warning",
      };
  }
}

/**
 * Every notification the current state justifies, newest concern last.
 *
 * Order is the order they are raised in, so the last one raised is the newest news: the machine
 * first (nothing else can happen without it), then the build, then the two previews, then the
 * Netlify check that runs after a build.
 */
export function notificationsFor(input: NotificationInput): readonly Notification[] {
  return [
    machineNotification(input.environment, input.bootStage),
    buildNotification(input.build),
    previewNotification(input.preview),
    appNotification(input.app),
    netlifyNotification(input.netlify),
  ].filter((notification): notification is Notification => notification !== null);
}

/**
 * One sentence for the whole app, for the `sr-only` live region that must never regress.
 *
 * Not a notification — `describeEnvironment` is the durable status sentence the screen-reader
 * region has always carried — but it lives here so the two descriptions are read side by side and
 * nobody mistakes one for the other.
 */
export function environmentSentence(snapshot: EnvironmentSnapshot): string {
  return describeEnvironment(snapshot);
}
