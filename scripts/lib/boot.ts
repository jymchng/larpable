/**
 * The one way an acceptance script gets a booted machine.
 *
 * Two changes broke every acceptance script at once, and neither is a bug:
 *
 * 1. the machine now starts itself on load (goal `b90fa622`);
 * 2. the boot / self-test / shut-down controls moved inside the debug popover (goal
 *    `14e53cab`), which is closed by default, so `[data-testid=boot-button]` is
 *    `display:none` until the `d` is pressed *and* is `disabled` while a boot runs.
 *
 * A script that clicks that button unconditionally therefore hangs on a hidden element or
 * presses a dead one. The decisions are not script-specific, so they live here once:
 *
 * - `machineStateFromFooter` reads the always-present summary (`Linux: Ready`, `Linux:
 *   Booting`, …) — the sentence that is visually hidden now (goal `e3778855`) but still in the
 *   DOM as a polite live region, so it is both the screen reader's status and this module's;
 * - `bootDecision` is pure, so the three cases a script must handle — ready, idle,
 *   unsupported — are unit tested instead of being rediscovered per script;
 * - `ensureBooted` does the waiting, opens the popover only when a press is genuinely
 *   needed, and reports which path it took so the transcript says what happened;
 * - `openDiagnostics` is exported on its own because anything else the popover owns (the
 *   self-test button, the six facts) has the same problem.
 *
 * The summary is read rather than `[data-testid=env-status]` because that badge lives
 * inside the popover: waiting for it while the surface is closed waits for a hidden
 * element, which is exactly the trap this module exists to avoid. Reading it is *not* a
 * visibility cheat: `sr-only` content is painted, just clipped, and it is the same text the
 * screen reader announces while a boot runs.
 */

import { setTimeout as sleep } from "node:timers/promises";

import type { Page } from "playwright-core";

/**
 * The live summary: `Linux: Ready | Distro: debian | …`, wherever this build keeps it.
 *
 * One `data-testid` rather than `footer > span`, because the sentence moved into the debug
 * popover and the visible footer is gone (user request: "put all these into the debug
 * popover"). What is left is a visually hidden `aria-live` span in the shell, which is what a
 * screen reader hears and what this reads.
 *
 * The list has three entries because a script may be pointed at a *deployed* site
 * (`LARPABLE_ACCEPTANCE_URL`), and a deployment is whatever was last pushed — not whatever is
 * checked out. Measured on the live site before this fallback existed: the run reported "the
 * machine did not reach Ready within 180000 ms (last footer: \"\")" while that same page was
 * plainly showing `Linux: Ready | Distro: debian …` in its footer, because that build predates
 * the hidden live region. A probe that only knows today's markup invents a failure on a page
 * that works, which is worse than no probe: it is the difference between "the deploy is broken"
 * and "the script is looking at the wrong element".
 *
 *  1. `environment-summary` — the shell's `sr-only` polite live region (current build);
 *  2. `environment-sentence` — the same sentence inside the debug popover (current build, open);
 *  3. `footer` — the band that used to carry it (any older build).
 */
export const FOOTER_STATUS =
  "[data-testid=environment-summary], [data-testid=environment-sentence], footer";
/** The `d` beside the wordmark. */
export const DIAGNOSTICS_TOGGLE = "[data-testid=diagnostics-toggle]";
/** The popover surface itself; it stays in the DOM and carries `data-state`. */
export const DIAGNOSTICS_SURFACE = "#diagnostics-popover";
export const BOOT_BUTTON = "[data-testid=boot-button]";
export const SELF_TEST_BUTTON = "[data-testid=self-test-button]";
/**
 * Where a support problem shows up, in either place it can.
 *
 * The environment card's own alert (`support-problems`) only renders in the card's full mode;
 * inside the debug popover the card is `compact` and the popover's *Requirements* section is
 * what lists the same strings (`requirement-problems`, rendered only when there are any). A
 * helper that looked for one of them would read "supported" on the half of the page that does
 * not render it, so it asks for both. `count()` on a selector list counts the union, which is
 * exactly the question being asked: does this page say it cannot boot anywhere?
 */
export const SUPPORT_PROBLEMS =
  "[data-testid=support-problems], [data-testid=requirement-problems]";

