/**
 * The machine starts itself: measured in Chromium, with no click.
 *
 * The unit suite proves the rules (`tests/autoboot.test.ts`) and, under jsdom, that mounting
 * the shell calls `boot()` once and survives `StrictMode` (`tests/autoboot-hook.test.tsx`).
 * Neither can prove the thing the user asked for: open the app and the kernel is *already
 * starting*, with a spinner, and it reaches Ready without anyone pressing anything.
 *
 * So this run does exactly what a person does — `page.goto`, then nothing — and measures:
 *
 * - the spinner is in the page, plays an animation, and has an accessible name;
 * - **one** request is made for `/distros/debian.erofs` (a second kernel would download and
 *   boot the image twice; `StrictMode` double-mounting is the trap this catches);
 * - the app reaches Ready and the spinner is gone;
 * - the page does not overflow sideways at 390 px with the extra header chrome;
 * - on a browser that cannot boot (`?simulateSupport=no-jspi`) there is no spinner and no boot,
 *   because the support probe already said it would fail.
 *
 *   bun run acceptance:autoboot
 *
 * Output: `docs/evidence/autoboot-spinner-390.png`, `autoboot-ready-390.png`,
 * `autoboot-unsupported-390.png`, and the transcript in `docs/evidence/autoboot-acceptance.txt`.
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
const transcriptPath = join(evidenceDir, "autoboot-acceptance.txt");

const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);
const DEV_HOST = "127.0.0.1";
const BOOT_TIMEOUT_MS = 240_000;
const SERVER_TIMEOUT_MS = 60_000;
const SPINNER_TIMEOUT_MS = 30_000;

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
  console.log(`[autoboot] ${baseUrl} is down; starting \`bun run dev\` on ${DEV_HOST}`);
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

interface SpinnerObservation {
  present: boolean;
  label: string | null;
  role: string | null;
  animation: string;
  footer: string;
  overflowPx: number;
}

async function observeSpinner(page: Page): Promise<SpinnerObservation> {
  return await page.evaluate(() => {
    const spinner = document.querySelector<HTMLElement>("[data-testid=boot-spinner]");
    const icon = document.querySelector<HTMLElement>("[data-testid=boot-spinner-icon]");
    const style = icon === null ? null : getComputedStyle(icon);
    // The visible footer is gone (its sentence moved into the debug popover); the shell keeps
    // the same words in a visually hidden live region, which is what this reads.
    const summary = document.querySelector("[data-testid=environment-summary]");
    return {
      present: spinner !== null,
      label: spinner?.getAttribute("aria-label") ?? null,
      role: spinner?.getAttribute("role") ?? null,
      animation: style?.animationName ?? "none",
      footer: summary?.textContent?.trim() ?? "",
      overflowPx: Math.max(
        0,
        (document.scrollingElement?.scrollWidth ?? 0) - (document.scrollingElement?.clientWidth ?? 0),
      ),
    };
  });
}

async function waitForSpinner(page: Page): Promise<SpinnerObservation> {
  const deadline = Date.now() + SPINNER_TIMEOUT_MS;
  let last = await observeSpinner(page);
  while (Date.now() < deadline) {
    if (last.present) return last;
    await sleep(100);
    last = await observeSpinner(page);
  }
  return last;
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  const server = await ensureDevServer();
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      executablePath: findChromium(),
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    // The image is read in HTTP ranges (measured: one plain request for `/distros/debian.erofs`
    // plus eight `Range` reads covering 0..28.3 MB of the 72.6 MB file), so the honest probe for
    // "did a second kernel start?" is not the request count — it is whether any offset is
    // requested twice. A StrictMode double-boot re-reads the same ranges.
    const imageRanges: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/distros/") && request.url().endsWith(".erofs")) {
        imageRanges.push(request.headers()["range"] ?? "(full)");
      }
    });
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    // ---------------------------------------------------------------- the spinner
    const startedAt = Date.now();
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });

    const spinner = await waitForSpinner(page);
    check("the spinner appears without a click", spinner.present, `aria-label=${JSON.stringify(spinner.label)}`);
    check(
      "the spinner is named for a screen reader",
      spinner.role === "status" && spinner.label === "Starting Linux",
      `role=${JSON.stringify(spinner.role)}, aria-label=${JSON.stringify(spinner.label)}`,
    );
    check(
      "the spinner actually animates",
      spinner.animation !== "none" && spinner.animation.length > 0,
      `animation-name=${spinner.animation}`,
    );
    check(
      "the footer says the machine is starting",
      /Linux: (Initializing|Not started)/.test(spinner.footer),
      spinner.footer,
    );
    check(
      "the header does not overflow at 390 px while starting",
      spinner.overflowPx === 0,
      `scrollWidth - clientWidth = ${String(spinner.overflowPx)} px`,
    );
    await page.screenshot({ path: join(evidenceDir, "autoboot-spinner-390.png") });

    // ---------------------------------------------------------------- ready
    const readyDeadline = Date.now() + BOOT_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < readyDeadline) {
      const footer = await page.evaluate(() => document.querySelector("footer")?.textContent ?? "");
      if (/Linux: Ready/.test(footer)) {
        ready = true;
        break;
      }
      await sleep(500);
    }
    const bootMs = Date.now() - startedAt;
    check("the machine reaches Ready with no click", ready, `${String(bootMs)} ms from navigation`);

    const after = await observeSpinner(page);
    check("the spinner is gone once the machine is ready", !after.present, `present=${String(after.present)}`);
    check(
      "the app's own boot duration is published",
      /booted in/.test(
        await page.evaluate(
          () => document.querySelector("[data-testid=boot-duration]")?.textContent ?? "",
        ),
      ),
      await page.evaluate(
        () => document.querySelector("[data-testid=boot-duration]")?.textContent?.trim() ?? "(none)",
      ),
    );
    const duplicates = imageRanges.filter((range, index) => imageRanges.indexOf(range) !== index);
    check(
      "one image was read, in ranges with no offset requested twice (no second kernel)",
      imageRanges.length > 0 && duplicates.length === 0 && imageRanges.filter((r) => r === "(full)").length <= 1,
      `${String(imageRanges.length)} request(s), duplicates: ${duplicates.length === 0 ? "none" : duplicates.join(", ")}`,
    );
    await page.screenshot({ path: join(evidenceDir, "autoboot-ready-390.png") });

    // ---------------------------------------------------------------- unsupported
    const unsupported = await context.newPage();
    await unsupported.goto(`${baseUrl}/?simulateSupport=no-jspi`, { waitUntil: "domcontentloaded" });
    await sleep(3_000);
    const blocked = await observeSpinner(unsupported);
    const problems = await unsupported.evaluate(
      () => document.querySelector("[data-testid=support-problems]")?.textContent ?? "",
    );
    check(
      "an unsupported browser shows no spinner and no boot",
      !blocked.present && /Linux: Not started/.test(blocked.footer),
      `spinner=${String(blocked.present)}, footer=${JSON.stringify(blocked.footer)}`,
    );
    check(
      "an unsupported browser still explains itself",
      /cannot boot Linux/.test(problems),
      problems.replace(/\s+/g, " ").slice(0, 160),
    );
    await unsupported.screenshot({ path: join(evidenceDir, "autoboot-unsupported-390.png") });

    lines.push(`boot: ${String(bootMs)} ms from navigation to Ready`);
    lines.push(`image range requests: ${String(imageRanges.length)}`);
    lines.push(
      `console errors: ${consoleErrors.length === 0 ? "(none)" : consoleErrors.slice(0, 3).join(" | ")}`,
    );
  } finally {
    await browser?.close().catch(() => undefined);
    server?.kill("SIGTERM");
    const failed = checks.filter((entry) => !entry.ok).length;
    const header = `[autoboot] ${String(checks.length - failed)}/${String(checks.length)} checks passed against ${baseUrl}`;
    writeFileSync(transcriptPath, `${[...lines, "", header].join("\n")}\n`, "utf8");
    console.log(`\n${header}`);
    if (failed > 0) process.exitCode = 1;
  }
}

await main();
