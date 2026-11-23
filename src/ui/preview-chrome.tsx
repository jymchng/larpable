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
 *   device pixel ratio. The size is exact (`834 × 1112`) and the note that accompanies it is the
 *   one `viewport.ts` already writes for the claim. Both now live in the *tooltip* of the button
 *   that applies them rather than in a readout of their own: the row used to print a number
 *   permanently that is only interesting while the user is choosing between the three, so it is
 *   printed exactly then — on hover, or on a keyboard focus — and the row goes back to three
 *   pictograms. `components/tooltip.tsx` owns the bubble; this file owns the words in it.
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
import { useEffect, useState, type ReactNode } from "react";

import {
  VIEWPORTS,
  viewportLimit,
  viewportSize,
  type ViewportName,
  type ViewportPreset,
} from "@/ui/viewport";
import { IconButton } from "@/ui/components/icon-button";
import { TOOLTIP_ANCHOR, Tooltip } from "@/ui/components/tooltip";
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
      className="bg-muted/40 flex h-7 items-end gap-0.5 border-b px-1"
    >
      <div
        role="tab"
        aria-selected="true"
        aria-label={loaded ? `${title}, ${buildId}` : title}
        data-testid="preview-tab"
        data-build-id={buildId ?? ""}
        data-loaded={loaded ? "true" : "false"}
        className={cn(
          "flex h-6 max-w-full min-w-0 items-center gap-1 rounded-t-md border border-b-0 px-1.5 sm:max-w-[22rem]",
          loaded ? "bg-background" : "bg-muted/60 text-muted-foreground",
        )}
      >
        <Globe aria-hidden="true" className="text-muted-foreground size-3.5 shrink-0" />
        <span className="truncate text-[12px] font-medium">{title}</span>
        {buildId !== null ? (
          <span
            data-testid="preview-tab-build"
            // The build id is exact and long; on a phone it would push the tab past the pane's
            // right edge, so it is dropped from the painted strip (the aria-label keeps it).
            className="text-muted-foreground hidden shrink-0 font-mono text-[10.5px] sm:inline"
            title={`Build ${buildId}`}
          >
            {buildId}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One arrow or the reload control: a pictogram that moves the user, so `tone="nav"`.
 *
 * The wrapper stays because the title is not the label: an enabled arrow explains where it
 * goes ("Back to the previous page in this build") while a disabled one explains why it cannot
 * ("No earlier page in this build to go back to"). That difference is the honesty rule the
 * whole bar is built on, so it is passed as `hint`.
 */
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
    <IconButton
      testId={testId}
      label={label}
      hint={title}
      tone="nav"
      disabled={disabled ?? false}
      onClick={onClick}
      // A disabled arrow must look disabled, not merely be unclickable: the whole point of
      // the two arrows here is that the user can see there is no history yet.
      className="text-foreground/80 hover:bg-accent hover:text-foreground disabled:text-muted-foreground/50"
    >
      {children}
    </IconButton>
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
  /**
   * What the Reload arrow will do, in the caller's words.
   *
   * A prod preview reloads a published build; a dev preview attaches to the server the user runs.
   * One arrow, two meanings, so the sentence comes from whoever knows which preview this is.
   */
  reloadTitle?: string;
  /**
   * Called with what the user typed, on Enter.
   *
   * Absent means the bar cannot be typed into: a caller with no way to act on an address gets a
   * read-only field rather than a field whose Enter key does nothing.
   */
  onNavigate?: (address: string) => void;
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
  reloadTitle,
  onNavigate,
  children,
}: PreviewBrowserBarProps): ReactNode {
  const empty = address.length === 0;
  const editable = onNavigate !== undefined;

  // The draft is what the user is typing; it follows the frame's address whenever the user is
  // not in the field, so an SPA's pushState still moves the bar under their eyes.
  const [draft, setDraft] = useState(address);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(address);
  }, [address, editing]);

  return (
    <div className="border-b">
      <div
        data-testid="preview-browser-bar"
        className="bg-muted/40 flex items-center gap-1 px-1 py-0.5"
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
          title={
            reloadDisabled
              ? "Publish a build before reloading it"
              : (reloadTitle ?? "Load this URL again from the published build")
          }
          disabled={reloadDisabled}
          onClick={onReload}
        >
          <RotateCw aria-hidden="true" className="size-3.5" />
        </NavButton>

        {/* A pill, like every browser's omnibox, so it reads as an address rather than a field the
            user is expected to fill in. It is a real input now: `localhost:1234/app` is an address
            the preview can be pointed at, and `/about` stays on the page on screen. What is typed is
            a draft until Enter — see `preview-address.ts` for what each answer means. */}
        <div
          data-testid="preview-address-pill"
          className={cn(
            "bg-background mx-0.5 flex h-6 min-w-0 flex-1 items-center gap-1 rounded-full border px-1.5",
            empty && "text-muted-foreground",
          )}
        >
          <Lock aria-hidden="true" className="text-muted-foreground/70 size-3 shrink-0" />
          {origin !== null ? (
            <span
              data-testid="preview-address-origin"
              // An origin plus a path does not fit in a 390 px omnibox; the path is the part that
              // changes, so the origin is the part that goes.
              className="text-muted-foreground hidden shrink-0 font-mono text-[11px] sm:inline"
            >
              {origin}
            </span>
          ) : null}
          <input
            data-testid="preview-address"
            aria-label="Preview address"
            aria-readonly={editable ? "false" : "true"}
            readOnly={!editable}
            value={draft}
            placeholder="Nothing loaded yet"
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              onNavigate?.(draft);
            }}
            className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] outline-none"
          />
        </div>

        {children}
      </div>
    </div>
  );
}

