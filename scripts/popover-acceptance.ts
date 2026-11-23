/**
 * The provider popover, measured in a real browser at phone width.
 *
 * The unit suite can prove the *rules* (`tests/popover.test.ts`) and the markup
 * (`tests/app.test.tsx`), but not that the thing a person actually does works: a click opens
 * it, focus lands inside, Escape closes it and gives focus back, a press outside closes it, and
 * the surface fits a 390 px screen. Those are browser computations — `document.activeElement`,
 * `getComputedStyle`, `getBoundingClientRect` — so they are measured here rather than guessed
 * in a test file.
 *
 * Nothing in this run needs the Linux machine: the popover is app chrome, so the page is
 * loaded, the cog is pressed, and nothing is booted. That keeps the run to a few seconds.
 *
 *   bun run dev &
 *   bun run acceptance:popover
 *
 * Needs the dev server (loopback — `vite.config.ts` binds 127.0.0.1 by default) or a deployed
 * page in `LARPABLE_ACCEPTANCE_URL`. Writes `docs/evidence/provider-popover-390.png` and exits
 * non-zero if any check fails.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const evidenceDir = join(root, "docs", "evidence");
const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);

/** Same resolution order as the other evidence scripts, so one env var configures them all. */
function findChromium(): string {
  const explicit = process.env.LARPABLE_CHROMIUM?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`LARPABLE_CHROMIUM does not exist: ${explicit}`);
    return explicit;
  }
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) throw new Error(`no Playwright browser cache at ${cache}; set LARPABLE_CHROMIUM`);
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

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} — ${detail}`);
}

/** What the page says about the popover right now, read in the page (no inference here). */
interface Observation {
  expanded: string | null;
  state: string | null;
  display: string;
  active: string;
  rect: { left: number; right: number; top: number; bottom: number; width: number; height: number };
  trigger: { left: number; right: number; top: number; bottom: number };
  viewport: { width: number; height: number };
  overflowPx: number;
  scoped: { provider: boolean; model: boolean; key: boolean; close: boolean };
}

async function observe(page: Page): Promise<Observation> {
  const seen = await page.evaluate(() => {
    const dialog = document.querySelector("#settings-region");
    const trigger = document.querySelector("[data-testid=settings-toggle]");
    if (dialog === null || trigger === null) return null;
    const round = (value: number) => Math.round(value * 10) / 10;
    const d = dialog.getBoundingClientRect();
    const t = trigger.getBoundingClientRect();
    const focused = document.activeElement;
    const scrolling = document.scrollingElement;
    return {
      expanded: trigger.getAttribute("aria-expanded"),
      state: dialog.getAttribute("data-state"),
      display: window.getComputedStyle(dialog).display,
      active:
        focused === null
          ? "null"
          : focused.id.length > 0
            ? `#${focused.id}`
            : (focused.getAttribute("data-testid") ?? focused.tagName.toLowerCase()),
      rect: {
        left: round(d.left),
        right: round(d.right),
        top: round(d.top),
        bottom: round(d.bottom),
        width: round(d.width),
        height: round(d.height),
      },
      trigger: { left: round(t.left), right: round(t.right), top: round(t.top), bottom: round(t.bottom) },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      overflowPx: scrolling === null ? 0 : scrolling.scrollWidth - scrolling.clientWidth,
      scoped: {
        provider: dialog.querySelector("[data-testid=settings-provider-demo]") !== null,
        model: dialog.querySelector("[data-testid=settings-model]") !== null,
        key: dialog.querySelector("[data-testid=settings-key]") !== null,
        close: dialog.querySelector("[data-testid=settings-region-close]") !== null,
      },
    };
  });
  if (seen === null) throw new Error("the page has no #settings-region or no settings-toggle");
  return seen;
}

let browser: Browser | null = null;

