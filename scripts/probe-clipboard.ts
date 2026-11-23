/**
 * What do the terminal panel's clipboard actions actually put on the clipboard?
 *
 * The user's report is "Copy / Paste / Cut ... is always acting on all the content on the
 * terminal panel". That sentence can describe at least four different bugs, so this script
 * boots the real guest in a real browser, selects three known words with a mouse drag, and
 * measures every path separately: the header buttons, Ctrl+C/Ctrl+X, a drag that leaves the
 * terminal, a second Copy click, two shells and a paste, and Clear.
 *
 * For each action it records what the pane's notice says, what `navigator.clipboard` holds
 * afterwards (the clipboard is reset to a sentinel before every action, so "did it change?"
 * is unambiguous), whether the DOM selection includes the sr-only transcript mirror, and
 * every `copy`/`cut`/`paste` event the document saw. Nothing is asserted from a guess.
 *
 *   bun run dev                                        # in another terminal
 *   LARPABLE_ACCEPTANCE_URL=http://127.0.0.1:5173 bun scripts/probe-clipboard.ts
 *
 * Output:
 *   docs/terminal-clipboard-report.md     this run's measurements and verdict
 *   docs/evidence/terminal-clipboard.txt  the same transcript, plain text
 *   docs/evidence/terminal-clipboard.png  the panel as it was when measured
 *
 * Exit code 0 only when every check passed.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const reportPath = join(root, "docs", "terminal-clipboard-report.md");
const transcriptPath = join(root, "docs", "evidence", "terminal-clipboard.txt");
const shotPath = join(root, "docs", "evidence", "terminal-clipboard.png");

const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);

const BOOT_TIMEOUT_MS = 240_000;

/** The line the probe prints, and the three words it drags over. */
const LINE = "alpha bravo charlie delta echo";
const FROM = 1;
const COUNT = 3;
const EXPECTED = LINE.split(/\s+/)
  .slice(FROM, FROM + COUNT)
  .join(" ");
const SENTINEL = "SENTINEL-BEFORE-ACTION";

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

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const measurements: Record<string, unknown> = {};
const log: string[] = [];

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  log.push(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
}

function note(label: string, value: unknown): void {
  measurements[label] = value;
  log.push(`[measure] ${label}: ${JSON.stringify(value)}`);
}

interface Clip {
  ok: boolean;
  length?: number;
  head?: string;
  tail?: string;
  error?: string;
}

async function readClipboard(page: Page): Promise<Clip> {
  return await page.evaluate(async () => {
    try {
      const text = await navigator.clipboard.readText();
      return { ok: true, length: text.length, head: text.slice(0, 40), tail: text.slice(-40) };
    } catch (cause) {
      return { ok: false, error: String(cause) };
    }
  });
}

async function writeClipboard(page: Page, text: string): Promise<void> {
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
  }, text);
}

/** Every clipboard action starts from the same known clipboard. */
async function armClipboard(page: Page): Promise<void> {
  await writeClipboard(page, SENTINEL);
  await page.waitForTimeout(80);
}

async function notice(page: Page): Promise<string | null> {
  const locator = page.locator('[data-testid="terminal-notice"]');
  if ((await locator.count()) === 0) return null;
  return (await locator.first().textContent())?.trim() ?? null;
}

/** Records clipboard events and the selection each one carried. */
async function instrument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sink: Array<Record<string, unknown>> = [];
    (window as unknown as { __clipboardEvents: typeof sink }).__clipboardEvents = sink;
    for (const type of ["copy", "cut", "paste"] as const) {
      document.addEventListener(
        type,
        (event) => {
          const target = event.target as HTMLElement | null;
          sink.push({
            type,
            target: target ? `${target.tagName.toLowerCase()}.${String(target.className).slice(0, 32)}` : null,
            insideTerminal: target ? Boolean(target.closest(".xterm")) : false,
            selectionLength: (window.getSelection()?.toString() ?? "").length,
          });
        },
        true,
      );
    }
  });
}

async function clipboardEvents(page: Page): Promise<unknown[]> {
  return await page.evaluate(() => {
    const sink = (window as unknown as { __clipboardEvents?: unknown[] }).__clipboardEvents ?? [];
    const copy = [...sink];
    sink.length = 0;
    return copy;
  });
}

