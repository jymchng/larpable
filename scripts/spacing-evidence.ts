/**
 * Spacing audit: how much margin Larpable's own chrome occupies, measured at 390 and 1440 px.
 *
 * User request (goal `e8d8793f`): "all components in this webapp has too wide a margin, tighten
 * them all". A sentence like that is a claim about what is on screen, so it is answered with
 * numbers rather than with a search for `p-4` in the source: the classes in `src/ui/` were already
 * small (`px-1.5`, `py-0.5`, `gap-1.5`), which means the width a person *sees* comes from the
 * composition — a dozen small paddings stacked between the window edge and the first word — and
 * from the few places that carry a full step (`px-3`, `py-2`, `gap-3`, `p-2`).
 *
 * This script measures those boxes in the browser and writes the numbers down twice: once for the
 * layout as it was (`--label=before`) and once after the tightening (`--label=after`). Comparing
 * the two files is the evidence; the prose in `docs/spacing-report.md` quotes them.
 *
 * For every surface it records the *computed* padding and margin (all four sides), the row and
 * column gap, and the rendered rectangle — because a class name proves nothing about which
 * breakpoint won or what a `sm:` variant did at 390 px.
 *
 *   bun run dev &
 *   bun scripts/spacing-evidence.ts --label=before
 *   ... tighten ...
 *   bun scripts/spacing-evidence.ts --label=after
 *
 * Output: `docs/evidence/spacing-<label>.{json,txt}` and `docs/evidence/spacing-<label>-<w>.png`.
 * Exit code 0 when the page has no horizontal overflow at either width and every named surface
 * was found; the audit reports numbers, it does not fail on "too much" or "too little" padding —
 * that judgement is the report's, made by comparing the two runs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

import { ensureBooted } from "./lib/boot.ts";

const root = resolve(import.meta.dirname, "..");
const evidenceDir = join(root, "docs", "evidence");
const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);
const DEV_HOST = "127.0.0.1";
const SERVER_TIMEOUT_MS = 60_000;
const BOOT_TIMEOUT_MS = 240_000;

/** `--label=before` names the run; the files are written per label so two runs can be compared. */
const label =
  process.argv
    .slice(2)
    .find((argument) => argument.startsWith("--label="))
    ?.slice("--label=".length)
    .trim() || "current";

/**
 * The boxes worth measuring, in the order a person meets them on screen.
 *
 * One entry per *layout* box rather than one per component: the complaint is about margin, and
 * margin between the window and the content is the sum of the shell's padding, the header's
 * padding, each pane's padding and each list's inset. Measuring the composed stack is what shows
 * where the pixels went; measuring a component's own class would answer a question nobody asked.
 *
 * The two popovers are listed too: they are the densest surfaces in the app (the debug popover
 * holds seven facts in 22rem), so they are where a padding step costs the most.
 */
const SURFACES: { name: string; selector: string; note: string; optional?: boolean }[] = [
  { name: "shell", selector: "[data-testid=app-shell]", note: "window edge → every pane" },
  { name: "header", selector: "header", note: "wordmark, debug `d`, settings cog" },
  { name: "stage-switcher", selector: "[data-testid=stage-switcher]", note: "phone pane tabs" },
  { name: "agent-pane", selector: "[data-testid=agent-pane]", note: "chat + terminal column" },
  { name: "chat-panel", selector: "[data-testid=chat-panel]", note: "whole chat surface" },
  { name: "chat-transcript", selector: "[data-testid=chat-transcript]", note: "message list" },
  { name: "chat-form", selector: "[data-testid=chat-form]", note: "prompt box" },
  { name: "terminal-panel", selector: "[data-testid=terminal-panel]", note: "shell surface" },
  { name: "terminal-tabs", selector: "[data-testid=terminal-tabs]", note: "shell tabs" },
  { name: "preview-pane", selector: "[data-testid=preview-pane]", note: "browser column" },
  {
    // `PreviewToolbar` returns `null` unless a build is being served (`servedByFact`), and this
    // audit never builds anything: it measures layout, not the build pipeline. Listed as optional
    // so its absence is reported rather than failing a run that is measuring what exists.
    name: "preview-toolbar",
    selector: "[data-testid=preview-toolbar]",
    note: "build strip (only while a build is served)",
    optional: true,
  },
  { name: "preview-tab-strip", selector: "[data-testid=preview-tab-strip]", note: "browser tab" },
  { name: "preview-browser-bar", selector: "[data-testid=preview-browser-bar]", note: "address bar" },
  {
    // The caption above the browser column: the one box in the shell that used a wider inset
    // than the pane it labels, so the audit has to see it to prove it stopped doing that.
    name: "preview-heading",
    selector: "#preview-heading",
    note: "column caption (desktop only)",
  },
  {
    name: "debug-popover",
    selector: "#diagnostics-popover",
    note: "the densest surface (measured open)",
  },
  {
    name: "settings-panel",
    selector: "[data-testid=settings-panel]",
    note: "provider settings (measured open)",
  },
];

