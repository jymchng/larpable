/**
 * Diagnostic probe v2: what the pty echoes back when the acceptance run types a base64 write
 * command, character for character, at the speed `typeLine` uses.
 *
 * The acceptance run refuses to press Enter until the terminal's DOM mirror contains the whole
 * typed line (`echoesWholeLine`). When it never does, the run retries, then reports "the guest
 * never answered" \u2014 without ever having pressed Enter, so nothing was written and the failure
 * reads as a guest that stopped talking. This probe separates the two possibilities:
 *
 *   - the echo really is incomplete (the guest dropped characters), or
 *   - the echo is complete but the comparison cannot see it (wrapping, mirror loss).
 *
 * It prints the first character where the typed line and the echoed line diverge, so the answer
 * is a position, not a hunch.
 *
 *   bun scripts/probe-guest-stall.ts --echo
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

import { ensureBooted } from "./lib/boot.ts";
import { persistedFiles, persistToken } from "./lib/persist-check.ts";
import { sizeCommand, writeFileCommand } from "./lib/pty-channel.ts";

const root = resolve(import.meta.dirname, "..");
const outDir = join(root, "docs", "evidence");
const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(/\/+$/, "");

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

/** Where the echoed text stops matching the typed line, or -1. */
function firstDivergence(typed: string, mirror: string): number {
  const want = squeeze(typed);
  const have = squeeze(mirror);
  if (have.includes(want)) return -1;
  // Find the last index in `want` whose prefix is present, so the report names the character.
  for (let index = want.length; index > 0; index -= 1) {
    if (have.includes(want.slice(0, index))) {
      return index;
    }
  }
  return 0;
}

async function mirrorOf(page: Page): Promise<string> {
  return (await page.locator("[data-testid=terminal-output]").first().textContent()) ?? "";
}

async function main(): Promise<void> {
  const server = await ensureDevServer();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ executablePath: findChromium(), args: ["--no-sandbox"] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("pageerror", (error) => { console.log(`[pageerror] ${error.message.slice(0, 200)}`); });

    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    const boot = await ensureBooted(page, { timeoutMs: 180_000 });
    console.log(`[probe] boot: ${boot.path} after ${String(boot.waitedMs)} ms`);
    await page.locator("[data-testid=terminal-panel][data-connection=connected]").waitFor({ timeout: 120_000 });

    const token = persistToken();
    const [file] = persistedFiles(token) as [ReturnType<typeof persistedFiles>[number]];
    const write = writeFileCommand(file.path, file.content);
    const size = sizeCommand(file.path);

    // ---- create a project through the panel, exactly as the acceptance run does
    await page.locator("[data-testid=projects-toggle]").click();
    const name = `stall-${token.slice("larpable-persist-".length)}`;
    await page.locator("[data-testid=project-name]").fill(name);
    await page.locator("[data-testid=project-create-submit]").click();
    await page.locator("[data-testid=project-row]").filter({ hasText: name }).first().waitFor({ timeout: 30_000 });
    await page.keyboard.press("Escape");
    console.log(`[probe] project created: ${name}`);

    // ---- type the write command exactly as `typeLine` does, but stop before Enter
    await page.locator("[data-testid=terminal-screen]").click();
    await page.keyboard.press("Control+u");
    const typedAt = Date.now();
    await page.keyboard.type(write, { delay: 6 });
    console.log(`[probe] typed ${String(write.length)} chars in ${String(Date.now() - typedAt)} ms`);

    let mirror = "";
    for (let tick = 1; tick <= 60; tick += 1) {
      mirror = await mirrorOf(page);
      const divergence = firstDivergence(write, mirror.slice(-6_000));
      if (divergence === -1) {
        console.log(`[probe] whole line echoed after ${String(tick * 100)} ms`);
        break;
      }
      if (tick % 10 === 0) {
        console.log(
          `[probe] t+${String(tick * 100)}ms mirror=${String(mirror.length)} divergence at char ${String(divergence)}/${String(write.length)}`,
        );
      }
      await sleep(100);
    }

    const divergence = firstDivergence(write, mirror.slice(-6_000));
    console.log(`[probe] divergence after 6 s: ${String(divergence)} (-1 means the whole line echoed)`);
    if (divergence !== -1) {
      console.log(`[probe] typed  ...${JSON.stringify(squeeze(write).slice(Math.max(0, divergence - 40), divergence + 40))}`);
      console.log(`[probe] echoed ...${JSON.stringify(squeeze(mirror).slice(Math.max(0, divergence - 40), divergence + 40))}`);
    }
    console.log(`[probe] raw mirror tail: ${JSON.stringify(mirror.slice(-260))}`);

    // ---- now press Enter anyway and ask the guest whether the file arrived
    await page.keyboard.press("Enter");
    await sleep(1_500);
    await page.keyboard.type(size, { delay: 6 });
    await page.keyboard.press("Enter");
    const deadline = Date.now() + 20_000;
    let answered = "";
    while (Date.now() < deadline) {
      answered = await mirrorOf(page);
      if (answered.includes(`LARPABLE-SIZE ${file.path}`)) break;
      await sleep(250);
    }
    const sizeLine = answered.split(/\r?\n/).filter((line) => line.includes(`LARPABLE-SIZE ${file.path}`)).pop();
    console.log(`[probe] guest says: ${JSON.stringify(sizeLine ?? "(no size line)")}`);
    console.log(`[probe] host sent ${String(file.bytes)} bytes`);

    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: join(outDir, "probe-guest-echo.png"), fullPage: true });
    writeFileSync(
      join(outDir, "probe-guest-echo.json"),
      JSON.stringify({ write, mirror, divergence, sizeLine: sizeLine ?? null, bytes: file.bytes }, null, 2),
      "utf8",
    );
    console.log("[probe] wrote docs/evidence/probe-guest-echo.{png,json}");
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGTERM");
  }
}

await main();