export interface PreviewDeviceToolbarProps {
  /** The preset that is sizing the frame. */
  viewport: ViewportPreset;
  /** Absent when the caller has no viewport state: the buttons then render unpressable. */
  onChange?: (name: ViewportName) => void;
  /**
   * The factor the frame is drawn at when the preset is wider than the pane. `1` (the default)
   * means "not scaled", and the tooltip says nothing extra.
   */
  zoom?: number;
  /**
   * Extra controls for this row, when the pane has them: install & build, cancel, fullscreen.
   * They sit beside the three width buttons on request, so the row that decides what the frame
   * shows is also the row that makes a build to show.
   */
  actions?: ReactNode;
}

/**
 * What the bubble over one preset button says: the preset's name, the exact size it applies, and
 * the limit of that claim.
 *
 * Three lines and a caption, because each answers a different question. The name is what the
 * user is choosing (*tablet*), the number is what they get (`834 × 1112`), and the caption is
 * what they must not conclude from the number (a frame, not a device). The preset that fills the
 * pane says so in words instead, since it has no size to be exact about.
 */
function ViewportHint({ preset, zoom }: { preset: ViewportPreset; zoom: number }): ReactNode {
  const size = viewportSize(preset);

  return (
    <>
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground text-[9.5px] font-semibold tracking-[0.14em] uppercase">
          {preset.label}
        </span>
        {/* The unit rides on the same line as the label so the number below is bare: a mono
            `390 × 844` with `CSS px` glued to it is read as one token. */}
        <span className="text-muted-foreground/70 text-[9px] font-medium tracking-[0.1em] uppercase">
          {size === null ? "pane" : "CSS px"}
        </span>
      </span>
      <span
        data-testid={`preview-viewport-size-${preset.name}`}
        className="text-foreground mt-1 block font-mono text-[13px] leading-none font-medium tabular-nums"
      >
        {size ?? "Fills the pane"}
      </span>
      <span className="text-muted-foreground mt-1.5 block text-[10.5px] leading-snug">
        {viewportLimit(preset)}
      </span>
      {zoom < 1 ? (
        // The frame is narrower than the number above says it is, so the bubble admits it:
        // `834 × 1112` printed over a frame drawn at 45 % would be the lie this row exists to
        // avoid. Only the *pressed* preset can be scaled, which is why the caller passes `zoom`
        // for that one and `1` for the others.
        <span className="text-muted-foreground mt-1 block text-[10.5px] leading-snug">
          {`Drawn at ${String(Math.round(zoom * 100))} % to fit this pane.`}
        </span>
      ) : null}
    </>
  );
}