interface Box {
  padding: { top: number; right: number; bottom: number; left: number };
  margin: { top: number; right: number; bottom: number; left: number };
  /** `null` when the box is not a flex/grid container, where a gap has no meaning. */
  gap: { row: number; column: number } | null;
  /** `null` when the box is not displayed at this width (the desktop-only split handle, say). */
  rect: { width: number; height: number; left: number; top: number } | null;
}

interface Reading extends Box {
  name: string;
  selector: string;
  note: string;
  found: boolean;
  /** `true` for a surface that legitimately may not be rendered in this run (build-only chrome). */
  optional: boolean;
  /** For the two popovers: whether the surface was actually open when its rectangle was read. */
  openState?: "open" | "did-not-open";
}

interface ViewportReport {
  width: number;
  height: number;
  surfaces: Reading[];
  /** `scrollWidth - clientWidth` on the scrolling element: the overflow budget, in px. */
  pageOverflowPx: number;
  /** The worst element right edge past the viewport, with the element named. */
  worstRightOverflow: { px: number; element: string } | null;
}

interface RunReport {
  label: string;
  url: string;
  generatedAt: string;
  /** How the run got its machine; `ensureBooted` reports the path so the numbers say so too. */
  boot: string;
  viewports: ViewportReport[];
}

function findChromium(): string {
  const explicit = process.env.LARPABLE_CHROMIUM?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`LARPABLE_CHROMIUM does not exist: ${explicit}`);
    return explicit;
  }
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) {
    throw new Error(`no Playwright browser cache at ${cache}; set LARPABLE_CHROMIUM`);
  }
  const revisions = readdirSync(cache)
    .filter((name) => name.startsWith("chromium-"))
    .map((name) => ({ name, revision: Number(name.slice("chromium-".length)) }))
    .filter((entry) => Number.isFinite(entry.revision))
    .sort((a, b) => b.revision - a.revision);
  for (const entry of revisions) {
    for (const layout of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const candidate = join(cache, entry.name, layout);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`no Chromium binary under ${cache}; set LARPABLE_CHROMIUM to one`);
}

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}

/** Loopback only, whatever the environment says: a run must never depend on a public server. */
async function ensureDevServer(): Promise<ChildProcess | null> {
  if (await reachable(baseUrl)) return null;
  console.log(`[spacing] ${baseUrl} is down; starting \`bun run dev\` on ${DEV_HOST}`);
  const child = spawn("bun", ["run", "dev"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LARPABLE_DEV_HOST: DEV_HOST },
  });
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reachable(baseUrl)) return child;
    await sleep(500);
  }
  child.kill("SIGTERM");
  throw new Error(`dev server did not answer on ${baseUrl} within ${SERVER_TIMEOUT_MS / 1000}s`);
}

/**
 * Read one box in the page.
 *
 * `getComputedStyle` rather than the class list: at 390 px a `sm:` variant has not applied, so the
 * class name would report the wrong number for exactly the width the user is complaining about.
 * A box that is `display: none` still has computed padding (the cascade resolved it), so the two
 * popovers are read for padding even before they are opened; their `rect` is measured separately
 * with the surface open, because a hidden element has no rectangle to measure.
 */
