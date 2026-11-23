/**
 * Which Wisp proxy actually accepts *this* deployment's origin?
 *
 * The guest has no sockets of its own: in a browser every TCP connect it makes is carried
 * by a Wisp proxy over WebSocket. unkernel's only built-in default is
 * `wss://wisp.pi0.io:6680/`, and its own typings say that server "accepts only pages from
 * localhost or 127.0.0.1" — so a deployment on any other origin boots a guest with no
 * network at all, and `curl` reports `(7) Failed to connect` for every URL.
 *
 * This probe opens a WebSocket to each candidate *from the deployment's own origin* and
 * reports open / close / error, with and without the `wisp` subprotocol, because a server
 * can reject either. It measures the handshake only: no VM, no download.
 *
 *   bun scripts/probe-wisp-candidates.ts https://larpable.netlify.app/
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright-core";

const CANDIDATES = [
  "wss://wisp.pi0.io:6680/",
  "wss://wisp.mercurywork.shop/",
  "wss://wisp.mercurywork.shop",
];

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

const origin = (process.argv[2] ?? process.env.LARPABLE_ACCEPTANCE_URL ?? "").trim();
if (!origin) throw new Error("usage: bun scripts/probe-wisp-candidates.ts <deployment-url>");

const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
const page = await browser.newPage();
await page.goto(origin, { waitUntil: "domcontentloaded" });
console.log(`[wisp] probing from ${await page.evaluate(() => location.origin)}`);

const results = await page.evaluate(async (urls: string[]) => {
  const attempt = (url: string, protocols?: string[]) =>
    new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("timeout 10s"), 10_000);
      let socket: WebSocket;
      try {
        socket = protocols ? new WebSocket(url, protocols) : new WebSocket(url);
      } catch (cause) {
        clearTimeout(timer);
        resolve(`constructor threw: ${String(cause)}`);
        return;
      }
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        const negotiated = socket.protocol.length > 0 ? socket.protocol : "(none)";
        socket.close();
        resolve(`open, protocol=${negotiated}`);
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        resolve("error");
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        resolve(`close ${String(event.code)}${event.reason ? ` ${event.reason}` : ""}`);
      });
    });

  const out: Array<{ url: string; bare: string; withSubprotocol: string }> = [];
  for (const url of urls) {
    out.push({
      url,
      bare: await attempt(url),
      withSubprotocol: await attempt(url, ["wisp"]),
    });
  }
  return out;
}, CANDIDATES);

for (const row of results) {
  console.log(`[wisp] ${row.url}\n        bare=${row.bare}\n        wisp=${row.withSubprotocol}`);
}

await browser.close();
