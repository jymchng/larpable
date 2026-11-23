/**
 * The seven status facts, as a compact label/value list.
 *
 * The derivation is `src/ui/status-bar.ts`; this file only renders it. The split exists
 * because the *rule* is what needs testing ("green only when its own source says so"), while
 * the markup is what a screenshot shows. Every fact carries three things a dot alone cannot:
 * the word (`Linux`), the value (`ready`, `build-…`, `valid`) and a `title` with the full
 * sentence — so the list is readable by a colour-blind user and by a screen reader, which is
 * the whole reason `StatusDot` takes an accessible label.
 *
 * This used to be a horizontal bar pinned under the header. It is a list inside the debug
 * popover now (user request: "Put all the above in the debug popover … make it more concise"):
 * a band across the window spent a row of height on six facts a person reads when something is
 * wrong, and on a phone it collapsed half its own words to fit. As a list it keeps every label
 * — one fact per line, which is the shape that reads at 390 px without truncating the labels —
 * and it costs the layout nothing until the popover is opened.
 *
 * The `<dl>` is the right element rather than a pile of spans: a fact *is* a term and a value,
 * and a screen reader announces the pair as one. `role="group"` plus the summary keeps the
 * whole set named, so "Linux: Ready · Runtime: …" is still one announcement when the list is
 * entered.
 */

import type { ReactNode } from "react";

import { StatusDot } from "@/ui/components/status-dot";
import {
  deriveStatusSegments,
  summarizeStatus,
  type StatusInput,
  type StatusKey,
  type StatusSegment,
} from "@/ui/status-bar";
import { cn } from "@/lib/utils";

export interface StatusFactsProps {
  input: StatusInput;
  className?: string;
}

export function StatusFacts({ input, className }: StatusFactsProps): ReactNode {
  const segments = deriveStatusSegments(input);

  return (
    <dl
      data-testid="status-facts"
      // One accessible name for the whole set, so a screen reader hears "Linux: ready ·
      // Runtime: node …" instead of six unlabelled dots.
      aria-label={summarizeStatus(segments)}
      role="group"
      className={cn("font-mono text-[11px] leading-tight", className)}
    >
      {segments.map((segment) => (
        <StatusRow key={segment.key} segment={segment} />
      ))}
    </dl>
  );
}

function StatusRow({ segment }: { segment: StatusSegment }): ReactNode {
  return (
    <div
      data-testid={`status-${segment.key}`}
      data-key={segment.key satisfies StatusKey}
      data-tone={segment.tone}
      data-value={segment.value}
      title={segment.detail}
      className="flex min-w-0 items-center gap-1.5"
    >
      <StatusDot testId={`status-dot-${segment.key}`} tone={segment.tone} label={segment.detail} />
      {/* The label is the reason this is a list and not a bar: at 390 px a horizontal bar had
          to hide its words, and "ready" beside a dot could be Linux or the preview. Here the
          word is a fixed column, so the values line up and nothing has to be guessed. */}
      <dt className="text-muted-foreground w-[3.75rem] shrink-0">{segment.label}</dt>
      {/* `truncate` and not `break-all`: a long build id must not widen the popover past the
          viewport, and the full sentence is in the row's `title` and the dot's label. */}
      <dd className="text-foreground min-w-0 flex-1 truncate">{segment.value}</dd>
    </div>
  );
}
