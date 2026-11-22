/**
 * Throwaway probe: does `curl` work in the browser guest's terminal (the real product
 * path: Wisp networking, not the host's sockets)?
 *
 *   bun scripts/probe-curl-browser.ts https://larpable.netlify.app/
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

function findChromium(): string {
  const explicit = process.env.LARPABLE_CHROMIUM?.trim();
  if (explicit) return explicit;
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
  throw new Error("no Chromium binary found; set LARPABLE_CHROMIUM");
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

const url = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (message) => {
  if (message.type() === "error") console.log(`[console.error] ${message.text()}`);
});

async function transcript(): Promise<string> {
  return stripAnsi((await page.locator('[data-testid="terminal-output"]').textContent()) ?? "");
}

async function typeAndSettle(command: string, waitMs = 20_000): Promise<void> {
  const before = (await transcript()).length;
  await page.keyboard.type(`${command}\r`, { delay: 10 });
  for (let waited = 0; waited < waitMs; waited += 500) {
    await page.waitForTimeout(500);
    const text = await transcript();
    if (text.length > before + 40 && /⇒|\$/.test(text.trimEnd().slice(-40))) return;
  }
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="boot-button"]').click();
  await page.locator('[data-testid="env-status"]', { hasText: "Ready" }).waitFor({ timeout: 180_000 });
  console.log("environment: ready");

  // Production and dev differ here: one auto-connects, the other offers "New shell".
  const connected = page.locator('[data-testid="terminal-status"]', { hasText: "Connected" });
  if (!(await connected.isVisible().catch(() => false))) {
    const newShell = page.getByRole("button", { name: "New shell" });
    if (await newShell.isVisible().catch(() => false)) {
      await newShell.click();
      console.log("clicked New shell");
    }
  }
  await connected.waitFor({ timeout: 60_000 });
  console.log("terminal: connected");

  await page.locator('[data-testid="terminal-screen"]').click();

  for (const command of [
    "id -u; echo PATH=$PATH",
    "curl -sS -o /dev/null -w 'http=%{http_code}\\n' https://example.com/ 2>&1",
    "curl -sS -o /dev/null -w 'http=%{http_code}\\n' https://example.com/ 2>&1",
    "wget -q -O /dev/null https://example.com/ && echo WGET-OK || echo WGET-FAIL",
    "curl -sS -o /dev/null -w 'http=%{http_code}\\n' http://example.com/ 2>&1",
  ]) {
    await typeAndSettle(command);
    console.log(`\n#### ${command}\n${(await transcript()).slice(-600)}`);
  }

  await page.screenshot({ path: "docs/evidence/probe-curl-production.png" });
} finally {
  await browser.close();
}
process.exit(0);
