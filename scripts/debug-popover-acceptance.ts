/**
 * The debug popover, measured at 390 x 844: the facts the status bar used to paint are inside
 * it, it fits the viewport, and its dismissal and focus behaviour are real.
 *
 * User request, the session after the machine learned to boot itself: "Put all the above in the
 * debug popover, change the debug information into a popover, make it more concise" — where
 * "the above" was six facts: Linux, runtime, project, build, Netlify and preview.
 *
 * `tests/debug-popover.test.tsx` asserts the static markup (closed by default, named, the six
 * facts inside the surface, no second copy in the layout). This run asserts what static markup
 * cannot: that a press on the `d` really opens a surface which fits a 390 px phone with no
 * sideways overflow, that a screen reader would find the six values inside it, that Escape
 * closes it and hands focus back, and that a press outside closes it too.
 *
 *   bun run acceptance:debug
 *
 * Output: `docs/evidence/debug-popover-390.png`, `docs/evidence/debug-popover-desktop.png`,
 * `docs/evidence/debug-popover-acceptance.txt`; the numbers are quoted in `docs/debug-popover.md`.
 * Exit code 0 only when every check passed; a red run still writes its transcript.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const evidenceDir = join(root, "docs", "evidence");
const transcriptPath = join(evidenceDir, "debug-popover-acceptance.txt");

const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);
const DEV_HOST = "127.0.0.1";
const BOOT_TIMEOUT_MS = 240_000;
const SERVER_TIMEOUT_MS = 60_000;
const POPOVER_ID = "diagnostics-popover";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const lines: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  const line = `${ok ? "PASS" : "FAIL"} ${name} — ${detail}`;
  lines.push(line);
  console.log(line);
}

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

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}

/** Loopback only, whatever the environment says: a run must never depend on a public server. */
async function ensureDevServer(): Promise<ChildProcess | null> {
  if (await reachable(baseUrl)) {
    lines.push(`dev server: already running at ${baseUrl}`);
    return null;
  }
  console.log(`[debug] ${baseUrl} is down; starting \`bun run dev\` on ${DEV_HOST}`);
  const child = spawn("bun", ["run", "dev"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LARPABLE_DEV_HOST: DEV_HOST },
  });
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reachable(baseUrl)) {
      lines.push(`dev server: started by this script on ${DEV_HOST}`);
      return child;
    }
    await sleep(500);
  }
  child.kill("SIGTERM");
  throw new Error(`dev server did not answer on ${baseUrl} within ${SERVER_TIMEOUT_MS / 1000}s`);
}

interface OpenState {
  open: boolean;
  hidden: boolean;
  role: string | null;
  labelledBy: string | null;
  heading: string | null;
  facts: string[];
  factsInside: boolean;
  duplicateFactsLists: number;
  controls: { boot: boolean; selfTest: boolean; shutdown: boolean };
  popoverOverflowPx: number;
  pageOverflowPx: number;
  rect: { left: number; right: number; width: number; top: number; bottom: number };
  activeIsSurface: boolean;
}

