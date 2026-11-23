/**
 * Measure `curl` in the deployed app, the way the report arrived: boot the
 * production site, type the command a user types, read what came back.
 *
 * The guest's `curl` is a *first-use shim*: the first call can take ~90 s and can
 * exit non-zero, and an unprivileged uid 1000 cannot `apk add` a replacement. So
 * "curl failed" has several possible meanings — shim that never resolved, no
 * network through the Wisp proxy, TLS without a CA bundle, or a binary that is
 * not there at all. This script separates them instead of guessing.
 *
 * Each step prints a sentinel on its own line and the probe returns every line
 * between the echoed command and that sentinel *verbatim*, so the recorded
 * output is what the guest actually printed. An earlier version matched a
 * substring that the command itself contained, which made a step "answer"
 * before it had run — a failed fetch then looked like a pass.
 *
 *   LARPABLE_ACCEPTANCE_URL=https://larpable.netlify.app bun scripts/probe-curl-deployed.ts
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "playwright-core";

const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "https://larpable.netlify.app").replace(
  /\/+$/,
  "",
);

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
  throw new Error(`no Chromium under ${cache}`);
}

const transcript: string[] = [];

function log(label: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`[curl] ${label}: ${text}`);
  transcript.push(`## ${label}\n${text}`);
}

let sentinel = 0;

/**
 * Type one line and return the guest's output for it, verbatim.
 *
 * The timeout is generous on purpose: the first `curl` invocation pays the
 * shim's download before it can answer at all.
 */
async function type(page: Page, command: string, timeoutMs = 180_000) {
  const done = `__PROBE_DONE_${++sentinel}__`;
  // The sentinel is assembled from two pieces so the echoed command line cannot
  // match the sentinel the probe is waiting for.
  const line = `${command}; echo "__PROBE_DONE_""${sentinel}__"`;

  await page.mouse.click(400, 300);
  await page.keyboard.type(line, { delay: 2 });
  await page.keyboard.press("Enter");

  // Read the *whole* transcript and look for the sentinel rather than assuming the
  // DOM grows exactly where we expect. xterm renders on requestAnimationFrame, and a
  // headless page that nobody is painting can lag a whole step behind the terminal
  // buffer — which made the previous version of this probe report every step as
  // unanswered while printing its output one step later.
  const readAll = async () => (await page.locator("[data-testid=terminal-output]").textContent()) ?? "";
  const deadline = Date.now() + timeoutMs;
  let full = "";
  while (Date.now() < deadline) {
    full = await readAll();
    if (full.includes(done)) break;
    // Nudge the compositor so a throttled frame actually flushes.
    await page.evaluate(() => window.dispatchEvent(new Event("resize"))).catch(() => undefined);
    await page.waitForTimeout(250);
  }

  const answered = full.includes(done);
  const lines = full
    .split(/\r?\n/)
    .map((entry) => entry.replace(/\u00a0/g, " ").trimEnd());
  const stop = lines.lastIndexOf(lines.find((entry) => entry.includes(done)) ?? "");
  const start = Math.max(0, lines.findIndex((entry) => entry.includes(command.slice(0, 40))));
  const output = lines
    .slice(start + 1, stop === -1 ? undefined : stop)
    .map((entry) => entry.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim())
    .filter((entry) => entry.length > 0);

  return { answered, command, output, lines: lines.length };
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
    // Without these, a headless page is treated as occluded and requestAnimationFrame
    // is throttled, so xterm's buffer reaches the DOM a step late.
    args: [
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    const bootedAt = Date.now();
    await page.locator("[data-testid=boot-button]").click();
    await page
      .locator("[data-testid=env-status]", { hasText: "Ready" })
      .first()
      .waitFor({ timeout: 240_000 });
    await page
      .locator("[data-testid=terminal-panel][data-connection=connected]")
      .waitFor({ timeout: 90_000 });
    log("boot", `ready at ${baseUrl} after ${((Date.now() - bootedAt) / 1000).toFixed(1)}s`);

    log("binary", await type(page, 'command -v curl; readlink -f "$(command -v curl)"'));
    // The goal asks for a real `curl --version`, so capture its first two lines
    // and the exit status of the pipeline itself.
    log("version", await type(page, "curl --version 2>&1 | head -2; echo \"RC=$?\""));

    log(
      "https1",
      await type(
        page,
        'curl -sS --max-time 30 -o /dev/null -w "HTTP=%{http_code} time=%{time_total}s\\n" https://example.com 2>&1; echo "RC=$?"',
        120_000,
      ),
    );

    log(
      "https2",
      await type(
        page,
        'curl -sS --max-time 30 -o /dev/null -w "HTTP=%{http_code} time=%{time_total}s\\n" https://example.com 2>&1; echo "RC=$?"',
        120_000,
      ),
    );

    log(
      "plainHttp",
      await type(
        page,
        'curl -sS --max-time 20 -o /dev/null -w "HTTP=%{http_code} time=%{time_total}s\\n" http://example.com 2>&1; echo "RC=$?"',
        120_000,
      ),
    );

    log(
      "body",
      await type(
        page,
        'curl -sS --max-time 30 https://example.com | head -c 120; echo; echo "RC=$?"',
        120_000,
      ),
    );

    log("dns", await type(page, 'getent hosts example.com; echo "RC=$?"', 60_000));

    await page.screenshot({ path: "/tmp/curl-probe.png", fullPage: true });
    writeFileSync("/tmp/curl-probe-transcript.md", `${transcript.join("\n\n")}\n`);
    console.log("[curl] transcript: /tmp/curl-probe-transcript.md");
  } finally {
    await browser.close().catch(() => undefined);
  }
}

await main();
