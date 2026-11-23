/**
 * The browser chrome around the preview: a tab strip, a navigation bar with an address bar,
 * and a device toolbar.
 *
 * The point of drawing a browser here is not nostalgia. A preview is the user's only view of
 * what they built, and every real browser gives them four affordances that answer "where am I
 * and can I go back": a tab naming the page, a Back arrow, an address bar showing the URL, and
 * a reload. A bare iframe offers none of them, so a previewed site that navigated to `/about`
 * looked identical to the home page and the URL was unknowable.
 *
 * Three rules keep the imitation honest, and they are visible in the markup rather than only in
 * the prose:
 *
 * - **Nothing is invented.** The address bar is a read-only input showing the URL the frame is
 *   actually on (`/__preview__/<buildId>/<path>`), and it is a real input so the URL can be
 *   selected and copied, which is what people do with an address bar. Back and forward are
 *   `disabled` whenever the pane's history has nowhere to go, which at the start of every build
 *   is both of them.
 * - **The tab names the build.** Two publishes of the same project are two documents; the tab
 *   carries the build id in mono so a screenshot of the pane says which build it shows.
 * - **The device toolbar sizes the frame and says so.** It is not a phone: no touch events, no
 *   device pixel ratio. The size readout is exact (`834 × 1112`) and the note that accompanies
 *   it is the one `viewport.ts` already writes for the vault of the same claim.
 */

import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Lock,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
} from "lucide-react";
import type { ReactNode } from "react";

import { VIEWPORTS, describeViewport, type ViewportName, type ViewportPreset } from "@/ui/viewport";
import { cn } from "@/lib/utils";

/**
 * One tab, naming what is loaded.
 *
 * A single tab is what a browser with one document looks like, so there is exactly one and no
 * `+`: a second tab would have nothing to put in it. `role="tab"`/`aria-selected` rather than a
 * div with a class, so the strip reads as a tab strip to a screen reader.
 */