async function readSurfaces(page: Page): Promise<Reading[]> {
  return await page.evaluate((surfaces: { name: string; selector: string; note: string; optional?: boolean }[]) => {
    const px = (value: string): number => Number.parseFloat(value) || 0;
    return surfaces.map(({ name, selector, note, optional }) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (element === null) {
        return {
          name,
          selector,
          note,
          found: false,
          optional: optional === true,
          padding: { top: 0, right: 0, bottom: 0, left: 0 },
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
          gap: null,
          rect: null,
        };
      }
      const style = getComputedStyle(element);
      const displayed = style.display !== "none" && element.getClientRects().length > 0;
      const rect = element.getBoundingClientRect();
      const flexish =
        style.display.includes("flex") ||
        style.display.includes("grid") ||
        style.display.includes("inline-flex");
      const rowGap = px(style.rowGap);
      const columnGap = px(style.columnGap);
      return {
        name,
        selector,
        note,
        found: true,
        optional: optional === true,
        padding: {
          top: px(style.paddingTop),
          right: px(style.paddingRight),
          bottom: px(style.paddingBottom),
          left: px(style.paddingLeft),
        },
        margin: {
          top: px(style.marginTop),
          right: px(style.marginRight),
          bottom: px(style.marginBottom),
          left: px(style.marginLeft),
        },
        gap: flexish ? { row: rowGap, column: columnGap } : null,
        rect: displayed
          ? { width: rect.width, height: rect.height, left: rect.left, top: rect.top }
          : null,
      };
    });
  }, SURFACES);
}

/** Page-level overflow, plus the single worst offender so a regression is named, not counted. */
async function readOverflow(page: Page): Promise<Pick<ViewportReport, "pageOverflowPx" | "worstRightOverflow">> {
  return await page.evaluate(() => {
    const scrolling = document.scrollingElement ?? document.documentElement;
    let worst = 0;
    let worstElement = "";
    for (const element of Array.from(document.querySelectorAll("*"))) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const over = rect.right - window.innerWidth;
      if (over > worst) {
        worst = over;
        const id = element.getAttribute("data-testid");
        worstElement = `${element.tagName.toLowerCase()}${id === null ? "" : `[data-testid=${id}]`}`;
      }
    }
    return {
      pageOverflowPx: scrolling.scrollWidth - scrolling.clientWidth,
      worstRightOverflow:
        worst > 0.5 ? { px: Math.round(worst * 10) / 10, element: worstElement } : null,
    };
  });
}

/** A fixed-width table cell: `4/6/6/6` reads as top/right/bottom/left in px. */
function sides(box: { top: number; right: number; bottom: number; left: number }): string {
  const round = (value: number): string => String(Math.round(value * 10) / 10);
  return `${round(box.top)}/${round(box.right)}/${round(box.bottom)}/${round(box.left)}`;
}

function describe(reading: Reading): string {
  const gap =
    reading.gap === null
      ? "-"
      : reading.gap.row === reading.gap.column
        ? String(Math.round(reading.gap.row * 10) / 10)
        : `${String(Math.round(reading.gap.row * 10) / 10)}x${String(Math.round(reading.gap.column * 10) / 10)}`;
  const rect =
    reading.rect === null
      ? "hidden"
      : `${String(Math.round(reading.rect.width))}x${String(Math.round(reading.rect.height))}`;
  return [
    reading.name.padEnd(19),
    `padding ${sides(reading.padding)}`.padEnd(22),
    `margin ${sides(reading.margin)}`.padEnd(21),
    `gap ${gap}`.padEnd(9),
    rect,
  ].join("  ");
}

