/**
 * Debug probe for the guest terminal: what is actually on screen, and can it be selected?
 *
 * This exists because two user reports ("I cannot highlight text" and "the /workspace
 * prompt is not showing") can both be explained by a terminal that is present but blank
 * or zero-sized. Guessing between those is the wrong move, so this script boots the real
 * guest in a real browser and measures geometry, xterm's own buffer, the transcript the
 * component exposes for tests, and whether a mouse drag produces a selection.
 *
 *   bun run dev                                  # in another terminal
 *   LARPABLE_ACCEPTANCE_URL=http://127.0.0.1:5173 bun scripts/probe-terminal.ts
 *
 * Exit code 0 only when a prompt is visible and a drag selects text.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { chromium, type Page } from "playwright-core";

const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);

const BOOT_TIMEOUT_MS = 240_000;
const PROMPT_TIMEOUT_MS = 60_000;

function findChromium(): string {
  const explicit = process.env.LARPABLE_CHROMIUM?.trim();
  if (explicit) return explicit;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) throw new Error(`no Playwright cache at ${cache}`);
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
  console.log(`[probe] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

/** Everything about the terminal pane that can be measured from the page. */
async function inspect(page: Page) {
  return await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        top: Math.round(box.top),
        left: Math.round(box.left),
      };
    };

    const panel = document.querySelector("[data-testid=terminal-panel]");
    const screen = document.querySelector("[data-testid=terminal-screen]");
    const rows = document.querySelector(".xterm-rows");
    const bufferText = rows ? (rows.textContent ?? "") : "";

    // Who receives a click in the middle of the terminal? An overlay here is the
    // difference between "xterm ignores the mouse" and "something else ate the event".
    let hit: string | null = null;
    if (screen) {
      const box = screen.getBoundingClientRect();
      const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      hit = element ? `${element.tagName.toLowerCase()}.${element.className}` : null;
    }

    return {
      connection: panel?.getAttribute("data-connection") ?? null,
      panelRect: rect("[data-testid=terminal-panel]"),
      screenRect: rect("[data-testid=terminal-screen]"),
      xtermRect: rect(".xterm"),
      xtermScreenRect: rect(".xterm-screen"),
      xtermCanvasCount: document.querySelectorAll(".xterm canvas").length,
      rowCount: rows ? rows.children.length : 0,
      bufferText: bufferText.slice(0, 400),
      xtermCssLoaded: Boolean(
        getComputedStyle(document.querySelector(".xterm") ?? document.body).getPropertyValue(
          "user-select",
        ),
      ),
      hit,
      transcript: (document.querySelector("[data-testid=terminal-output]")?.textContent ?? "").slice(
        -400,
      ),
      statusLine: document.querySelector("[data-testid=terminal-panel] p")?.textContent ?? null,
    };
  });
}

/** Drag across the first non-empty line of the terminal and report what got selected. */
async function dragSelect(page: Page) {
  const line = await page.evaluate(() => {
    const rows = document.querySelector(".xterm-rows");
    if (!rows) return null;
    for (const row of Array.from(rows.children)) {
      const text = (row.textContent ?? "").trim();
      if (text.length < 3) continue;
      const box = row.getBoundingClientRect();
      if (box.width < 10 || box.height < 5) continue;
      return { text, left: box.left, top: box.top, width: box.width, height: box.height };
    }
    return null;
  });
  if (!line) return { dragged: false as const };

  const y = line.top + line.height / 2;
  await page.mouse.move(line.left + 2, y);
  await page.mouse.down();
  await page.mouse.move(line.left + line.width + 40, y, { steps: 12 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const selection = document.querySelector(".xterm-selection");
    return {
      windowSelection: window.getSelection()?.toString() ?? "",
      selectionDivs: selection ? selection.querySelectorAll("div").length : -1,
      selectionVisible: selection
        ? Array.from(selection.querySelectorAll("div")).some((div) => {
            const box = div.getBoundingClientRect();
            const colour = getComputedStyle(div).backgroundColor;
            return box.width > 1 && box.height > 1 && !/rgba?\(0, 0, 0, 0\)/.test(colour);
          })
        : false,
    };
  });

  return { dragged: true as const, text: line.text, ...after };
}

/** Type a command into the live pty and wait until its marker shows up in the transcript. */
async function typeCommand(page: Page, command: string, marker: string) {
  await page.mouse.click(400, 300);
  await page.keyboard.type(command, { delay: 5 });
  await page.keyboard.press("Enter");

  const deadline = Date.now() + 30_000;
  let transcript = "";
  while (Date.now() < deadline) {
    transcript =
      (await page.locator("[data-testid=terminal-output]").textContent()) ?? "";
    if (transcript.includes(marker)) break;
    await page.waitForTimeout(250);
  }

  const line = transcript
    .split(/\r?\n/)
    .filter((entry) => entry.includes(marker))
    .pop();
  return { echoed: transcript.includes(marker), line: line ?? null, tail: transcript.slice(-300) };
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("console", (message) => {
    if (message.type() === "error") log("console.error", message.text());
  });

  let ok = false;
  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    await page.locator("[data-testid=boot-button]").click();
    await page
      .locator("[data-testid=env-status]", { hasText: "Ready" })
      .first()
      .waitFor({ timeout: BOOT_TIMEOUT_MS });
    log("boot", "ready");

    // The panel is what the user sees; wait until the shell is actually attached.
    await page
      .locator("[data-testid=terminal-panel][data-connection=connected]")
      .waitFor({ timeout: 60_000 });
    log("terminal", "connected");

    const deadline = Date.now() + PROMPT_TIMEOUT_MS;
    let state = await inspect(page);
    while (Date.now() < deadline && state.bufferText.trim().length === 0) {
      await page.waitForTimeout(500);
      state = await inspect(page);
    }

    log("state", state);
    const dragged = await dragSelect(page);
    log("drag", dragged);

    // Type into the real pty. This is the only way to see which shell the guest started,
    // what its PS1 is, and whether keystrokes are even echoed.
    const typed = await typeCommand(
      page,
      'printf "MARK sh=%s bash=%s ps1=[%s] zero=%s\\n" "$(readlink -f /bin/sh)" "$(command -v bash || echo none)" "$PS1" "$0"',
      "MARK",
    );
    log("typed", typed);
    await page.screenshot({ path: "/tmp/terminal-marker.png", fullPage: true });

    const after = await inspect(page);
    log("state-after", { bufferText: after.bufferText, transcript: after.transcript.slice(-200) });

    // The verdict is the bug report, spelled out, measured on the prompt as it was
    // *before* anything was typed: the echoed command below deliberately contains the
    // words `\033` and `\w`, so scanning the later buffer would test the wrong thing.
    const promptText = state.bufferText;
    const hasPrompt = /\u21d2/.test(promptText) && promptText.trim().startsWith("/workspace");
    const hasEscapes = /\\\[|\\033|\\w \\|\\\]/.test(promptText);
    const commandRan = (typed.line ?? "").includes("MARK sh=");
    const selectedReadable = /\/workspace/.test(
      dragged.dragged ? dragged.windowSelection : "",
    );

    ok = hasPrompt && !hasEscapes && commandRan && selectedReadable;
    if (!ok) {
      log("verdict", {
        hasPrompt,
        hasEscapes,
        commandRan,
        selectedReadable,
        note: "prompt must render as `/workspace ⇒` with no literal escape sequences, a typed command must run, and a drag must select readable text",
      });
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  console.log(`[probe] ${ok ? "PASS" : "FAIL"}`);
  process.exitCode = ok ? 0 : 1;
}

await main();
