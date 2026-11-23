/**
 * The phone's pane switcher: two controls, 44 px tall, one of them current.
 *
 * This is the control that makes a phone usable rather than merely not broken. Both panes are in
 * the DOM (so a streaming reply keeps arriving while the user reads the preview), the CSS decides
 * which one is on screen, and this component is the only way to change that decision.
 *
 * Design notes, because they are choices rather than defaults:
 *
 * - **`aria-pressed`, not `role="tab"`.** A tablist promises a panel that exists only while its
 *   tab is selected, and roving tabindex arithmetic; here both panels are always present, and the
 *   two buttons behave exactly like the preview's device toolbar, which already uses pressed
 *   buttons. One pattern in the app, not two.
 * - **An icon *and* a word.** The icon is recognition, the word is certainty: "Agent" and
 *   "Preview" are short enough to fit at 360 px, so hiding them behind a pictogram would trade a
 *   real word for a guess. The words are also what a screen reader announces.
 * - **The preview tab can carry a dot.** When a build is published while the user is reading the
 *   conversation, the Preview button says so quietly (a green dot, labelled for assistive tech)
 *   instead of the app jumping panes under the user's finger.
 * - **`lg:hidden`.** From the laptop breakpoint up, both panes are visible and this control is
 *   noise.
 */

import { MessagesSquare, MonitorPlay } from "lucide-react";
import type { ReactNode } from "react";

import { StatusDot } from "@/ui/components/status-dot";
import {
  PANE_STAGES,
  STAGE_HINT,
  STAGE_LABEL,
  type PaneStage,
} from "@/ui/stage";
import { TOUCH_TARGET_BLOCK } from "@/ui/touch";
import { cn } from "@/lib/utils";

const STAGE_ICON: Record<PaneStage, ReactNode> = {
  agent: <MessagesSquare aria-hidden="true" className="size-4" />,
  preview: <MonitorPlay aria-hidden="true" className="size-4" />,
};

/** The panel each button controls, so a screen reader's "controls" relationship is real. */
const STAGE_PANEL_ID: Record<PaneStage, string> = {
  agent: "agent-pane",
  preview: "preview-pane",
};

export interface StageSwitcherProps {
  stage: PaneStage;
  onChange: (stage: PaneStage) => void;
  /**
   * True when the preview holds a published build. Only used while the user is *not* on the
   * preview stage: a dot on the button you are already looking at says nothing.
   */
  previewReady?: boolean;
}

export function StageSwitcher({ stage, onChange, previewReady = false }: StageSwitcherProps): ReactNode {
  return (
    <div
      data-testid="stage-switcher"
      role="group"
      aria-label="Which pane to show"
      className="bg-card/60 flex items-stretch gap-1 border-b p-1 lg:hidden"
    >
      {PANE_STAGES.map((pane) => {
        const selected = pane === stage;
        return (
          <button
            key={pane}
            type="button"
            data-testid={`stage-tab-${pane}`}
            data-selected={selected ? "true" : "false"}
            aria-pressed={selected}
            aria-controls={STAGE_PANEL_ID[pane]}
            aria-label={STAGE_HINT[pane]}
            onClick={() => onChange(pane)}
            className={cn(
              TOUCH_TARGET_BLOCK,
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 text-[13px] font-medium transition-colors",
              selected
                ? "bg-primary/15 text-foreground shadow-xs"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            {STAGE_ICON[pane]}
            <span>{STAGE_LABEL[pane]}</span>
            {pane === "preview" && previewReady && !selected ? (
              <StatusDot
                testId="stage-preview-ready"
                tone="green"
                label="A build is published and ready to look at"
              />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
