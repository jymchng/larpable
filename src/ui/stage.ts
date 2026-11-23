/**
 * Which pane a phone shows, and how a link can name it.
 *
 * On a laptop the window is wide enough for both halves of this product to be visible at once:
 * the agent on the left, the preview on the right, one resizable divider between them. A phone
 * is not a narrow laptop. Two 400-px-tall panes stacked in a 844-px window gives the transcript
 * four lines and the preview a crop of a website; both are unusable, and a user who scrolls the
 * page to reach the preview loses the prompt box.
 *
 * So below the laptop breakpoint the app shows *one pane at a time* and puts a two-button
 * switcher above it. This module is the vocabulary for that: the two stage names, the label each
 * button wears, the breakpoint, and the parse of a `?pane=preview` link so a URL can point at
 * the half it is about.
 *
 * What is deliberately *not* here: the hiding itself. That is one media query in
 * `globals.css` keyed on `data-stage`, so the rule is the browser's and it applies before
 * hydration, cannot get out of step with a React render, and degrades to "both panes, stacked"
 * in a browser that does not understand the query. The stage is still React state, because a
 * press has to change it; the *consequence* is CSS.
 */

export type PaneStage = "agent" | "preview";

/** The two stages, in the order the switcher shows them. */
export const PANE_STAGES: readonly PaneStage[] = ["agent", "preview"];

/** The laptop breakpoint in CSS pixels: Tailwind's `lg` (64rem at a 16 px root). */
export const STAGE_BREAKPOINT_PX = 1024;

/** The word on the button. Short enough for a 360 px screen, and the pane's own name. */
export const STAGE_LABEL: Record<PaneStage, string> = {
  agent: "Agent",
  preview: "Preview",
};

/** What the button does, for the `aria-label` that a screen reader announces. */
export const STAGE_HINT: Record<PaneStage, string> = {
  agent: "Show the agent conversation and the terminal",
  preview: "Show the preview of the built site",
};

/** The stage a fresh page opens on. The conversation is the entry point, not the result. */
export const DEFAULT_STAGE: PaneStage = "agent";

/** A value from a DOM attribute or a URL: is it one of ours? */
export function isPaneStage(value: unknown): value is PaneStage {
  return value === "agent" || value === "preview";
}

/**
 * The stage a `?pane=` link asks for, or the default.
 *
 * Anything unrecognised is the default rather than an error: a URL is user input, and a
 * mistyped query string should show the app, not a blank pane.
 */
export function stageFromSearch(search: string): PaneStage {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const value = params.get("pane");
  return isPaneStage(value) ? value : DEFAULT_STAGE;
}

/**
 * Whether `pane` is the one the stage is showing.
 *
 * Only the mobile layout reads this; on a laptop both panes are visible whatever the stage
 * says, which is why this is not used to skip rendering the other one. Keeping both panes
 * mounted is what lets a streaming reply keep arriving while the user looks at the preview.
 */
export function stageShows(stage: PaneStage, pane: PaneStage): boolean {
  return stage === pane;
}

/**
 * Whether a viewport of this width is narrow enough to need the switcher.
 *
 * Used by the mobile-support notes, not by the layout: the layout is a media query, so it
 * follows the real window even when this module is never called.
 */
export function needsStageSwitch(width: number): boolean {
  return width < STAGE_BREAKPOINT_PX;
}
