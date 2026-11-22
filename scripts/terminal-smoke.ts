/**
 * Evidence run for the guest terminal: boot Linux, type into the terminal the way a
 * person does, and assert on what the shell actually printed.
 *
 * This is the ad-hoc proof for the terminal itself; the permanent, scripted assertions
 * belong in `scripts/browser-acceptance.ts`. Usage:
 *
 *   bun run dev                          # in another terminal
 *   bun scripts/terminal-smoke.ts [url]
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

/** The transcript carries the terminal's escape sequences; the log does not need them. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
}

const url = process.argv[2] ?? "http://localhost:5173/";
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const failures: string[] = [];

async function transcript(): Promise<string> {
  return stripAnsi((await page.locator('[data-testid="terminal-output"]').textContent()) ?? "");
}

/** Wait until the mirrored transcript shows `count` occurrences of `needle`. */
async function waitForCount(needle: string, count: number, timeout = 30_000): Promise<void> {
  await page.waitForFunction(
    ({ text, times }) => {
      const body = document.querySelector('[data-testid="terminal-output"]')?.textContent ?? "";
      return body.split(text).length - 1 >= times;
    },
    { text: needle, times: count },
    { timeout },
  );
}

try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="boot-button"]').click();
  await page
    .locator('[data-testid="env-status"]', { hasText: "Ready" })
    .waitFor({ timeout: 150_000 });
  console.log("environment: ready");

  await page
    .locator('[data-testid="terminal-status"]', { hasText: "Connected" })
    .waitFor({ timeout: 60_000 });
  console.log("terminal: connected");

  await page.locator('[data-testid="terminal-screen"]').click();

  // 1. A shell, in the workspace, listing the project the guest booted with.
  await page.keyboard.type("pwd; ls\r", { delay: 12 });
  await waitForCount("package.json", 1);
  const afterLs = await transcript();
  console.log("---- after `pwd; ls` ----\n" + afterLs.slice(-500));

  // 2. The shell writes a file and reads it back: the 9p mount, driven by the user.
  await page.keyboard.type("echo hi-larpable > hi.txt; cat hi.txt\r", { delay: 12 });
  // Once for the echoed command, once for what `cat` printed.
  await waitForCount("hi-larpable", 2);
  const afterCat = await transcript();
  console.log("---- after writing and cat-ing hi.txt ----\n" + afterCat.slice(-400));

  if (!afterLs.includes("/workspace")) failures.push("`pwd` did not report /workspace");
  if (!afterLs.includes("package.json")) failures.push("`ls` did not list the project");
  if ((afterCat.split("hi-larpable").length - 1) < 2) {
    failures.push("`cat` of a file the shell had just written printed nothing");
  }

  await page.screenshot({ path: "docs/evidence/terminal-shell.png", fullPage: false });
} finally {
  await browser.close();
}

if (failures.length > 0) {
  console.error("FAILED:", failures.join("; "));
  process.exit(1);
}
console.log("terminal smoke: PASS");