export function PreviewTabStrip({
  title,
  buildId,
}: {
  /** The pane's name for the document: "Website preview", "App preview". */
  title: string;
  /** The build the frame is showing, or null when there is nothing loaded. */
  buildId: string | null;
}): ReactNode {
  const loaded = buildId !== null;

  return (
    <div
      data-testid="preview-tab-strip"
      role="tablist"
      aria-label="Preview tabs"
      className="bg-muted/40 flex h-8 items-end gap-1 border-b px-2"
    >
      <div
        role="tab"
        aria-selected="true"
        aria-label={loaded ? `${title}, ${buildId}` : title}
        data-testid="preview-tab"
        data-build-id={buildId ?? ""}
        data-loaded={loaded ? "true" : "false"}
        className={cn(
          "flex h-7 max-w-[22rem] min-w-0 items-center gap-1.5 rounded-t-md border border-b-0 px-2.5",
          loaded ? "bg-background" : "bg-muted/60 text-muted-foreground",
        )}
      >
        <Globe aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
        <span className="truncate text-[12px] font-medium">{title}</span>
        {buildId !== null ? (
          <span
            data-testid="preview-tab-build"
            className="text-muted-foreground shrink-0 font-mono text-[10.5px]"
            title={`Build ${buildId}`}
          >
            {buildId}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** One arrow or the reload control. A real `button`, sized for a mouse and a thumb. */
function NavButton({
  testId,
  label,
  title,
  disabled,
  onClick,
  children,
}: {
  testId: string;
  label: string;
  title: string;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}): ReactNode {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={title}
      disabled={disabled ?? false}
      onClick={onClick}
      className={cn(
        "text-foreground/80 flex size-7 shrink-0 items-center justify-center rounded-full transition-colors",
        "hover:bg-accent hover:text-foreground",
        // A disabled arrow must look disabled, not merely be unclickable: the whole point of
        // the two arrows here is that the user can see there is no history yet.
        "disabled:text-muted-foreground/50 disabled:hover:bg-transparent disabled:cursor-default",
      )}
    >
      {children}
    </button>
  );
}

export interface PreviewBrowserBarProps {
  /** The URL shown in the address bar. Empty when nothing is loaded. */
  address: string;
  /** The frame's origin, when the caller knows it; the address bar shows the path otherwise. */
  origin?: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  /** True while there is no document to re-navigate (nothing published). */
  reloadDisabled?: boolean;
  /** Right-hand controls, e.g. "New tab" and fullscreen. */
  children?: ReactNode;
}

/**
 * Back, forward, reload, and the address.
 *
 * The three arrows are where the honesty lives. Back and forward are `disabled` from the pane's
 * own history (`preview-browser.ts`), and reload is disabled only when there is no document at
 * all \u2014 a browser with an empty tab cannot reload one either.
 */
export function PreviewBrowserBar({
  address,
  origin = null,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
  onReload,
  reloadDisabled = false,
  children,
}: PreviewBrowserBarProps): ReactNode {
  const empty = address.length === 0;

  return (
    <div
      data-testid="preview-browser-bar"
      className="bg-muted/40 flex items-center gap-1 border-b px-1.5 py-1"
    >
      <NavButton
        testId="preview-back"
        label="Back"
        title={canGoBack ? "Back to the previous page in this build" : "No earlier page in this build to go back to"}
        disabled={!canGoBack}
        onClick={onBack}
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
      </NavButton>

      <NavButton
        testId="preview-forward"
        label="Forward"
        title={canGoForward ? "Forward to the next page in this build" : "Nothing to go forward to"}
        disabled={!canGoForward}
        onClick={onForward}
      >
        <ArrowRight aria-hidden="true" className="size-4" />
      </NavButton>

      <NavButton
        testId="preview-reload"
        label="Reload"
        title={reloadDisabled ? "Publish a build before reloading it" : "Load this URL again from the published build"}
        disabled={reloadDisabled}
        onClick={onReload}
      >
        <RotateCw aria-hidden="true" className="size-3.5" />
      </NavButton>

      {/* A pill, like every browser's omnibox, so it reads as an address rather than a field
          the user is expected to type into. The input is read-only: the preview URL is derived
          from the build and the frame's own path, never from typed text. */}
      <div
        className={cn(
          "bg-background mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border px-2.5",
          empty && "text-muted-foreground",
        )}
      >
        <Lock aria-hidden="true" className="text-muted-foreground/70 size-3 shrink-0" />
        {origin !== null ? (
          <span
            data-testid="preview-address-origin"
            className="text-muted-foreground shrink-0 font-mono text-[11px]"
          >
            {origin}
          </span>
        ) : null}
        <input
          data-testid="preview-address"
          aria-label="Preview address"
          aria-readonly="true"
          readOnly
          value={address}
          placeholder="Nothing loaded yet"
          spellCheck={false}
          // No `onChange`: React refuses a value/readOnly input without one unless it is told
          // the value is fixed. This is the fixed-value form.
          onChange={() => undefined}
          className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] outline-none"
        />
      </div>

      {children}
    </div>
  );
}

export interface PreviewDeviceToolbarProps {
  /** The preset that is sizing the frame. */
  viewport: ViewportPreset;
  /** Absent when the caller has no viewport state: the buttons then render unpressable. */
  onChange?: (name: ViewportName) => void;
}

/**
 * Desktop / tablet / mobile, as the device toolbar of a devtools pane.
 *
 * `aria-pressed` and not a `<select>`: the three choices are visible at once and the current one
 * has to be readable by a screen reader. The size readout next to them is the *claim* \u2014 exact
 * CSS pixels for a preset, "full width" for the one that follows the window \u2014 and the note
 * under it is the limit: no touch events, no device pixel ratio.
 */
export function PreviewDeviceToolbar({
  viewport,
  onChange,
}: PreviewDeviceToolbarProps): ReactNode {
  const ICONS: Readonly<Record<ViewportName, ReactNode>> = {
    desktop: <Monitor aria-hidden="true" className="size-3.5" />,
    tablet: <Tablet aria-hidden="true" className="size-3.5" />,
    mobile: <Smartphone aria-hidden="true" className="size-3.5" />,
  };

  return (
    <div
      data-testid="preview-device-toolbar"
      role="group"
      aria-label="Preview device"
      className="bg-muted/20 flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1"
    >
      <div
        data-testid="preview-viewports"
        role="group"
        aria-label="Preview viewport"
        className="border-border bg-background flex items-center overflow-hidden rounded-md border"
      >
        {VIEWPORTS.map((preset) => {
          const selected = preset.name === viewport.name;
          return (
            <button
              key={preset.name}
              type="button"
              data-testid={`preview-viewport-${preset.name}`}
              data-selected={selected ? "true" : "false"}
              aria-pressed={selected}
              title={describeViewport(preset)}
              onClick={onChange === undefined ? undefined : () => onChange(preset.name)}
              className={cn(
                "flex h-7 items-center gap-1 px-1.5 font-mono text-[10.5px] transition-colors",
                selected ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {ICONS[preset.name]}
              {preset.label}
            </button>
          );
        })}
      </div>

      <span
        data-testid="preview-device-size"
        className="text-muted-foreground shrink-0 font-mono text-[10.5px]"
        title={describeViewport(viewport)}
      >
        {viewport.width === null || viewport.height === null
          ? "full width"
          : `${String(viewport.width)} × ${String(viewport.height)}`}
      </span>

      <span
        data-testid="preview-viewport-status"
        className="text-muted-foreground/80 min-w-0 flex-1 truncate text-[10.5px]"
      >
        {describeViewport(viewport)}
      </span>
    </div>
  );
}
