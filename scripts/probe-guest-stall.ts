/**
 * Diagnostic probe: why does typing into the guest stop producing output after a project is
 * created through the projects panel?
 *
 * This is a measurement tool, not an acceptance run. It answers one question with evidence:
 * when the terminal's DOM mirror stops growing, *which layer* stopped?
 *
 *   - the guest/pty (no bytes arrive)          -> xterm's own rows also stop
 *   - the mirror/React (bytes arrive, no DOM)  -> xterm's rows keep growing, the mirror does not
 *   - the page's main thread (nothing runs)    -> the rAF/interval tick counters freeze
 *
 * So it records, every second: the mirror's length, xterm's rendered row text, the rAF and
 * interval tick counts, and the live environment summary. It types one short command before the
 * project is created and the same command after, so "it used to work" is measured, not assumed.
 *
 *   bun scripts/probe-guest-stall.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

import { ensureBooted, openDiagnostics, readStatusText } from "./lib/boot.ts";

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

interface Sample {
  at: number;
  mirror: number;
  rows: string;
  rafTicks: number;
  intervalTicks: number;
  summary: string;
}

async function sample(page: Page): Promise<Sample> {
  return page.evaluate(() => {
    const w = window as unknown as { __rafTicks?: number; __intervalTicks?: number };
    const mirror = document.querySelector("[data-testid=terminal-output]")?.textContent ?? "";
    const rows = document.querySelector(".xterm-rows")?.textContent ?? "(no .xterm-rows)";
    const summary = document.querySelector("[data-testid=environment-summary]")?.textContent ?? "";
    return {
      at: Date.now(),
      mirror: mirror.length,
      rows: rows.slice(-160),
      rafTicks: w.__rafTicks ?? -1,
      intervalTicks: w.__intervalTicks ?? -1,
      summary: summary.trim(),
    };
  });
}

async function typeLine(page: Page, line: string): Promise<void> {
  await page.locator("[data-testid=terminal-screen]").click();
  await page.keyboard.press("Control+u");
  await page.keyboard.type(line, { delay: 12 });
  await page.keyboard.press("Enter");
}

async function watch(page: Page, seconds: number, label: string): Promise<Sample[]> {
  const samples: Sample[] = [];
  const deadline = Date.now() + seconds * 1_000;
  while (Date.now() < deadline) {
    const current = await sample(page);
    samples.push(current);
    console.log(
      `[probe] ${label} t+${String(samples.length).padStart(2, "0")}s mirror=${String(current.mirror).padStart(6)} raf=${String(current.rafTicks).padStart(5)} int=${String(current.intervalTicks).padStart(4)} rows=${JSON.stringify(current.rows.slice(-60))}`,
    );
    await sleep(1_000);
  }
  return samples;
}

async function main(): Promise<void> {
  const server = await ensureDevServer();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      executablePath: findChromium(),
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    await page.addInitScript(() => {
      const w = window as unknown as { __rafTicks: number; __intervalTicks: number };
      w.__rafTicks = 0;
      w.__intervalTicks = 0;
      const tick = (): void => {
        w.__rafTicks += 1;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      setInterval(() => {
        w.__intervalTicks += 1;
      }, 250);
    });

    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[vite]")) return;
      console.log(`[console:${message.type()}] ${text.slice(0, 300)}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[pageerror] ${error.message.slice(0, 300)}`);
    });

    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    const boot = await ensureBooted(page, { timeoutMs: 180_000, log: (line) => { console.log(`[probe] ${line}`); } });
    console.log(`[probe] boot path: ${boot.path} after ${String(boot.waitedMs)} ms`);

    await page.locator("[data-testid=terminal-panel][data-connection=connected]").waitFor({ timeout: 120_000 });
    console.log("[probe] terminal connected");

    // ---- baseline: a short command, before any project exists
    await typeLine(page, "printf 'PING-%s\\n' one");
    const before = await watch(page, 4, "baseline");
    console.log(`[probe] baseline mirror contains PING-one: ${String((await page.locator("[data-testid=terminal-output]").textContent())?.includes("PING-one"))}`);

    // ---- create a project through the panel, exactly as the acceptance run does
    await openDiagnostics(page).catch(() => undefined);
    await page.keyboard.press("Escape");
    await page.locator("[data-testid=projects-toggle]").click();
    const name = `stall-${Date.now().toString(36)}`;
    await page.locator("[data-testid=project-name]").fill(name);
    await page.locator("[data-testid=project-create-submit]").click();
    await page.locator("[data-testid=project-row]").filter({ hasText: name }).first().waitFor({ timeout: 30_000 });
    console.log(`[probe] project created: ${name}`);
    await page.keyboard.press("Escape");
    await sleep(1_000);

    // ---- the same command, after the project exists
    await typeLine(page, "printf 'PING-%s\\n' two");
    const after = await watch(page, 10, "after-create");

    // ---- a longer command, like the base64 write the acceptance run uses
    await typeLine(page, `printf %s '${Buffer.from("hello from the guest\n").toString("base64")}' | base64 -d > probe.txt`);
    await watch(page, 6, "after-create-long");

    const finalMirror = (await page.locator("[data-testid=terminal-output]").textContent()) ?? "";
    console.log(`[probe] final mirror length ${String(finalMirror.length)}`);
    console.log(`[probe] final mirror tail: ${JSON.stringify(finalMirror.slice(-300))}`);
    console.log(`[probe] status: ${await readStatusText(page)}`);

    mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: join(outDir, "probe-guest-stall.png"), fullPage: true });
    writeFileSync(
      join(outDir, "probe-guest-stall.json"),
      JSON.stringify({ before, after, finalMirror }, null, 2),
      "utf8",
    );
    console.log("[probe] wrote docs/evidence/probe-guest-stall.{png,json}");
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGTERM");
  }
}

await main();