async function measureViewport(
  browser: Browser,
  width: number,
  height: number,
): Promise<{ report: ViewportReport; boot: string }> {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  try {
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    // The real layout needs its content: the terminal pane, the chat log and the preview chrome
    // only exist once the machine has answered, so a measurement taken while "Booting…" would be
    // a measurement of the empty state.
    const booted = await ensureBooted(page, { timeoutMs: BOOT_TIMEOUT_MS });
    const boot = `${booted.path} after ${String(Math.round(booted.waitedMs))} ms`;

    const surfaces = await readSurfaces(page);
    const overflow = await readOverflow(page);

    // The two popovers: padding is readable closed, but the rectangle is not, and the rectangle is
    // where a too-large inset actually costs the user screen. Open each in turn, and *wait for it*
    // — the previous version clicked, slept 150 ms and measured, which read `0x0` whenever the
    // open frame had not landed, and then attributed the next popover's rectangle to this one.
    for (const [trigger, surfaceId, name] of [
      ["[data-testid=diagnostics-toggle]", "diagnostics-popover", "debug-popover"],
      ["[data-testid=settings-toggle]", "settings-region", "settings-panel"],
    ] as const) {
      const toggle = page.locator(trigger);
      const reading = surfaces.find((entry) => entry.name === name);
      if (reading === undefined) continue;
      if ((await toggle.count()) === 0) {
        reading.openState = "did-not-open";
        continue;
      }
      const surfaceSelector = `#${surfaceId}`;
      const stateIs = async (state: string): Promise<boolean> =>
        await page.evaluate(
          (args: { selector: string; state: string }) =>
            document.querySelector(args.selector)?.getAttribute("data-state") === args.state,
          { selector: surfaceSelector, state },
        );
      // `ensureBooted` presses Boot *inside* the debug popover when the auto-boot has not started,
      // and it leaves the surface open. A blind click would then close the very popover it is
      // meant to measure (measured: rect present, `data-state` flipped to `closed`). So read the
      // state first and only click when the surface is actually shut.
      let opened = await stateIs("open");
      if (!opened) {
        try {
          await toggle.first().click();
          await page.waitForSelector(`${surfaceSelector}[data-state=open]`, { timeout: 5_000 });
          opened = true;
        } catch {
          opened = false;
        }
      }
      reading.openState = opened ? "open" : "did-not-open";
      if (opened) {
        const openedRect = await page.evaluate((selector: string) => {
          const element = document.querySelector<HTMLElement>(selector);
          if (element === null) return null;
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height, left: rect.left, top: rect.top };
        }, surfaceSelector);
        if (openedRect !== null) {
          reading.rect = {
            width: Math.round(openedRect.width * 10) / 10,
            height: Math.round(openedRect.height * 10) / 10,
            left: Math.round(openedRect.left * 10) / 10,
            top: Math.round(openedRect.top * 10) / 10,
          };
        }
        await page.keyboard.press("Escape");
        // `state: "attached"`, not the default `visible`: a closed popover is hidden by design, so
        // waiting for it to be visible waits for the opposite of what just happened.
        const waitClosed = async (timeout: number): Promise<boolean> =>
          await page
            .waitForSelector(`${surfaceSelector}[data-state=closed]`, {
              state: "attached",
              timeout,
            })
            .then(() => true)
            .catch(() => false);
        if (!(await waitClosed(2_000)) && (await stateIs("open"))) {
          // Measured here: Escape does not always arrive, because the terminal pane takes focus
          // back when the guest's shell connects (`terminal-panel.tsx`'s on-activate focus), so the
          // key is consumed by xterm. That is a real bug and it is queued as its own goal; it is
          // *not* this audit's subject, and a spacing run must not depend on dismissal working.
          // The surface's own close button is deterministic, so use it and say so. The state is
          // re-read first because Escape sometimes lands a moment later, and clicking a hidden
          // close button then waits 5 s for a control that only exists while the surface is open.
          console.log(
            `[spacing] ${name}: Escape did not close the surface; used its close button instead`,
          );
          // `data-testid`, not `#id`: the close control is an `IconButton`, which sets
          // `data-testid="<surface>-close"` and no id at all.
          await page.locator(`[data-testid=${surfaceId}-close]`).click({ timeout: 5_000 });
          await waitClosed(5_000);
        }
      }
    }

    await page.screenshot({
      path: join(evidenceDir, `spacing-${label}-${String(width)}.png`),
      fullPage: false,
    });

    return {
      report: { width, height, surfaces, ...overflow },
      boot,
    };
  } finally {
    await context.close();
  }
}

/** Compare against the `before` file when one exists, so a run prints its own diff. */
function compare(before: RunReport, after: RunReport): string[] {
  const lines: string[] = [];
  for (const afterViewport of after.viewports) {
    const beforeViewport = before.viewports.find((entry) => entry.width === afterViewport.width);
    if (beforeViewport === undefined) continue;
    lines.push("");
    lines.push(`== ${String(afterViewport.width)} px: before → after (px, t/r/b/l and gap)`);
    for (const afterSurface of afterViewport.surfaces) {
      const beforeSurface = beforeViewport.surfaces.find((entry) => entry.name === afterSurface.name);
      if (beforeSurface === undefined) continue;
      const changes: string[] = [];
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const delta = afterSurface.padding[side] - beforeSurface.padding[side];
        if (Math.abs(delta) > 0.01) {
          changes.push(`pad-${side} ${String(beforeSurface.padding[side])}→${String(afterSurface.padding[side])}`);
        }
      }
      if (beforeSurface.gap !== null && afterSurface.gap !== null) {
        for (const axis of ["row", "column"] as const) {
          const delta = afterSurface.gap[axis] - beforeSurface.gap[axis];
          if (Math.abs(delta) > 0.01) {
            changes.push(`gap-${axis} ${String(beforeSurface.gap[axis])}→${String(afterSurface.gap[axis])}`);
          }
        }
      }
      if (changes.length === 0) continue;
      lines.push(`  ${afterSurface.name.padEnd(19)} ${changes.join(", ")}`);
    }
    lines.push(
      `  page overflow: ${String(beforeViewport.pageOverflowPx)} → ${String(afterViewport.pageOverflowPx)} px`,
    );
  }
  return lines;
}

