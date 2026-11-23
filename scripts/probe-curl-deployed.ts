/**
 * Measure `curl` in the deployed app, the way the report arrived: boot the production
 * site, type the command a user types, read what came back.
 *
 * The guest's `curl` is a *first-use shim*: the first call can take ~90 s and can exit
 * non-zero, and an unprivileged uid 1000 cannot `apk add` a replacement. So "curl failed"
 * has several possible meanings — shim that never resolved, no network through the Wisp
 * proxy, TLS without a CA bundle, or a binary that is not there at all. This script
 * separates them instead of guessing.
 *
 *   LARPABLE_ACCEPTANCE_URL=https://larpable.netlify.app bun scripts/probe-curl-deployed.ts
 */

import { existsSync, readdirSync } from "node:fs";
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

function log(label: string, value: unknown): void {
  console.log(`[curl] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

/**
 * Type a line and wait for its marker. The timeout is generous because the guest's curl
 * is a first-use shim: the first invocation pays a download before it can answer.
 */
async function type(page: Page, command: string, marker: string, timeoutMs = 180_000) {
  const before = (await page.locator("[data-testid=terminal-output]").textContent()) ?? "";
  await page.mouse.click(400, 300);
  await page.keyboard.type(command, { delay: 2 });
  await page.keyboard.press("Enter");

  const deadline = Date.now() + timeoutMs;
  let transcript = before;
  while (Date.now() < deadline) {
    transcript = (await page.locator("[data-testid=terminal-output]").textContent()) ?? "";
    if (transcript.slice(before.length).includes(marker)) break;
    await page.waitForTimeout(400);
  }

  const fresh = transcript.slice(before.length);
  const lines = fresh.split(/\r?\n/).map((line) => line.trim());
  const at = lines.findIndex((line) => line.includes(marker));
  return {
    answered: at !== -1,
    output: lines.slice(Math.max(0, at - 6), at + 1).filter((line) => line.length > 0),
  };
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    await page.locator("[data-testid=boot-button]").click();
    await page
      .locator("[data-testid=env-status]", { hasText: "Ready" })
      .first()
      .waitFor({ timeout: 240_000 });
    await page
      .locator("[data-testid=terminal-panel][data-connection=connected]")
      .waitFor({ timeout: 90_000 });
    log("boot", `ready at ${baseUrl}`);

    log(
      "which",
      await type(
        page,
        'printf "MARK curl=%s real=%s\\n" "$(command -v curl || echo none)" "$(readlink -f "$(command -v curl 2>/dev/null)" 2>/dev/null || echo none)"',
        "MARK",
      ),
    );

    log("version", await type(page, 'curl --version 2>&1 | head -3; echo "RCMARK=$?"', "RCMARK"));

    log(
      "example",
      await type(
        page,
        'curl -sS -o /dev/null -w "HTTP=%{http_code} time=%{time_total}s\\n" https://example.com 2>&1; echo "RCMARK=$?"',
        "RCMARK",
        240_000,
      ),
    );

    log("dns", await type(page, 'getent hosts example.com || echo "RCMARK=no-resolver"', "RCMARK"));
    await page.screenshot({ path: "/tmp/curl-probe.png", fullPage: true });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

await main();
