/**
 * The status bar: six facts, each one traceable to a source that actually knows it.
 *
 * The derivation is `src/ui/status-bar.ts`; this file only renders it. The split exists
 * because the *rule* is what needs testing ("green only when its own source says so"), while
 * the markup is what a screenshot shows. Every segment carries three things a dot alone
 * cannot: the word (`Linux`), the value (`ready`, `build-…`, `valid`) and a `title` with the
 * full sentence — so the bar is readable by a colour-blind user and by a screen reader, which
 * is the whole reason `StatusDot` takes an accessible label.
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

export interface StatusBarProps {
  input: StatusInput;
  className?: string;
}

export function StatusBar({ input, className }: StatusBarProps): ReactNode {
  const segments = deriveStatusSegments(input);

  return (
    <div
      data-testid="status-bar"
      // One accessible name for the whole bar, so a screen reader hears "Linux: ready ·
      // Runtime: node …" instead of six unlabelled dots.
      aria-label={summarizeStatus(segments)}
      role="group"
      className={cn(
        "bg-muted/40 text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 font-mono text-[11px]",
        className,
      )}
    >
      {segments.map((segment) => (
        <StatusCell key={segment.key} segment={segment} />
      ))}
    </div>
  );
}

function StatusCell({ segment }: { segment: StatusSegment }): ReactNode {
  return (
    <span
      data-testid={`status-${segment.key}`}
      data-key={segment.key satisfies StatusKey}
      data-tone={segment.tone}
      data-value={segment.value}
      title={segment.detail}
      className="flex min-w-0 items-center gap-1"
    >
      <StatusDot testId={`status-dot-${segment.key}`} tone={segment.tone} label={segment.detail} />
      <span className="text-foreground/70">{segment.label}</span>
      <span className="text-foreground max-w-[18ch] truncate">{segment.value}</span>
    </span>
  );
}
