/**
 * Diagnostic probe v3: the acceptance run's own sequence, with the type/echo loop opened up.
 *
 * v2 typed the same base64 command after creating a project and the echo came back whole, so
 * "creating a project breaks the pty" is not the whole story. The differences left are the ones
 * the real run has and a hand-written probe does not: the default 1280x720 viewport (a narrower
 * terminal, so the command wraps), the self-test that runs first, and the debug popover left open
 * by it. This probe replays all three and prints, per attempt: what has focus, how long the mirror
 * is, where the echo diverges from the typed line, and what the xterm rows contain.
 *
 *   bun scripts/probe-guest-echo2.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

import { SELF_TEST_BUTTON, ensureBooted, openDiagnostics } from "./lib/boot.ts";
import { persistedFiles, persistToken } from "./lib/persist-check.ts";
import { writeFileCommand } from "./lib/pty-channel.ts";
import { typeLine } from "./lib/term-channel.ts";

const root = resolve(import.meta.dirname, "..");
const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(/\/+$/, "");

function findChromium(): string {
  const cache = join(homedir(), ".cache", "ms-playwright");
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
  throw new Error("no Chromium binary found");
}

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}

async function ensureDevServer(): Promise<ChildProcess | null> {
  if (await reachable(baseUrl)) return null;
  const child = spawn("bun", ["run", "dev"], { cwd: root, stdio: "inherit" });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await reachable(baseUrl)) return child;
    await sleep(500);
  }
  child.kill("SIGTERM");
  throw new Error("dev server did not start");
}

const squeeze = (value: string): string => value.replace(/\s+/g, "");

function divergence(typed: string, mirror: string): number {
  const want = squeeze(typed);
  const have = squeeze(mirror);
  if (have.includes(want)) return -1;
  for (let index = want.length; index > 0; index -= 1) {
    if (have.includes(want.slice(0, index))) return index;
  }
  return 0;
}

async function describe(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    const mirror = document.querySelector("[data-testid=terminal-output]")?.textContent ?? "";
    const rows = document.querySelector(".xterm-rows")?.textContent ?? "";
    const screen = document.querySelector("[data-testid=terminal-screen]") as HTMLElement | null;
    const rect = screen?.getBoundingClientRect();
    const cols = document.querySelector(".xterm-screen") as HTMLElement | null;
    const popover = document.querySelector("#diagnostics-popover");
    return JSON.stringify({
      active: active ? `${active.tagName}.${active.className.slice(0, 40)}` : "none",
      activeLabel: active?.getAttribute("aria-label") ?? null,
      mirror: mirror.length,
      rows: rows.length,
      screen: rect ? [Math.round(rect.width), Math.round(rect.height)] : null,
      colsPx: cols ? Math.round(cols.getBoundingClientRect().width) : null,
      popover: popover?.getAttribute("data-state") ?? "(none)",
    });
  });
}

async function main(): Promise<void> {
  const server = await ensureDevServer();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    // The acceptance run's `newPage()` with no viewport: 1280x720.
    const page = await browser.newPage();
    page.on("pageerror", (error) => { console.log(`[pageerror] ${error.message.slice(0, 200)}`); });

    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    const boot = await ensureBooted(page, { timeoutMs: 180_000 });
    console.log(`[probe] boot: ${boot.path} after ${String(boot.waitedMs)} ms`);
    await page.locator("[data-testid=terminal-panel][data-connection=connected]").waitFor({ timeout: 120_000 });

    // ---- the self-test, exactly as `runsSelfTest` drives it (this leaves the popover open)
    await openDiagnostics(page);
    await page.locator(SELF_TEST_BUTTON).click();
    await page.locator("[data-testid=self-test-report]").first().waitFor({ timeout: 120_000 });
    console.log(`[probe] self-test: ${(await page.locator("[data-testid=self-test-summary]").first().textContent())?.trim()}`);
    console.log(`[probe] after self-test: ${await describe(page)}`);

    // ---- create a project through the panel, as `measuresPersistence` does
    const token = persistToken();
    const [file] = persistedFiles(token) as [ReturnType<typeof persistedFiles>[number]];
    const write = writeFileCommand(file.path, file.content);
    const name = `stall-${token.slice("larpable-persist-".length)}`;
    await page.locator("[data-testid=projects-toggle]").click();
    await page.locator("[data-testid=project-name]").fill(name);
    await page.locator("[data-testid=project-create-submit]").click();
    await page.locator("[data-testid=project-row]").filter({ hasText: name }).first().waitFor({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    console.log(`[probe] project created: ${name}`);
    console.log(`[probe] after create: ${await describe(page)}`);

    // ---- three single-attempt typings, with the state printed around each
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await typeLine(page, write, 1);
      const mirror = (await page.locator("[data-testid=terminal-output]").first().textContent()) ?? "";
      console.log(
        `[probe] attempt ${String(attempt)}: ok=${String(result.ok)} divergence=${String(divergence(write, mirror.slice(-6_000)))}/${String(squeeze(write).length)} ${await describe(page)}`,
      );
      if (result.ok) break;
      console.log(`[probe] attempt ${String(attempt)} tail: ${JSON.stringify(result.tail.slice(-200))}`);
      await sleep(500);
    }

    await page.screenshot({ path: join(root, "docs", "evidence", "probe-guest-echo2.png"), fullPage: true });
    console.log("[probe] wrote docs/evidence/probe-guest-echo2.png");
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGTERM");
  }
}

await main();
