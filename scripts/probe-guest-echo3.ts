/**
 * Diagnostic probe v4: replay the acceptance run's persistence step verbatim and, when it fails,
 * find out which layer went quiet.
 *
 * v2/v3 typed the same command into the same app after the same setup and it worked, so the
 * failure is not simply "a project exists". The remaining differences are inside the real
 * `runInTerminal` (two lines typed back to back, a marker poll, two retries) and the app's own
 * state after the self-test. This probe therefore calls the production helpers unchanged, then
 * interrogates the page afterwards: is the pty still echoing at all, is the shell still connected,
 * what does the pane's own error surface say, and what did the console print.
 *
 *   bun scripts/probe-guest-echo3.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

import { SELF_TEST_BUTTON, ensureBooted, openDiagnostics } from "./lib/boot.ts";
import { persistedFiles, persistToken } from "./lib/persist-check.ts";
import { sizeCommand, sizeFromTranscript, sizeLine, writeFileCommand } from "./lib/pty-channel.ts";
import { runInTerminal, transcript } from "./lib/term-channel.ts";

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

async function paneState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panel = document.querySelector("[data-testid=terminal-panel]");
    const notice = panel?.querySelector("p")?.textContent ?? "";
    const connection = panel?.getAttribute("data-connection") ?? "(none)";
    const mirror = document.querySelector("[data-testid=terminal-output]")?.textContent ?? "";
    return JSON.stringify({
      connection,
      notice: notice.slice(0, 160),
      mirror: mirror.length,
      tail: mirror.slice(-200),
      tabs: document.querySelectorAll("[data-testid=terminal-tab]").length,
      summary: (document.querySelector("[data-testid=environment-summary]")?.textContent ?? "").trim(),
    });
  });
}

async function main(): Promise<void> {
  const server = await ensureDevServer();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: findChromium(), headless: true });
    const page = await browser.newPage();
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("React DevTools") || text.includes("[vite]")) return;
      console.log(`[console:${message.type()}] ${text.slice(0, 240)}`);
    });
    page.on("pageerror", (error) => { console.log(`[pageerror] ${error.message.slice(0, 240)}`); });

    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    const boot = await ensureBooted(page, { timeoutMs: 180_000 });
    console.log(`[probe] boot: ${boot.path} after ${String(boot.waitedMs)} ms`);
    await page.locator("[data-testid=terminal-panel][data-connection=connected]").waitFor({ timeout: 120_000 });

    await openDiagnostics(page);
    await page.locator(SELF_TEST_BUTTON).click();
    await page.locator("[data-testid=self-test-report]").first().waitFor({ timeout: 120_000 });

    const token = persistToken();
    const [file] = persistedFiles(token) as [ReturnType<typeof persistedFiles>[number]];
    const commands = [writeFileCommand(file.path, file.content), sizeCommand(file.path)];
    const name = `stall-${token.slice("larpable-persist-".length)}`;

    await page.locator("[data-testid=projects-toggle]").click();
    await page.locator("[data-testid=project-name]").fill(name);
    await page.locator("[data-testid=project-create-submit]").click();
    await page.locator("[data-testid=project-row]").filter({ hasText: name }).first().waitFor({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    console.log(`[probe] project created: ${name}`);
    console.log(`[probe] before typing: ${await paneState(page)}`);

    const answer = await runInTerminal(page, commands, sizeLine(file.path, file.bytes), 30_000);
    const seen = await transcript(page);
    console.log(`[probe] runInTerminal answered=${String(answer.answered)} reported=${String(sizeFromTranscript(seen, file.path, commands))}`);
    console.log(`[probe] after typing: ${await paneState(page)}`);

    // ---- is the pty still alive? type a short line by hand and watch for the echo
    await page.locator("[data-testid=terminal-screen]").click();
    await page.keyboard.press("Control+u");
    await page.keyboard.type("printf 'ALIVE-%s\\n' yes", { delay: 20 });
    const before = (await transcript(page)).length;
    await page.keyboard.press("Enter");
    let after = before;
    for (let tick = 0; tick < 20; tick += 1) {
      await sleep(250);
      after = (await transcript(page)).length;
      if (after !== before) break;
    }
    console.log(`[probe] after a hand-typed command: mirror ${String(before)} -> ${String(after)} ${after !== before ? "(the pty still answers)" : "(the pty is silent)"}`);
    console.log(`[probe] final pane: ${await paneState(page)}`);

    await page.screenshot({ path: join(root, "docs", "evidence", "probe-guest-echo3.png"), fullPage: true });
    console.log("[probe] wrote docs/evidence/probe-guest-echo3.png");
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGTERM");
  }
}

await main();