try {
  mkdirSync(evidenceDir, { recursive: true });
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.log(`[popover] page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`[popover] console: ${message.text()}`);
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/`, { waitUntil: "load" });
  await page.waitForSelector("[data-testid=settings-toggle]", { timeout: 60_000 });
  await page.waitForTimeout(300);

  // 1. Closed on arrival, and closed means gone from the layout rather than merely unpainted.
  const closed = await observe(page);
  check(
    "closed by default",
    closed.expanded === "false" && closed.state === "closed" && closed.display === "none",
    `aria-expanded=${String(closed.expanded)}, data-state=${String(closed.state)}, display=${closed.display}`,
  );

  // 2. The trigger opens it, and focus moves into the dialog (not to <body>).
  await page.click("[data-testid=settings-toggle]");
  await page.waitForTimeout(150);
  const open = await observe(page);
  check(
    "opens on the trigger, with focus inside",
    open.expanded === "true" && open.state === "open" && open.display !== "none" && open.active === "#settings-region",
    `aria-expanded=${String(open.expanded)}, data-state=${String(open.state)}, display=${open.display}, activeElement=${open.active}`,
  );

  // 3. The fields are the same three, and they are *inside* the surface.
  check(
    "carries the provider, model, key fields and a named close button",
    open.scoped.provider && open.scoped.model && open.scoped.key && open.scoped.close,
    `provider=${String(open.scoped.provider)}, model=${String(open.scoped.model)}, key=${String(open.scoped.key)}, close=${String(open.scoped.close)}`,
  );

  // 4. It fits a 390 px phone, and it hangs off the cog rather than floating loose.
  const insideViewport =
    open.rect.left >= 0 &&
    open.rect.right <= open.viewport.width + 0.5 &&
    open.rect.top >= 0 &&
    open.rect.bottom <= open.viewport.height + 0.5;
  check(
    "fits the 390 px viewport",
    insideViewport && open.overflowPx <= 0,
    `rect ${String(open.rect.left)}..${String(open.rect.right)} x ${String(open.rect.top)}..${String(open.rect.bottom)} in ${String(open.viewport.width)}×${String(open.viewport.height)}, ` +
      `document overflow ${String(open.overflowPx)} px`,
  );
  check(
    "anchored to the cog",
    Math.abs(open.rect.right - open.trigger.right) <= 1.5 && open.rect.top >= open.trigger.bottom - 0.5,
    `dialog right ${String(open.rect.right)} vs trigger right ${String(open.trigger.right)}, ` +
      `dialog top ${String(open.rect.top)} vs trigger bottom ${String(open.trigger.bottom)}`,
  );

  await page.screenshot({ path: join(evidenceDir, "provider-popover-390.png") });

  // 5. Escape closes it and gives focus back to the cog.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  const afterEscape = await observe(page);
  check(
    "closes on Escape and returns focus to the trigger",
    afterEscape.expanded === "false" &&
      afterEscape.state === "closed" &&
      afterEscape.display === "none" &&
      afterEscape.active === "settings-toggle",
    `aria-expanded=${String(afterEscape.expanded)}, data-state=${String(afterEscape.state)}, activeElement=${afterEscape.active}`,
  );

  // 6. Reopened, then a press outside closes it (the wordmark is neither the panel nor the anchor).
  await page.click("[data-testid=settings-toggle]");
  await page.waitForTimeout(150);
  const reopened = await observe(page);
  await page.click("header >> text=Larpable");
  await page.waitForTimeout(150);
  const afterOutside = await observe(page);
  check(
    "closes on a press outside",
    reopened.state === "open" && afterOutside.state === "closed" && afterOutside.display === "none",
    `reopened data-state=${String(reopened.state)} → after press data-state=${String(afterOutside.state)}, display=${afterOutside.display}`,
  );

  // 7. Pressing the cog while open closes it (the anchor is not "outside", so no double-toggle).
  await page.click("[data-testid=settings-toggle]");
  await page.waitForTimeout(150);
  await page.click("[data-testid=settings-toggle]");
  await page.waitForTimeout(150);
  const toggled = await observe(page);
  check(
    "the cog toggles rather than closes-then-reopens",
    toggled.expanded === "false" && toggled.state === "closed",
    `after two presses: aria-expanded=${String(toggled.expanded)}, data-state=${String(toggled.state)}`,
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log(
    `[popover] ${String(checks.length - failed.length)}/${String(checks.length)} checks passed at 390×844 ` +
      `against ${baseUrl}; wrote docs/evidence/provider-popover-390.png`,
  );
  if (failed.length > 0) throw new Error(`${String(failed.length)} check(s) failed; see above`);
} finally {
  await browser?.close();
}