/** What the machine is doing, derived from the footer text alone. */
export type MachineState = "ready" | "booting" | "idle" | "failed" | "unknown";

export type BootAction = "none" | "wait" | "press-boot";

export interface BootObservation {
  /** `false` when the support probe rendered problems: no boot control can work. */
  supported: boolean;
  /** The footer's summary text, trimmed. May be empty before the app paints. */
  footer: string;
}

export interface BootDecision {
  action: BootAction;
  state: MachineState;
  /** One sentence a transcript can print, naming *why* this action. */
  reason: string;
}

/**
 * Map the footer's `Linux: <label>` to a state.
 *
 * `Stopped` is deliberately `idle`, not `failed`: a machine someone shut down should start
 * again when a script asks for it, and calling it a failure would skip the press.
 */
export function machineStateFromFooter(footer: string): MachineState {
  const match = /Linux:\s*([^|]+)/.exec(footer);
  if (!match) return "unknown";

  switch ((match[1] ?? "").trim().toLowerCase()) {
    case "ready":
      return "ready";
    case "initializing":
    case "booting":
      return "booting";
    case "not started":
    case "stopped":
      return "idle";
    case "error":
      return "failed";
    default:
      return "unknown";
  }
}

/** The pure rule. No clicking, no waiting — those are `ensureBooted`'s job. */
export function bootDecision(observation: BootObservation): BootDecision {
  if (!observation.supported) {
    return {
      action: "none",
      state: "unknown",
      reason: "the support probe rendered problems, so no boot control on this page can work",
    };
  }

  const state = machineStateFromFooter(observation.footer);

  switch (state) {
    case "ready":
      return {
        action: "none",
        state,
        reason: `the footer already says ${JSON.stringify(observation.footer.split("|")[0]?.trim())}`,
      };
    case "booting":
      return {
        action: "wait",
        state,
        reason: `the auto-boot is already running (${observation.footer.split("|")[0]?.trim()})`,
      };
    case "idle":
      return {
        action: "press-boot",
        state,
        reason: "the machine is not started, so it needs the Boot control inside the debug popover",
      };
    case "failed":
      return {
        action: "press-boot",
        state,
        reason: "the last boot failed, so the Boot control retries it",
      };
    case "unknown":
      return {
        action: "wait",
        state,
        reason: "the footer does not say what the machine is doing yet",
      };
  }
}

/**
 * Open the debug popover if it is closed. Returns `true` when this call opened it, so a
 * transcript can say whether anything was pressed.
 */
export async function openDiagnostics(page: Page): Promise<boolean> {
  const surface = page.locator(DIAGNOSTICS_SURFACE);
  const state = await surface.getAttribute("data-state").catch(() => null);
  if (state === "open") return false;

  await page.locator(DIAGNOSTICS_TOGGLE).click();
  await surface.waitFor({ state: "visible", timeout: 10_000 });
  return true;
}

async function readObservation(page: Page): Promise<BootObservation> {
  const footer = await readStatusText(page);
  const problems = await page.locator(SUPPORT_PROBLEMS).count();
  return { supported: problems === 0, footer };
}

/**
 * The first status sentence on the page, in `FOOTER_STATUS` order.
 *
 * A selector list plus a text filter rather than `.first()`: the popover's copy is `display:none`
 * while the surface is closed, and an empty `<span>` early in the list must not shadow the one
 * sentence that does say what the machine is doing. `Linux:` is the prefix
 * `describeEnvironment` always writes, so it is the test for "this is the summary".
 *
 * Exported because the scripts print this text in their reports: a run that measured an older
 * deployment should quote that build's own sentence, not `null` from looking at the wrong node.
 */
export async function readStatusText(page: Page): Promise<string> {
  const candidates = page.locator(FOOTER_STATUS);
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const text =
      (await candidates
        .nth(index)
        .textContent({ timeout: 2_000 })
        .catch(() => null)) ?? "";
    if (/Linux:\s*\S/.test(text)) return text.trim();
  }
  return "";
}

export interface EnsureBootedResult {
  /** Which path this run took; printed in the transcript. */
  path: "already ready" | "pressed boot in the debug popover";
  /** The footer text at the moment the machine was ready. */
  footer: string;
  waitedMs: number;
  /** `true` when this helper opened the popover (only possible on the press path). */
  openedDiagnostics: boolean;
}