const browser = await chromium.launch({ executablePath: findChromium() });
const devServer = await ensureDevServer();
const run: RunReport = {
  label,
  url: baseUrl,
  generatedAt: new Date().toISOString(),
  boot: "",
  viewports: [],
};
const transcript: string[] = [`# spacing audit (${label}) at ${baseUrl}`, run.generatedAt, ""];

try {
  mkdirSync(evidenceDir, { recursive: true });
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    const { report, boot } = await measureViewport(browser, width, height);
    if (run.boot === "") run.boot = boot;
    run.viewports.push(report);
    const missing = report.surfaces.filter((surface) => !surface.found);
    console.log(
      `[spacing] ${String(width)}x${String(height)}: ${String(report.surfaces.length - missing.length)}/${String(report.surfaces.length)} surfaces, page overflow ${String(report.pageOverflowPx)} px, worst right edge ${report.worstRightOverflow === null ? "none" : `+${String(report.worstRightOverflow.px)} px (${report.worstRightOverflow.element})`}`,
    );
    transcript.push(`## ${String(width)}x${String(height)}`);
    transcript.push(`page overflow: ${String(report.pageOverflowPx)} px`);
    transcript.push(
      `worst right edge: ${report.worstRightOverflow === null ? "none" : `+${String(report.worstRightOverflow.px)} px (${report.worstRightOverflow.element})`}`,
    );
    for (const surface of report.surfaces) {
      console.log(`[spacing]   ${describe(surface)}`);
      transcript.push(`  ${describe(surface)}`);
    }
    for (const surface of missing) console.log(`[spacing]   MISSING ${surface.name} ${surface.selector}`);
    transcript.push("");
  }
  transcript.splice(3, 0, `boot: ${run.boot}`, "");

  writeFileSync(join(evidenceDir, `spacing-${label}.json`), `${JSON.stringify(run, null, 2)}\n`);
  const beforePath = join(evidenceDir, "spacing-before.json");
  if (label !== "before" && existsSync(beforePath)) {
    const before = JSON.parse(readFileSync(beforePath, "utf8")) as RunReport;
    const diff = compare(before, run);
    for (const line of diff) console.log(`[spacing] ${line}`);
    transcript.push("# before → after", ...diff, "");
  }
  writeFileSync(join(evidenceDir, `spacing-${label}.txt`), `${transcript.join("\n")}\n`);
  console.log(`[spacing] wrote docs/evidence/spacing-${label}.{json,txt} and -390/-1440.png`);

  const missingAny = run.viewports.flatMap((viewport) =>
    viewport.surfaces
      .filter((surface) => !surface.found && !surface.optional)
      .map((surface) => surface.name),
  );
  const notOpened = run.viewports.flatMap((viewport) =>
    viewport.surfaces
      .filter((surface) => surface.openState === "did-not-open")
      .map((surface) => surface.name),
  );
  const overflow = run.viewports.filter((viewport) => viewport.pageOverflowPx > 0);
  if (missingAny.length > 0) throw new Error(`surfaces not found: ${[...new Set(missingAny)].join(", ")}`);
  if (notOpened.length > 0) {
    throw new Error(`a popover did not open, so its rectangle is unknown: ${[...new Set(notOpened)].join(", ")}`);
  }
  if (overflow.length > 0) {
    throw new Error(
      `horizontal overflow: ${overflow.map((viewport) => `${String(viewport.width)} px → ${String(viewport.pageOverflowPx)}`).join(", ")}`,
    );
  }
} finally {
  await browser.close();
  if (devServer !== null) devServer.kill("SIGTERM");
}
