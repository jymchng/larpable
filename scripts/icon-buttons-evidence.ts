/**
 * Evidence for the icon-only pass: two screenshots and a live accessible-name audit.
 *
 * The unit sweep in `tests/icon-buttons.test.tsx` renders the components in isolation, so it can
 * prove a button *has* a name but not that the real page keeps one after hydration. This run
 * opens the app in Chromium and asks the browser itself:
 *
 * - how many buttons the page has, how many of them are icon-only (no text of their own), and
 *   how many of those have no accessible name, no tooltip, or a target under 32 px;
 * - what the same page looks like at a laptop width and at a phone width.
 *
 * It needs the dev server (`bun run dev`) or a URL in `LARPABLE_ACCEPTANCE_URL`, and writes
 * `docs/evidence/icon-buttons-desktop.png` and `docs/evidence/icon-buttons-mobile.png`.
 *
 *   bun run dev &
 *   bun scripts/icon-buttons-evidence.ts
 *
 * Exit code 0 only when the audit finds no unnamed, untitled or undersized icon-only button.
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

interface Audit {
  buttons: number;
  iconOnly: number;
  unnamed: string[];
  untitled: string[];
  small: string[];
}

/**
 * The audit runs *in the page*, because the accessible name is a browser computation:
 * `aria-label`, else the text content, else nothing. Doing it here rather than in the test keeps
 * one rule in one place — and catches a class applied by a parent, which a markup test cannot.
 */
async function audit(page: Page): Promise<Audit> {
  return page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll("button"));
    const named = (element: Element): string => {
      const label = element.getAttribute("aria-label")?.trim() ?? "";
      if (label.length > 0) return label;
      return (element.textContent ?? "").replace(/\s+/g, " ").trim();
    };
    const result: {
      buttons: number;
      iconOnly: number;
      unnamed: string[];
      untitled: string[];
      small: string[];
    } = { buttons: buttons.length, iconOnly: 0, unnamed: [], untitled: [], small: [] };
    for (const button of buttons) {
      const style = window.getComputedStyle(button);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if ((button.textContent ?? "").trim().length > 0) continue;
      result.iconOnly += 1;
      const name = named(button);
      const title = button.getAttribute("title")?.trim() ?? "";
      const rect = button.getBoundingClientRect();
      const inline = button.getAttribute("data-inline") === "true";
      const floor = inline ? 24 : 32;
      if (name.length === 0) result.unnamed.push(button.outerHTML.slice(0, 120));
      if (title.length === 0) result.untitled.push(name.length > 0 ? name : button.outerHTML.slice(0, 120));
      if (rect.width + 0.5 < floor || rect.height + 0.5 < floor) {
        result.small.push(`${name || "?"} ${Math.round(rect.width)}×${Math.round(rect.height)}`);
      }
    }
    return result;
  });
}

async function open(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.goto(`${baseUrl}/`, { waitUntil: "load" });
  await page.waitForSelector("[data-testid=chat-send]", { timeout: 60_000 });
  // The environment card's three controls live behind the diagnostics disclosure, which is
  // closed by default; open it so the screenshot shows the row this pass changed.
  const toggle = page.locator("[data-testid=diagnostics-toggle]");
  if ((await toggle.count()) > 0 && (await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
    await page.waitForTimeout(300);
  }
  // Settle: fonts and the first paint of the panels.
  await page.waitForTimeout(600);
}

let browser: Browser | null = null;

try {
  mkdirSync(evidenceDir, { recursive: true });
  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage();

  await open(page, 1440, 900);
  const desktop = await audit(page);
  await page.screenshot({ path: join(evidenceDir, "icon-buttons-desktop.png"), fullPage: true });

  await open(page, 390, 844);
  const mobile = await audit(page);
  await page.screenshot({ path: join(evidenceDir, "icon-buttons-mobile.png"), fullPage: true });

  for (const [name, result] of [
    ["desktop", desktop],
    ["mobile", mobile],
  ] as const) {
    console.log(
      `[icons] ${name}: ${String(result.buttons)} buttons, ${String(result.iconOnly)} icon-only, ` +
        `${String(result.unnamed.length)} unnamed, ${String(result.untitled.length)} untitled, ` +
        `${String(result.small.length)} under the target floor`,
    );
    for (const problem of result.unnamed) console.log(`[icons] ${name} unnamed: ${problem}`);
    for (const problem of result.untitled) console.log(`[icons] ${name} untitled: ${problem}`);
    for (const problem of result.small) console.log(`[icons] ${name} small: ${problem}`);
  }

  console.log(`[icons] wrote ${join("docs", "evidence", "icon-buttons-desktop.png")} and -mobile.png`);
  const bad =
    desktop.unnamed.length +
    mobile.unnamed.length +
    desktop.untitled.length +
    mobile.untitled.length +
    desktop.small.length +
    mobile.small.length;
  if (desktop.iconOnly === 0 || mobile.iconOnly === 0) {
    throw new Error("the audit saw no icon-only buttons, so it proves nothing");
  }
  if (bad > 0) throw new Error(`${String(bad)} icon-only button problem(s) above`);
} finally {
  await browser?.close();
}
