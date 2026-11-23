/**
 * The debug popover, measured at 390 x 844: the facts the status bar used to paint are inside
 * it, it fits the viewport, and its dismissal and focus behaviour are real.
 *
 * User request, the session after the machine learned to boot itself: "Put all the above in the
 * debug popover, change the debug information into a popover, make it more concise" — where
 * "the above" was the six facts the status bar painted: Linux, runtime, project, build, Netlify
 * and preview. A later goal added the terminal's connection state as a seventh fact, so the
 * expected list lives in one constant (`EXPECTED_FACTS`) instead of a `6` typed three times: the
 * count and the labels cannot drift apart again, and a run that finds a row the list does not
 * name fails instead of passing on a number.
 *
 * `tests/debug-popover.test.tsx` asserts the static markup (closed by default, named, the facts
 * inside the surface, no second copy in the layout). This run asserts what static markup
 * cannot: that a press on the `d` really opens a surface which fits a 390 px phone with no
 * sideways overflow, that a screen reader would find every value inside it, that Escape
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

/**
 * The facts the popover must show, in render order, by label prefix.
 *
 * One list rather than a `6` beside a list of six prefixes: the previous shape hard-coded
 * `facts.length === 6` in three checks while the expected labels lived in a fourth place, so
 * adding the Terminal row turned three passing checks red without anything being wrong on
 * screen. `EXPECTED_FACTS.length` is now the only count.
 */
const EXPECTED_FACTS = [
  "Linux=",
  "Runtime=",
  "Project=",
  "Build=",
  "Netlify=",
  "Preview=",
  "Terminal=",
] as const;

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
  /** The `dd` of the `environment-sentence` row: the sentence the user quoted, as an eye reads it. */
  environmentSentence: string | null;
  /** The `support-verdict` row: its words and its tone (`data-ok`), the old footer badge's replacement. */
  support: { text: string | null; ok: string | null };
  /** `v0.1.0` — the build id that used to sit in the header. */
  version: string | null;
  /** Whether the requirements `StatusDot` (the green dot beside the `d`) is inside the surface. */
  requirementsDotInside: boolean;
  /** Whether *any* `<footer>` element is on the page: the band this goal removed. */
  footerElements: number;
  /** The always-in-DOM `sr-only` polite live region, and whether it is really `aria-live="polite"`. */
  live: { text: string | null; politeness: string | null; visuallyHidden: boolean };
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
      // The three things this goal moved out of always-visible chrome, read the way a person would
      // read them: the sentence row's value, the verdict row's words and tone, and the version in
      // the surface's own footer.
      environmentSentence:
        surface
          ?.querySelector("[data-testid=environment-sentence] dd")
          ?.textContent?.trim() ?? null,
      support: {
        text: surface?.querySelector("[data-testid=support-verdict] dd")?.textContent?.trim() ?? null,
        ok: surface?.querySelector("[data-testid=support-verdict]")?.getAttribute("data-ok") ?? null,
      },
      version: surface?.querySelector("[data-testid=app-version]")?.textContent?.trim() ?? null,
      // The dot beside the `d` used to be in the header; it must now be *inside* the surface, so
      // "found anywhere on the page" is not enough — the containment is the assertion.
      requirementsDotInside:
        surface !== null &&
        surface.querySelector("[data-testid=requirements-status]") !== null,
      footerElements: document.querySelectorAll("footer").length,
      // The one copy that stays always-visible to assistive tech: same sentence, polite, hidden
      // from the layout rather than removed from the DOM.
      live: {
        text: document.querySelector("[data-testid=environment-summary]")?.textContent?.trim() ?? null,
        politeness: document
          .querySelector("[data-testid=environment-summary]")
          ?.getAttribute("aria-live") ?? null,
        visuallyHidden:
          document.querySelector("[data-testid=environment-summary]")?.className.includes("sr-only") ??
          false,
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
      !closed.open && closed.hidden && closed.facts.length === EXPECTED_FACTS.length,
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

    // The acceptance's own sentence: every fact, with values, *inside* it — in render order, so a
    // missing row, an extra row or a reordered list all fail here.
    check(
      "every status fact is visible inside the popover",
      open.factsInside &&
        open.facts.length === EXPECTED_FACTS.length &&
        EXPECTED_FACTS.every((prefix, index) => open.facts[index]?.startsWith(prefix)),
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

    // ------------------------------------------------- the chrome this goal folded in
    // The user asked for three specific things to move here: the environment sentence (with the
    // "Kernel can boot" verdict beside it), the version, and the green dot. Each is checked where
    // it now lives *and* for the absence of the old always-visible copy, because "it is in the
    // popover" is only half the request — "no longer on screen" is the other half.
    const sentenceShape =
      /^Linux: .+ \| Distro: .+ \| Runtime: .+ \| CPUs: \d+ \| Memory: \d+ MiB$/;
    check(
      "the environment sentence the user quoted is a row inside it",
      open.environmentSentence !== null && sentenceShape.test(open.environmentSentence),
      JSON.stringify(open.environmentSentence),
    );
    check(
      "the support verdict is the row below it, with its tone as data",
      open.support.text !== null &&
        open.support.text.length > 0 &&
        (open.support.ok === "true" || open.support.ok === "false"),
      `support=${JSON.stringify(open.support.text)}, data-ok=${JSON.stringify(open.support.ok)}`,
    );
    check(
      "the version and the requirements dot are in the same surface",
      /^v\d+\.\d+\.\d+$/.test(open.version ?? "") && open.requirementsDotInside,
      `version=${JSON.stringify(open.version)}, requirements dot inside=${String(open.requirementsDotInside)}`,
    );
    check(
      "no visible footer band is left anywhere in the layout",
      open.footerElements === 0,
      `a <footer> element is on the page: ${String(open.footerElements > 0)}`,
    );
    check(
      "the sr-only live region still carries the same sentence for a screen reader",
      open.live.text !== null &&
        open.live.text === open.environmentSentence &&
        open.live.politeness === "polite" &&
        open.live.visuallyHidden,
      `environment-summary=${JSON.stringify(open.live.text)}, aria-live=${JSON.stringify(open.live.politeness)}, sr-only=${String(open.live.visuallyHidden)}`,
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
      "at 1440 px the same surface opens with the same facts and no overflow",
      wide.open && wide.facts.length === EXPECTED_FACTS.length && wide.pageOverflowPx === 0,
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