/** Everything about the current DOM selection that could explain a whole-panel copy. */
async function selectionState(page: Page) {
  return await page.evaluate(() => {
    const selection = window.getSelection();
    const mirror = document.querySelector('[data-testid="terminal-output"]');
    const highlights = Array.from(document.querySelectorAll(".xterm-selection div"));
    const active = document.activeElement as HTMLElement | null;
    return {
      domSelection: selection?.toString() ?? "",
      domSelectionLength: (selection?.toString() ?? "").length,
      mirrorInSelection: mirror ? Boolean(selection?.containsNode(mirror, true)) : null,
      mirrorLength: (mirror?.textContent ?? "").length,
      mirrorUserSelect: mirror ? getComputedStyle(mirror).userSelect : null,
      activeElement: active
        ? `${active.tagName.toLowerCase()}.${String(active.className).slice(0, 40)}`
        : null,
      activeInsideTerminal: active ? Boolean(active.closest(".xterm")) : false,
      highlightRects: highlights.length,
    };
  });
}

/**
 * Drag across `count` words of the printed line, starting at word index `from`.
 *
 * The geometry comes from the run the DOM renderer emitted for that line: one span whose
 * text is the line and whose width divided by its length is one character cell. The drag
 * ends inside the *last* character cell so the whole word is inside the selection.
 */
async function lineGeometry(page: Page): Promise<{
  left: number;
  top: number;
  height: number;
  charWidth: number;
  bottom: number;
} | null> {
  return await page.evaluate((line: string) => {
    for (const run of Array.from(document.querySelectorAll(".xterm-rows span"))) {
      const text = run.textContent ?? "";
      if (text !== line) continue;
      const box = run.getBoundingClientRect();
      if (box.width < 40 || box.height < 5) continue;
      return {
        left: box.left,
        top: box.top,
        height: box.height,
        bottom: box.bottom,
        charWidth: box.width / text.length,
      };
    }
    return null;
  }, LINE);
}