export class BootHelperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootHelperError";
  }
}

/**
 * Press Boot, unless the machine started itself in the milliseconds since the footer was read.
 *
 * This is the race that failed a run against the live deployment: the footer still said
 * `Linux: Not started`, the decision was correctly "press Boot", and by the time Playwright
 * reached the button the auto-boot had begun — so the click waited 30 s on a `disabled`
 * `aria-label="Booting…"` button and the run reported a deploy that was in fact booting
 * normally. A disabled control is not a failure here, it is evidence that something else is
 * already doing the work, so the press is skipped (or its error swallowed) and the caller goes
 * back to waiting.
 *
 * Returns `true` only when the click actually landed, so the transcript and the `pressed` flag
 * never claim a press that did not happen.
 */
async function pressBoot(
  page: Page,
  supported: boolean,
  log: (line: string) => void,
): Promise<boolean> {
  const button = page.locator(BOOT_BUTTON);

  // The button is the authority on whether something is already running: the app disables it for
  // the whole boot (`aria-label="Booting…"`), so `isEnabled` is a cheaper and truer answer than
  // re-reading the footer, which can still be one frame behind. `supported` keeps the helper
  // honest on a page that cannot boot at all — there is nothing to press there.
  if (!supported) {
    log("boot: the support probe rejected this browser, so Boot is not pressed");
    return false;
  }

  const enabled = await button.isEnabled({ timeout: 5_000 }).catch(() => false);
  if (!enabled) {
    log("boot: the Boot control is disabled, so a boot is already in flight");
    return false;
  }

  try {
    // A short timeout on purpose: a button that disables while the click is in flight is the
    // auto-boot winning the race, and 30 s of Playwright retrying is 30 s of a run saying nothing.
    await button.click({ timeout: 5_000 });
    return true;
  } catch (error) {
    const first = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    log(`boot: the press was raced by the auto-boot (${first}), waiting for it instead`);
    return false;
  }
}

export interface EnsureBootedOptions {
  timeoutMs?: number;
  /** Called with a one-line explanation of each decision, for the run transcript. */
  log?: (line: string) => void;
  /** Poll interval; 500 ms is fast enough to see the spinner and slow enough to be quiet. */
  pollMs?: number;
}

/**
 * Wait until the footer says `Linux: Ready`, pressing Boot only when nothing is running.
 *
 * Throws `BootHelperError` on timeout or on a browser that cannot boot, and the message
 * carries the last footer text — a script that fails should say what the page said.
 */
export async function ensureBooted(
  page: Page,
  options: EnsureBootedOptions = {},
): Promise<EnsureBootedResult> {
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollMs = options.pollMs ?? 500;
  const log = options.log ?? ((): void => undefined);
  const startedAt = Date.now();
  let pressed = false;
  let pressAttempts = 0;
  let openedDiagnostics = false;
  let last: BootObservation = { supported: true, footer: "" };

  while (Date.now() - startedAt < timeoutMs) {
    last = await readObservation(page);
    const decision = bootDecision(last);

    if (decision.action === "none" && decision.state === "ready") {
      log(`boot: ${decision.reason}`);
      return {
        path: pressed ? "pressed boot in the debug popover" : "already ready",
        footer: last.footer,
        waitedMs: Date.now() - startedAt,
        openedDiagnostics,
      };
    }

    if (decision.action === "none") {
      throw new BootHelperError(
        `cannot boot here: ${decision.reason} (footer: ${JSON.stringify(last.footer)})`,
      );
    }

    if (decision.action === "press-boot") {
      if (pressed || pressAttempts >= 3) {
        // One press only: pressing an already-started machine is how a script ends up
        // booting twice and reading the second machine's status. `pressAttempts` bounds the
        // other direction — a press raced by the auto-boot must not become a click every poll.
        log(`boot: still not ready after pressing Boot (${last.footer})`);
      } else {
        log(`boot: ${decision.reason}`);
        openedDiagnostics = await openDiagnostics(page);
        pressAttempts += 1;
        pressed = await pressBoot(page, last.supported, log);
      }
    }

    await sleep(pollMs);
  }

  throw new BootHelperError(
    `the machine did not reach Ready within ${String(timeoutMs)} ms ` +
      `(last footer: ${JSON.stringify(last.footer)})`,
  );
}