/**
 * Desktop / tablet / mobile, as the device toolbar of a devtools pane.
 *
 * `aria-pressed` and not a `<select>`: the three choices are visible at once and the current one
 * has to be readable by a screen reader. The size is the *claim* — exact CSS pixels for a preset,
 * "Fills the pane" for the one that follows the window — and the caption under it is the limit:
 * no touch events, no device pixel ratio. Both are painted in a tooltip rather than in a readout
 * of their own, so a dense row stays three buttons wide; the bubble is `aria-describedby` on the
 * button, so the same sentence reaches a screen reader on focus without being on screen.
 */
export function PreviewDeviceToolbar({
  viewport,
  onChange,
  zoom = 1,
  actions,
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
      className="bg-muted/20 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b px-1.5 py-0.5"
    >
      <div
        data-testid="preview-viewports"
        role="group"
        aria-label="Preview viewport"
        // No `overflow-hidden` here, and it is not an oversight: a bubble nested inside this
        // row would be clipped by it, so the rounded end is put on the first and last *button*
        // instead. The clipping that was doing that job is now those two radii.
        className="border-border bg-background flex items-center rounded-md border"
      >
        {VIEWPORTS.map((preset) => {
          const selected = preset.name === viewport.name;
          // Deterministic, and derived from the preset rather than from a `useId`: one toolbar
          // per pane, and a test can name the bubble it means without reading the DOM twice.
          const hintId = `preview-viewport-hint-${preset.name}`;
          return (
            // The anchor is what the pointer hovers and what the bubble is measured against;
            // the button inside it is unchanged. `TOOLTIP_ANCHOR` carries `group/tip`, which is
            // the half of that contract the bubble names.
            <span
              key={preset.name}
              // `[&:first-child>button]`: the segmented control's outer corners, which used to
              // be an `overflow-hidden` on the row. Written against the child button because
              // this span is the row's child, and the radius has to land on the painted box.
              className={cn(
                TOOLTIP_ANCHOR,
                "[&:first-child>button]:rounded-l-md [&:last-child>button]:rounded-r-md",
              )}
            >
              <IconButton
                testId={`preview-viewport-${preset.name}`}
                // The pictogram is the monitor, the tablet or the phone; the preset's name is
                // the accessible name, and the size it applies is the description below rather
                // than a native `title` — `hint={null}` is what keeps the browser from drawing
                // a second, greyer tooltip a second later on top of this one.
                label={preset.label}
                hint={null}
                aria-describedby={hintId}
                tone="nav"
                aria-pressed={selected}
                data-selected={selected ? "true" : "false"}
                onClick={onChange === undefined ? undefined : () => onChange(preset.name)}
                className={cn(
                  "rounded-none",
                  selected ? "bg-primary/10 text-foreground" : "text-muted-foreground",
                )}
              >
                {ICONS[preset.name]}
              </IconButton>
              <Tooltip
                id={hintId}
                testId={hintId}
                side="bottom"
                align="start"
                // One width for all three bubbles, so moving along the row does not make the
                // tooltip jump; bounded by the viewport so a 360 px phone cannot clip it.
                className="w-[min(13.5rem,calc(100vw-1.5rem))]"
              >
                <ViewportHint preset={preset} zoom={selected ? zoom : 1} />
              </Tooltip>
            </span>
          );
        })}
      </div>

      {/* The row used to carry two more spans — the current width ("full width" for the preset
          that follows the window, "390 × 844" for the others) and the note from `describeViewport`
          — and the second one became the tooltips above. Nothing is lost: the pressed preset is
          still the one with `aria-pressed="true"`, and its size is a hover away. */}
      {actions}
    </div>
  );
}