async function dragWords(page: Page, from: number, count: number): Promise<string | null> {
  const geometry = await lineGeometry(page);
  if (geometry === null) return null;
  const words = [...LINE.matchAll(/\S+/g)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const first = words[from];
  const last = words[from + count - 1];
  if (first === undefined || last === undefined) return null;
  const y = geometry.top + geometry.height / 2;
  const x1 = geometry.left + first.start * geometry.charWidth + geometry.charWidth / 2;
  const x2 = geometry.left + (last.end - 0.2) * geometry.charWidth;
  await page.mouse.move(x1, y);
  await page.mouse.down();
  await page.mouse.move(x2, y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  return [...LINE.matchAll(/\S+/g)]
    .slice(from, from + count)
    .map((match) => match[0])
    .join(" ");
}

/** One button press, measured: clipboard reset first, notice and clipboard read after. */
async function pressButton(page: Page, testId: string) {
  await armClipboard(page);
  await page.locator(`[data-testid="${testId}"]`).click();
  await page.waitForTimeout(300);
  return {
    notice: await notice(page),
    clipboard: await readClipboard(page),
    events: await clipboardEvents(page),
    selection: await selectionState(page),
  };
}

async function pressKeys(page: Page, keys: string) {
  await armClipboard(page);
  await page.keyboard.press(keys);
  await page.waitForTimeout(300);
  return {
    notice: await notice(page),
    clipboard: await readClipboard(page),
    events: await clipboardEvents(page),
    selection: await selectionState(page),
  };
}

async function tabCount(page: Page): Promise<number> {
  return await page.locator('[data-testid^="terminal-tab-"]:not([data-testid^="terminal-tab-close-"])').count();
}

async function main(): Promise<void> {
  const browser: Browser = await chromium.launch({
    executablePath: findChromium(),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    await page.locator('[data-testid="boot-button"]').click();
    await page
      .locator('[data-testid="env-status"]', { hasText: "Ready" })
      .first()
      .waitFor({ timeout: BOOT_TIMEOUT_MS });
    await page
      .locator('[data-testid="terminal-panel"][data-connection="connected"]')
      .waitFor({ timeout: 90_000 });
    await instrument(page);
    note("boot", "ready, shell connected");

    await page.locator('[data-testid="terminal-screen"]').first().click();
    await page.keyboard.type(`printf '${LINE}\\n'`, { delay: 8 });
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (line: string) =>
        (document.querySelector('[data-testid="terminal-output"]')?.textContent ?? "").split(line)
          .length > 1,
      LINE,
      { timeout: 60_000 },
    );
    note("transcriptLength", (await selectionState(page)).mirrorLength);

    // ---- 1. A mouse drag over three words -------------------------------------------
    const dragged = await dragWords(page, FROM, COUNT);
    const afterDrag = await selectionState(page);
    note("drag", { expected: dragged, afterDrag });
    record(
      "a drag over three words selects three words, not the transcript",
      afterDrag.domSelection.trim() === EXPECTED && afterDrag.mirrorInSelection === false,
      `DOM selection ${JSON.stringify(afterDrag.domSelection)} of ${String(afterDrag.mirrorLength)} mirrored characters`,
    );
    record(
      "the transcript mirror is unselectable, so no drag can pick the pane up",
      afterDrag.mirrorUserSelect === "none",
      `computed user-select on [data-testid="terminal-output"] = ${String(afterDrag.mirrorUserSelect)}`,
    );

    // ---- 2. The header's Copy button --------------------------------------------------
    const copy = await pressButton(page, "terminal-copy");
    note("copy", copy);
    record(
      "Copy puts exactly the dragged words on the clipboard",
      copy.clipboard.ok === true && copy.clipboard.head === EXPECTED && copy.clipboard.length === EXPECTED.length,
      `clipboard=${JSON.stringify(copy.clipboard)} expected ${String(EXPECTED.length)} chars ${JSON.stringify(EXPECTED)} notice=${JSON.stringify(copy.notice)}`,
    );
    record(
      "Copy does not copy the whole transcript",
      (copy.clipboard.length ?? 0) < afterDrag.mirrorLength,
      `clipboard ${String(copy.clipboard.length ?? -1)} chars vs mirrored transcript ${String(afterDrag.mirrorLength)} chars`,
    );

    // ---- 3. Does the click itself destroy the selection? -----------------------------
    const geometry = await lineGeometry(page);
    await dragWords(page, FROM, COUNT);
    const beforeClick = await selectionState(page);
    if (geometry !== null) {
      await page.mouse.move(geometry.left + 40, geometry.top + geometry.height / 2);
    }
    const copyBox = await page.locator('[data-testid="terminal-copy"]').boundingBox();
    if (copyBox !== null) {
      await page.mouse.move(copyBox.x + copyBox.width / 2, copyBox.y + copyBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(120);
    }
    const afterMouseDown = await selectionState(page);
    if (copyBox !== null) {
      await page.mouse.up();
      await page.waitForTimeout(200);
    }
    const afterClick = await selectionState(page);
    note("selectionAcrossClick", { beforeClick, afterMouseDown, afterClick });
    record(
      "the highlight survives a click on Copy",
      afterClick.highlightRects > 0,
      `highlight rectangles before=${String(beforeClick.highlightRects)} mousedown=${String(afterMouseDown.highlightRects)} after click=${String(afterClick.highlightRects)} (focus now ${String(afterClick.activeElement)})`,
    );

    // A second Copy with no new selection: the notice says what the component thinks.
    const secondCopy = await pressButton(page, "terminal-copy");
    note("copyWithoutSelection", secondCopy);
    record(
      "a second Copy still has the selection to copy",
      secondCopy.clipboard.head === EXPECTED,
      `clipboard=${JSON.stringify(secondCopy.clipboard)} notice=${JSON.stringify(secondCopy.notice)}`,
    );

    // ---- 4. Ctrl+C over a selection ---------------------------------------------------
    await dragWords(page, FROM, COUNT);
    const ctrlC = await pressKeys(page, "Control+C");
    note("ctrlC", ctrlC);
    record(
      "Ctrl+C copies the selection",
      ctrlC.clipboard.head === EXPECTED,
      `clipboard=${JSON.stringify(ctrlC.clipboard)} notice=${JSON.stringify(ctrlC.notice)} events=${JSON.stringify(ctrlC.events)}`,
    );
    record(
      "Ctrl+C is not silent: the document sees a copy event or the pane explains itself",
      (ctrlC.events as unknown[]).length > 0 || ctrlC.notice !== null,
      `events=${JSON.stringify(ctrlC.events)} notice=${JSON.stringify(ctrlC.notice)}`,
    );

    // ---- 5. Ctrl+X over a selection ---------------------------------------------------
    await dragWords(page, FROM, COUNT);
    const ctrlX = await pressKeys(page, "Control+X");
    note("ctrlX", ctrlX);
    record(
      "Ctrl+X copies the selection",
      ctrlX.clipboard.head === EXPECTED,
      `clipboard=${JSON.stringify(ctrlX.clipboard)} events=${JSON.stringify(ctrlX.events)}`,
    );

    // ---- 6. Cut button -----------------------------------------------------------------
    await dragWords(page, FROM, COUNT);
    const cut = await pressButton(page, "terminal-cut");
    note("cut", cut);
    record(
      "Cut copies the selection and clears only the highlight",
      cut.clipboard.head === EXPECTED && cut.selection.highlightRects === 0,
      `clipboard=${JSON.stringify(cut.clipboard)} highlights after=${String(cut.selection.highlightRects)} notice=${JSON.stringify(cut.notice)}`,
    );

    // ---- 7. A drag that leaves the terminal: does it swallow the mirror? --------------
    const screen = await page.locator('[data-testid="terminal-screen"]').first().boundingBox();
    const escape = await lineGeometry(page);
    if (screen !== null && escape !== null) {
      await page.mouse.move(escape.left + 20, escape.top + escape.height / 2);
      await page.mouse.down();
      await page.mouse.move(escape.left + 200, screen.y + screen.height + 60, { steps: 16 });
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    const afterEscape = await selectionState(page);
    const escapeCopy = await pressButton(page, "terminal-copy");
    note("dragOutOfTerminal", { selection: afterEscape, copy: escapeCopy });
    record(
      "a drag that leaves the terminal cannot put the transcript on the clipboard",
      (escapeCopy.clipboard.length ?? 0) < afterEscape.mirrorLength,
      `clipboard ${String(escapeCopy.clipboard.length ?? -1)} chars vs mirrored transcript ${String(afterEscape.mirrorLength)}; mirror in DOM selection: ${String(afterEscape.mirrorInSelection)}; notice=${JSON.stringify(escapeCopy.notice)}`,
    );

    // ---- 8. Paste, with two shells open: which tab receives it? ----------------------
    await page.locator('[data-testid="terminal-new-shell"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[data-tab-id]').length >= 2, null, {
      timeout: 60_000,
    });
    await page.waitForTimeout(1_000);
    note("tabs", await tabCount(page));
    // Give the second shell a marker of its own, then go back to the first tab.
    await page.locator('[data-tab-id]').nth(1).locator('[data-testid="terminal-screen"]').click();
    await page.keyboard.type("printf 'second-shell\\n'", { delay: 8 });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_500);
    await page.locator('[data-testid^="terminal-tab-"]:not([data-testid^="terminal-tab-close-"])').first().click();
    await page.waitForTimeout(300);
    const paste = await pressButton(page, "terminal-paste");
    const tabTexts = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-tab-id]")).map((panel) => {
        const text = panel.querySelector('[data-testid="terminal-output"]')?.textContent ?? "";
        return {
          tabId: panel.getAttribute("data-tab-id"),
          hasSentinel: text.includes("SENTINEL-BEFORE-ACTION"),
        };
      }),
    );
    note("paste", { ...paste, tabs: tabTexts });
    record(
      "Paste goes to the active shell only",
      tabTexts.filter((tab) => tab.hasSentinel).length === 1 &&
        tabTexts[0]?.hasSentinel === true,
      `notice=${JSON.stringify(paste.notice)} tabs=${JSON.stringify(tabTexts)}`,
    );

    // ---- 9. Clear does not touch the clipboard --------------------------------------
    await armClipboard(page);
    const beforeClear = await readClipboard(page);
    await page.locator('[data-testid="terminal-clear"]').click();
    await page.waitForTimeout(250);
    const afterClear = await readClipboard(page);
    const clearNotice = await notice(page);
    note("clear", { beforeClear, afterClear, clearNotice });
    record(
      "Clear empties the pane and leaves the clipboard alone",
      afterClear.head === beforeClear.head,
      `before=${JSON.stringify(beforeClear)} after=${JSON.stringify(afterClear)} notice=${JSON.stringify(clearNotice)}`,
    );

    await page.screenshot({ path: shotPath, fullPage: false });
  } finally {
    await browser.close().catch(() => undefined);
  }

  const failed = checks.filter((check) => !check.ok);
  const body = [
    "# Terminal clipboard: what the actions actually do",
    "",
    `Run: ${new Date().toISOString()} against ${baseUrl} (Chromium, headless, clipboard permission granted).`,
    `Verdict: ${failed.length === 0 ? "**PASS**" : `**FAILED** (${String(failed.length)} checks)`}`,
    "",
    "## Checks",
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...checks.map(
      (check) =>
        `| ${check.name} | ${check.ok ? "pass" : "**fail**"} | ${check.detail.replaceAll("|", "\\|")} |`,
    ),
    "",
    "## Raw measurements",
    "",
    "```json",
    JSON.stringify(measurements, null, 2),
    "```",
    "",
    "Evidence: `docs/evidence/terminal-clipboard.png`, `docs/evidence/terminal-clipboard.txt`.",
    "",
  ].join("\n");

  writeFileSync(reportPath, body, "utf8");
  writeFileSync(transcriptPath, log.join("\n") + "\n", "utf8");
  console.log(log.join("\n"));
  console.log(`\n[probe] ${failed.length === 0 ? "PASS" : "FAIL"} — ${reportPath}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
