/**
 * Throwaway probe: can the page reach unkernel's default Wisp server at all?
 *
 *   bun scripts/probe-wisp.ts https://larpable.netlify.app/ http://localhost:5174/
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

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

const urls = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: findChromium(), headless: true });

for (const url of urls) {
  const page = await browser.newPage();
  const messages: string[] = [];
  page.on("console", (message) => messages.push(`${message.type()}: ${message.text()}`));
  await page.goto(url, { waitUntil: "domcontentloaded" });

  const result = await page.evaluate(async () => {
    const outcome = await new Promise<string>((resolve) => {
      const socket = new WebSocket("wss://wisp.pi0.io:6680/");
      const timer = setTimeout(() => resolve("timeout after 8 s"), 8000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        socket.close();
        resolve("open");
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        resolve("error");
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve(`close ${String(event.code)}`);
      });
    });
    return {
      outcome,
      isolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ?? null,
      origin: location.origin,
    };
  });

  console.log(`${url}\n  ${JSON.stringify(result)}\n  console: ${messages.slice(0, 6).join(" | ")}`);
  await page.close();
}

await browser.close();
process.exit(0);