async function observeOpen(page: Page): Promise<OpenState> {
  return await page.evaluate((id: string) => {
    const surface = document.querySelector<HTMLElement>(`#${id}`);
    const facts = surface?.querySelector<HTMLElement>("[data-testid=status-facts]") ?? null;
    const rows =
      facts === null
        ? []
        : Array.from(facts.querySelectorAll<HTMLElement>('[data-testid^="status-"]'));
    const rect = surface?.getBoundingClientRect() ?? { left: 0, right: 0, width: 0, top: 0, bottom: 0 };
    return {
      open: surface?.dataset["state"] === "open",
      hidden: surface === null ? true : getComputedStyle(surface).display === "none",
      role: surface?.getAttribute("role") ?? null,
      labelledBy: surface?.getAttribute("aria-labelledby") ?? null,
      heading:
        surface === null
          ? null
          : (document.getElementById(surface.getAttribute("aria-labelledby") ?? "")?.textContent ?? null),
      // "status-*" also matches the dots (`status-dot-linux`); keep the rows only.
      facts: rows
        .filter((row) => !(row.dataset["testid"] ?? "").startsWith("status-dot-"))
        .map((row) => `${row.querySelector("dt")?.textContent ?? ""}=${row.querySelector("dd")?.textContent ?? ""}`),
      factsInside: surface !== null && facts !== null && surface.contains(facts),
      duplicateFactsLists: document.querySelectorAll("[data-testid=status-facts]").length,
      controls: {
        boot: surface?.querySelector("[data-testid=boot-button]") !== null,
        selfTest: surface?.querySelector("[data-testid=self-test-button]") !== null,
        shutdown: surface?.querySelector("[data-testid=shutdown-button]") !== null,
      },
      popoverOverflowPx:
        surface === null ? -1 : Math.max(0, surface.scrollWidth - surface.clientWidth),
      pageOverflowPx: Math.max(
        0,
        (document.scrollingElement?.scrollWidth ?? 0) - (document.scrollingElement?.clientWidth ?? 0),
      ),
      rect: {
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
      },
      activeIsSurface: surface !== null && document.activeElement === surface,
    };
  }, POPOVER_ID);
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  const server = await ensureDevServer();
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-testid=diagnostics-toggle]", { timeout: 60_000 });

    // ---------------------------------------------------------------- closed on arrival
    const closed = await observeOpen(page);
    check(
      "the popover is closed on arrival, and hidden rather than unpainted",
      !closed.open && closed.hidden && closed.facts.length === 6,
      `data-state=${closed.open ? "open" : "closed"}, display:none=${String(closed.hidden)}, facts in DOM=${String(closed.facts.length)}`,
    );
    const trigger = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>("[data-testid=diagnostics-toggle]");
      return {
        label: button?.getAttribute("aria-label") ?? null,
        expanded: button?.getAttribute("aria-expanded") ?? null,
        controls: button?.getAttribute("aria-controls") ?? null,
      };
    });
    check(
      "the trigger is named, collapsed, and points at the surface",
      trigger.label === "Debug: this browser" &&
        trigger.expanded === "false" &&
        trigger.controls === POPOVER_ID,
      `aria-label=${JSON.stringify(trigger.label)}, aria-expanded=${JSON.stringify(trigger.expanded)}, aria-controls=${JSON.stringify(trigger.controls)}`,
    );

    // ---------------------------------------------------------------- wait for a booted machine
    // The facts are interesting once Linux is Ready: that is the state the user quoted.
    const bootStartedAt = Date.now();
    let ready = false;
    while (Date.now() - bootStartedAt < BOOT_TIMEOUT_MS) {
      const footer = await page.evaluate(
        () => document.querySelector("[data-testid=environment-summary]")?.textContent ?? "",
      );
      if (/Linux: Ready/.test(footer)) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    check(
      "the machine reached Ready, so the facts have real values",
      ready,
      `${String(Date.now() - bootStartedAt)} ms from navigation`,
    );

    // ---------------------------------------------------------------- open it the way a person does
    await page.locator("[data-testid=diagnostics-toggle]").click();
    await sleep(250);
    const open = await observeOpen(page);
    await page.screenshot({ path: join(evidenceDir, "debug-popover-390.png") });

    check(
      "a press on the `d` opens the popover",
      open.open && !open.hidden,
      `data-state=${open.open ? "open" : "closed"}, display:none=${String(open.hidden)}`,
    );
    check(
      "the surface is a labelled dialog, not an unlabelled box",
      open.role === "dialog" && open.heading === "Debug" && open.labelledBy === `${POPOVER_ID}-heading`,
      `role=${JSON.stringify(open.role)}, aria-labelledby=${JSON.stringify(open.labelledBy)}, heading=${JSON.stringify(open.heading)}`,
    );
    check(
      "focus moves into the surface on open",
      open.activeIsSurface,
      `document.activeElement is the surface: ${String(open.activeIsSurface)}`,
    );

    // The acceptance's own sentence: all six facts, with values, *inside* it.
    const expected = ["Linux=", "Runtime=", "Project=", "Build=", "Netlify=", "Preview="];
    check(
      "all six facts are visible inside the popover",
      open.factsInside && open.facts.length === 6 && expected.every((prefix, index) => open.facts[index]?.startsWith(prefix)),
      open.facts.join(" | ") || "(no facts found)",
    );
    check(
      "the facts live only in the popover: no status band is left in the layout",
      open.duplicateFactsLists === 1 && open.factsInside,
      `status-facts lists on the page: ${String(open.duplicateFactsLists)}`,
    );
    check(
      "the Linux fact says what the user saw",
      open.facts.some((fact) => /^Linux=Ready$/.test(fact)),
      open.facts.find((fact) => fact.startsWith("Linux=")) ?? "(no Linux fact)",
    );
    check(
      "the Boot, self-test and Shut down controls are inside it",
      open.controls.boot && open.controls.selfTest && open.controls.shutdown,
      `boot=${String(open.controls.boot)}, self-test=${String(open.controls.selfTest)}, shutdown=${String(open.controls.shutdown)}`,
    );

    // ---------------------------------------------------------------- it fits 390 px
    const insideViewport = open.rect.left >= 0 && open.rect.right <= 390;
    check(
      "the popover fits the 390 px viewport with no sideways overflow",
      open.popoverOverflowPx === 0 && insideViewport,
      `scrollWidth - clientWidth = ${String(open.popoverOverflowPx)} px, rect ${String(open.rect.left)}..${String(open.rect.right)} (${String(open.rect.width)} px wide)`,
    );
    check(
      "the page behind it does not overflow either",
      open.pageOverflowPx === 0,
      `scrollWidth - clientWidth = ${String(open.pageOverflowPx)} px`,
    );

    // ---------------------------------------------------------------- the two ways out
    await page.keyboard.press("Escape");
    await sleep(200);
    const afterEscape = await observeOpen(page);
    const focusBack = await page.evaluate(
      () =>
        document.activeElement?.getAttribute("data-testid") ??
        document.activeElement?.getAttribute("aria-label") ??
        null,
    );
    check(
      "Escape closes it and focus returns to the `d`",
      !afterEscape.open && afterEscape.hidden && focusBack === "diagnostics-toggle",
      `open=${String(afterEscape.open)}, focused=${JSON.stringify(focusBack)}`,
    );

    await page.locator("[data-testid=diagnostics-toggle]").click();
    await sleep(200);
    await page.mouse.click(200, 700);
    await sleep(200);
    const afterOutside = await observeOpen(page);
    check(
      "a press outside closes it",
      !afterOutside.open && afterOutside.hidden,
      `open=${String(afterOutside.open)} after a press at (200, 700)`,
    );

    // ---------------------------------------------------------------- desktop, for the record
    const desktop = await context.newPage();
    await desktop.setViewportSize({ width: 1440, height: 900 });
    await desktop.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await desktop.waitForSelector("[data-testid=diagnostics-toggle]", { timeout: 60_000 });
    await desktop.locator("[data-testid=diagnostics-toggle]").click();
    await sleep(250);
    const wide = await observeOpen(desktop);
    await desktop.screenshot({ path: join(evidenceDir, "debug-popover-desktop.png") });
    check(
      "at 1440 px the same surface opens with the same six facts and no overflow",
      wide.open && wide.facts.length === 6 && wide.pageOverflowPx === 0,
      `facts=${String(wide.facts.length)}, page overflow=${String(wide.pageOverflowPx)} px, rect ${String(wide.rect.left)}..${String(wide.rect.right)}`,
    );

    lines.push(
      `popover: ${String(open.rect.width)} px wide, ${String(open.rect.left)}..${String(open.rect.right)} at 390 px; ` +
        `page overflow ${String(open.pageOverflowPx)} px`,
    );
    lines.push(`facts: ${open.facts.join(" | ")}`);
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGTERM");
    const failed = checks.filter((entry) => !entry.ok).length;
    const header = `[debug] ${String(checks.length - failed)}/${String(checks.length)} checks passed against ${baseUrl}`;
    writeFileSync(transcriptPath, `${[...lines, "", header].join("\n")}\n`, "utf8");
    console.log(`\n${header}`);
    if (failed > 0) process.exitCode = 1;
  }
}

await main();
