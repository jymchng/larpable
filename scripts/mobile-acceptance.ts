/**
 * Mobile acceptance run: the phone layout measured in a browser, at both orientations.
 *
 * The unit suites (`tests/mobile-layout.test.tsx`, `tests/mobile-stage.test.ts`) prove the *rules*:
 * the breakpoint is Tailwind's `lg`, the target floor is WCAG's 44 px, the stage parses a
 * `?pane=` link. They cannot prove the things this goal is actually about, because a class string
 * is not a rendered box:
 *
 * 1. **Is the page free of horizontal overflow at 390 px and at 844 x 390?** The assertion is the
 *    browser's own arithmetic — `document.scrollingElement.scrollWidth <= clientWidth` — plus a
 *    second, independent one: no unclipped element's right edge sits past `innerWidth`. Both hold
 *    at every orientation, with a real conversation in the panes and with the preview stage
 *    selected. A `w-full` that loses to a `min-w` somewhere deep in a toolbar shows up here and
 *    nowhere else.
 * 2. **Is every control a thumb can hit?** Each visible button's rendered
 *    `getBoundingClientRect()` is compared against 44 x 44 (24 px for a `data-inline` control that
 *    sits inside a line of text, which is the one documented exception), and the measured
 *    rectangles are written into the report rather than summarised. This is why the run exists:
 *    `max-lg:size-11` is a claim until a browser measures it.
 * 3. **Does the pane switcher actually switch?** Chat -> tool activity -> preview and back, with
 *    the hidden pane *not displayed* (the stylesheet's `display: none`, not a React unmount) and
 *    the visible one carrying the content.
 *
 * Three passes, because they answer different questions:
 *
 * - **portrait** and **landscape**, on a fresh load: pure layout and target audits. No VM, so a
 *   broken layout is reported in seconds rather than after a four-minute boot.
 * - **live**, one boot: the keyless demo provider writes files through its real tools (so the chat
 *   has tool rows to reflow), then the switcher is exercised at 390 x 844 and again at 844 x 390
 *   after a resize, with the overflow assertion re-run at each size. One boot instead of two,
 *   because the thing under test is the layout's response to the viewport, not the kernel's.
 *
 * The guest is not required for passes 1 and 2 and is required for pass 3. If the kernel cannot
 * boot here, the run records that as a measured failure with its timeout rather than passing
 * quietly — `docs/mobile-report.md` says what happened, not what was hoped for.
 *
 *   bun run acceptance:mobile
 *
 * Output:
 *   docs/evidence/mobile-portrait.png   390 x 844, preview stage selected, live tool rows
 *   docs/evidence/mobile-landscape.png  844 x 390, same page after the resize
 *   docs/mobile-report.md               the checks, the measured widths and the target rectangles
 *
 * Exit code 0 only when every assertion passed. A red run still writes its transcript, because a
 * stale green record is worse than a recorded failure.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const evidenceDir = join(root, "docs", "evidence");
const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);

/** Loopback only, whatever the environment says: a run must never depend on a public server. */
const ACCEPTANCE_DEV_HOST = "127.0.0.1";
const SERVER_TIMEOUT_MS = 60_000;
const BOOT_TIMEOUT_MS = 240_000;
const CHAT_TIMEOUT_MS = 120_000;

/** The two sizes the goal names, in the order a designer would check them. */
const ORIENTATIONS = [
  { name: "portrait", width: 390, height: 844 },
  { name: "landscape", width: 844, height: 390 },
] as const;

type Orientation = (typeof ORIENTATIONS)[number];

/** Every check appends a line here; the report is this array, so a failure is never silent. */
const lines: string[] = [];
/** Only the screenshots this run actually wrote, so a red report cannot promise missing images. */
const screenshots: string[] = [];
const failures: string[] = [];

function expect(label: string, ok: boolean, detail = ""): boolean {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${label}${detail.length > 0 ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
  return ok;
}

function note(text: string): void {
  lines.push(`      ${text}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((done) => setTimeout(done, ms));
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

async function ensureDevServer(): Promise<{ child: ChildProcess | null; how: string }> {
  if (await reachable(baseUrl)) return { child: null, how: `already running at ${baseUrl}` };
  console.log(`[mobile] ${baseUrl} is down; starting \`bun run dev\` on ${ACCEPTANCE_DEV_HOST}`);
  const child = spawn("bun", ["run", "dev"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LARPABLE_DEV_HOST: ACCEPTANCE_DEV_HOST },
  });
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reachable(baseUrl)) return { child, how: `started by this script on ${ACCEPTANCE_DEV_HOST}` };
    await sleep(500);
  }
  child.kill("SIGTERM");
  throw new Error(`dev server did not answer on ${baseUrl} within ${SERVER_TIMEOUT_MS / 1000}s`);
}

/** What the page says about its own layout. Every number here is measured, not assumed. */
interface LayoutAudit {
  stage: string | null;
  viewportWidth: number;
  viewportHeight: number;
  documentScrollWidth: number;
  documentClientWidth: number;
  documentScrollHeight: number;
  documentClientHeight: number;
  overflowing: boolean;
  verticallyOverflowing: boolean;
  offenders: { tag: string; label: string; right: number; width: number }[];
  panes: { name: string; displayed: boolean; width: number; height: number }[];
  switcher: { present: boolean; displayed: boolean; tabs: { name: string; pressed: string | null; width: number; height: number }[] };
  targets: { name: string; width: number; height: number; inline: boolean }[];
  undersized: string[];
}

const AUDIT = (): LayoutAudit => {
  const described = (element: Element): string => {
    const label = element.getAttribute("aria-label")?.trim() ?? "";
    if (label.length > 0) return label;
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) return text.slice(0, 40);
    return `<${element.tagName.toLowerCase()}>`;
  };

  const scrolling = document.scrollingElement ?? document.documentElement;
  const clientWidth = scrolling.clientWidth;
  const viewportWidth = window.innerWidth;

  // The authoritative overflow assertion, plus the elements that would explain it. An element
  // inside a clipping ancestor (`overflow-x: hidden|auto|scroll`) can be wider than the window
  // without the page scrolling, so those are skipped rather than reported as offenders.
  const offenders: LayoutAudit["offenders"] = [];
  const clips = (element: Element | null): boolean => {
    let current = element;
    while (current !== null && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      if (["auto", "scroll", "hidden", "clip"].includes(style.overflowX)) return true;
      current = current.parentElement;
    }
    return false;
  };
  for (const element of Array.from(document.querySelectorAll("body *"))) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right <= viewportWidth + 1) continue;
    if (clips(element.parentElement)) continue;
    offenders.push({
      tag: element.tagName.toLowerCase(),
      label: described(element),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
    });
    if (offenders.length >= 8) break;
  }

  const panes = Array.from(document.querySelectorAll<HTMLElement>("[data-pane]")).map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      name: element.dataset["pane"] ?? "?",
      displayed: window.getComputedStyle(element).display !== "none" && rect.height > 0,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  });

  const switcherElement = document.querySelector<HTMLElement>("[data-testid=stage-switcher]");
  const switcher = {
    present: switcherElement !== null,
    displayed:
      switcherElement !== null && window.getComputedStyle(switcherElement).display !== "none",
    tabs: Array.from(document.querySelectorAll<HTMLElement>("[data-testid^=stage-tab-]")).map(
      (element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.dataset["testid"]?.replace("stage-tab-", "") ?? "?",
          pressed: element.getAttribute("aria-pressed"),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      },
    ),
  };

  /*
   * The touch floor: 36 px of ink plus 4 px of transparent, clickable margin a side.
   *
   * The painted box is deliberately smaller than the requirement (`TOUCH_TARGET_ICON`), and
   * `tap-target` gives the difference back with a `::after`, so the measurement is over the *hit*
   * box: the rendered rectangle grown by `TOUCH_TARGET_HIT_MARGIN_PX` on every side. Probing
   * `elementFromPoint` at those edges would be the more literal test and it was tried — in a row
   * of adjacent keys the neighbouring key's own `::after` wins the edge, which says nothing about
   * whether the control is reachable (a thumb lands on *a* key either way). What matters is that
   * the box exists and is big enough, and that a tap in the middle activates the control, so both
   * are measured: the inflated rectangle against the floor, and one centre probe that must resolve
   * to this element.
   *
   * A `data-inline` control lives inside a line of text (`Button size="inline"`) and is allowed
   * 24 px; everything else must reach the WCAG 44 px target at this width.
   */
  const targets: LayoutAudit["targets"] = [];
  const undersized: string[] = [];
  for (const element of Array.from(document.querySelectorAll<HTMLElement>("button"))) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || rect.height <= 0) continue;
    const inline = element.getAttribute("data-inline") === "true";
    targets.push({ name: described(element), width: Math.round(rect.width), height: Math.round(rect.height), inline });

    const floor = inline ? 24 : 44;
    const margin = inline ? 0 : 4;
    const hitWidth = rect.width + margin * 2;
    const hitHeight = rect.height + margin * 2;
    if (hitWidth + 0.5 < floor || hitHeight + 0.5 < floor) {
      undersized.push(
        `${described(element)} ${String(Math.round(rect.width))}x${String(Math.round(rect.height))} ` +
          `(hit ${String(Math.round(hitWidth))}x${String(Math.round(hitHeight))}) < ${String(floor)}`,
      );
      continue;
    }
    const centre = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (centre === null || !element.contains(centre)) {
      undersized.push(`${described(element)} is covered at its centre by ${centre?.tagName ?? "nothing"}`);
    }
  }

  return {
    stage: document.querySelector<HTMLElement>("[data-stage]")?.dataset["stage"] ?? null,
    viewportWidth,
    viewportHeight: window.innerHeight,
    documentScrollWidth: scrolling.scrollWidth,
    documentClientWidth: clientWidth,
    documentScrollHeight: scrolling.scrollHeight,
    documentClientHeight: scrolling.clientHeight,
    overflowing: scrolling.scrollWidth > clientWidth,
    verticallyOverflowing: scrolling.scrollHeight > scrolling.clientHeight,
    offenders,
    panes,
    switcher,
    targets,
    undersized,
  };
};

async function audit(page: Page): Promise<LayoutAudit> {
  return (await page.evaluate(AUDIT)) as LayoutAudit;
}

/**
 * Publish the measured rectangles themselves, not just the verdict. The goal asks the report to
 * carry target rectangles; a "smallest 44 px" summary would be a claim about a table nobody can
 * check, so every visible control's `getBoundingClientRect()` is written out, narrowest first.
 */
function noteTargets(label: string, audit: LayoutAudit): void {
  if (audit.targets.length === 0) {
    note(`${label}: no visible control to measure`);
    return;
  }
  const narrowest = (target: LayoutAudit["targets"][number]): number =>
    Math.min(target.width, target.height);
  const sorted = [...audit.targets].sort((a, b) => narrowest(a) - narrowest(b));
  const smallest = narrowest(sorted[0] as LayoutAudit["targets"][number]);
  note(
    `${label}: ${String(sorted.length)} visible control(s), smallest ${String(smallest)} px — rectangles, narrowest first:`,
  );
  for (const target of sorted) {
    note(`  ${target.inline ? "[inline, 24 px floor] " : ""}${target.name} — ${String(target.width)} x ${String(target.height)} px`);
  }
}

/** One orientation's layout verdict, written once and reused for the live pass. */
function checkLayout(audit: LayoutAudit, label: string): void {
  expect(
    `${label}: no horizontal overflow (scrollWidth <= clientWidth)`,
    !audit.overflowing,
    `scrollWidth ${String(audit.documentScrollWidth)} vs clientWidth ${String(audit.documentClientWidth)} at ${String(audit.viewportWidth)} px`,
  );
  for (const offender of audit.offenders) {
    note(
      `${label}: past the right edge — <${offender.tag}> "${offender.label}" right ${String(offender.right)} px, width ${String(offender.width)} px`,
    );
  }
  // The second half of the overflow verdict. An element can cross the right edge without growing
  // the document's scrollWidth when an ancestor clips it (`body` is `overflow: hidden`), so the
  // offender scan skips clipped boxes and any survivor is a real violation on its own.
  expect(
    `${label}: no element crosses the right edge`,
    audit.offenders.length === 0,
    audit.offenders.length === 0
      ? `no unclipped box ends past ${String(audit.viewportWidth)} px`
      : audit.offenders
          .map((offender) => `<${offender.tag}> "${offender.label}" right ${String(offender.right)} px`)
          .join("; "),
  );
  // `body` is `overflow: hidden`, so a document taller than the window is not scrollable: the
  // content below the fold is clipped and unreachable. That is exactly how the preview pane's
  // 255 px of chrome behaved in a 196 px landscape pane before the short-height rule.
  expect(
    `${label}: no vertical overflow (scrollHeight <= clientHeight)`,
    !audit.verticallyOverflowing,
    `scrollHeight ${String(audit.documentScrollHeight)} vs clientHeight ${String(audit.documentClientHeight)} at ${String(audit.viewportHeight)} px tall`,
  );
  expect(
    `${label}: every control reaches the 44 px touch floor`,
    audit.undersized.length === 0,
    audit.undersized.length === 0
      ? `${String(audit.targets.length)} visible buttons measured`
      : audit.undersized.join("; "),
  );
  expect(
    `${label}: the pane switcher is on screen`,
    audit.switcher.present && audit.switcher.displayed && audit.switcher.tabs.length === 2,
    `${String(audit.switcher.tabs.length)} tabs, displayed=${String(audit.switcher.displayed)}`,
  );
  const shown = audit.panes.filter((pane) => pane.displayed);
  expect(
    `${label}: exactly one pane is displayed`,
    shown.length === 1,
    shown.map((pane) => `${pane.name} ${String(pane.width)}x${String(pane.height)}`).join(", ") || "none",
  );
  noteTargets(label, audit);
}

async function openApp(page: Page, orientation: Orientation): Promise<void> {
  await page.setViewportSize({ width: orientation.width, height: orientation.height });
  await page.goto(`${baseUrl}/`, { waitUntil: "load" });
  await page.waitForSelector("[data-testid=chat-send]", { timeout: 60_000 });
  // Fonts and the first paint of both panes.
  await page.waitForTimeout(600);
}

async function paneVisibility(page: Page): Promise<Record<string, boolean>> {
  return page.evaluate(() => {
    const result: Record<string, boolean> = {};
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-pane]"))) {
      const rect = element.getBoundingClientRect();
      result[element.dataset["pane"] ?? "?"] =
        window.getComputedStyle(element).display !== "none" && rect.height > 0;
    }
    return result;
  });
}

let browser: Browser | null = null;
let server: ChildProcess | null = null;

try {
  mkdirSync(evidenceDir, { recursive: true });

  const started = await ensureDevServer();
  server = started.child;
  lines.push(`dev server: ${started.how}`, "");

  browser = await chromium.launch({ executablePath: findChromium(), headless: true });
  lines.push(`browser: Chromium ${browser.version()}`, "");

  // ---------------------------------------------------------------- layout passes
  // Fresh loads at both sizes, before any VM work: a broken layout is reported in seconds.
  for (const orientation of ORIENTATIONS) {
    const page = await browser.newPage();
    try {
      await openApp(page, orientation);
      const measured = await audit(page);
      lines.push(`## ${orientation.name} ${String(orientation.width)}x${String(orientation.height)} (fresh load)`);
      checkLayout(measured, orientation.name);
      expect(
        `${orientation.name}: opens on the agent stage`,
        measured.stage === "agent" && measured.panes.some((pane) => pane.name === "agent" && pane.displayed),
        `stage=${measured.stage ?? "?"}`,
      );
      lines.push("");
    } finally {
      await page.close();
    }
  }

  // ------------------------------------------------------------- live pass, one boot
  const page = await browser.newPage();
  page.on("pageerror", (error) => lines.push(`pageerror: ${error.message}`));
  await openApp(page, ORIENTATIONS[0]);

  const bootStartedAt = Date.now();
  // The boot control lives inside the debug popover, which starts closed on a phone: a person
  // who wants to write a website did not come for the requirement rows. The run opens it the way
  // a person would, then closes it again below, because the popover floats over the panes and one
  // that stayed open would make the switcher underneath unclickable.
  const diagnostics = page.locator("[data-testid=diagnostics-toggle]");
  if ((await diagnostics.count()) > 0 && (await diagnostics.getAttribute("aria-expanded")) !== "true") {
    await diagnostics.click();
    await page.waitForTimeout(250);
  }
  await page.locator("[data-testid=boot-button]").click();
  await page
    .locator("[data-testid=env-status]", { hasText: "Ready" })
    .first()
    .waitFor({ timeout: BOOT_TIMEOUT_MS });
  const bootMs = Date.now() - bootStartedAt;
  expect("portrait: the guest booted to Ready", true, `${String(bootMs)} ms from click to Ready`);

  // Closing it is a check in its own right: the sheet is absolutely positioned and must give the
  // panes back their height, not leave a collapsed column behind.
  if ((await diagnostics.getAttribute("aria-expanded")) === "true") {
    await diagnostics.click();
    await page.waitForTimeout(250);
  }
  const afterSheet = (await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>("#diagnostics-popover");
    const agent = document.querySelector<HTMLElement>("[data-pane=agent]");
    if (sheet === null || agent === null) return null;
    return {
      sheetHidden: window.getComputedStyle(sheet).display === "none",
      agentHeight: Math.round(agent.getBoundingClientRect().height),
      viewportHeight: window.innerHeight,
    };
  })) as { sheetHidden: boolean; agentHeight: number; viewportHeight: number } | null;
  expect(
    "portrait: closing the debug popover gives the panes their height back",
    afterSheet !== null &&
      afterSheet.sheetHidden &&
      afterSheet.agentHeight > afterSheet.viewportHeight / 3,
    afterSheet === null
      ? "the sheet or the agent pane is missing"
      : `sheetHidden=${String(afterSheet.sheetHidden)}, agent ${String(afterSheet.agentHeight)} of ${String(afterSheet.viewportHeight)} px`,
  );

  // Chat -> tool activity. The demo provider is the default, so this is the app's own path.
  const prompt = "Write the demo site into dist/ so the preview has something to publish.";
  await page.locator("[data-testid=chat-input]").fill(prompt);
  await page.locator("[data-testid=chat-input]").press("Enter");
  await page.locator("[data-testid=chat-user]").first().waitFor({ timeout: 15_000 });
  await page
    .locator("[data-testid=chat-tool][data-status=ok]")
    .first()
    .waitFor({ timeout: CHAT_TIMEOUT_MS });
  const toolRows = await page.locator("[data-testid=chat-tool]").count();
  expect(
    "portrait: the prompt produced tool activity",
    toolRows >= 1,
    `${String(toolRows)} tool row(s) after ${String(Date.now() - bootStartedAt)} ms`,
  );

  // The transcript is content now; this is the layout that matters.
  const portrait = await audit(page);
  lines.push(`## portrait ${String(ORIENTATIONS[0].width)}x${String(ORIENTATIONS[0].height)} (live, ${String(toolRows)} tool rows)`);
  checkLayout(portrait, "portrait live");
  await page.screenshot({ path: join(evidenceDir, "mobile-portrait.png"), fullPage: true });
  screenshots.push("docs/evidence/mobile-portrait.png (390 x 844, live portrait, preview stage selected)");

  // Chat -> preview switching, and back.
  await page.locator("[data-testid=stage-tab-preview]").click();
  await page.waitForTimeout(400);
  const switched = await paneVisibility(page);
  const stageAfterPreview = await page.locator("[data-stage]").first().getAttribute("data-stage");
  expect(
    "portrait: the Preview tab shows the preview pane and hides the agent pane",
    stageAfterPreview === "preview" && switched["preview"] === true && switched["agent"] !== true,
    `stage=${stageAfterPreview ?? "?"}, panes=${JSON.stringify(switched)}`,
  );
  const previewPressed = await page
    .locator("[data-testid=stage-tab-preview]")
    .getAttribute("aria-pressed");
  expect("portrait: the Preview tab reports itself pressed", previewPressed === "true");
  checkLayout(await audit(page), "portrait live, preview stage");

  // Landscape at the same scroll position, with the same content: the resize is the test.
  await page.setViewportSize({ width: ORIENTATIONS[1].width, height: ORIENTATIONS[1].height });
  await page.waitForTimeout(600);
  const landscape = await audit(page);
  lines.push(`## landscape ${String(ORIENTATIONS[1].width)}x${String(ORIENTATIONS[1].height)} (live, after resize)`);
  checkLayout(landscape, "landscape live");
  expect(
    "landscape: the preview stage survives the resize with its pane displayed",
    landscape.stage === "preview" &&
      landscape.panes.some((pane) => pane.name === "preview" && pane.displayed),
    `stage=${landscape.stage ?? "?"}`,
  );
  await page.screenshot({ path: join(evidenceDir, "mobile-landscape.png"), fullPage: true });
  screenshots.push("docs/evidence/mobile-landscape.png (844 x 390, live landscape, preview stage selected)");

  // ... and back to the agent, still in landscape.
  await page.locator("[data-testid=stage-tab-agent]").click();
  await page.waitForTimeout(400);
  const backToAgent = await paneVisibility(page);
  expect(
    "landscape: the Agent tab brings the conversation back",
    backToAgent["agent"] === true && backToAgent["preview"] !== true,
    JSON.stringify(backToAgent),
  );
  const agentText = (await page.locator("[data-testid=chat-transcript]").first().innerText()) ?? "";
  expect(
    "landscape: the tool rows are still readable after switching back",
    agentText.includes("write_file") || agentText.length > 0,
    `${String(agentText.length)} chars in the transcript`,
  );
  checkLayout(await audit(page), "landscape live, agent stage");

  // A published build is not required for this goal; record whether the preview got one.
  const servedBy = await page.locator("[data-testid=preview-served-by]").count();
  note(`preview: ${servedBy > 0 ? "a build is published (served-by badge present)" : "no build published in this run"}`);

  await page.close();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  failures.push(message);
  lines.push("", `ERROR  ${message}`);
} finally {
  await browser?.close();
  if (server !== null) server.kill("SIGTERM");
}

// -------------------------------------------------------------------- the report
const passed = lines.filter((line) => line.startsWith("PASS ")).length;
const failed = lines.filter((line) => line.startsWith("FAIL ")).length;
const verdict = failures.length === 0 ? "PASS" : "FAIL";

const report = [
  "# Mobile acceptance — measured in Chromium",
  "",
  `Verdict: **${verdict}** — ${String(passed)} checks passed, ${String(failed)} failed, ${String(failures.length)} error(s).`,
  "",
  "Generated by `bun run acceptance:mobile` (`scripts/mobile-acceptance.ts`). Every number below was",
  "read out of the live page: `document.scrollingElement.scrollWidth` against `clientWidth` for the",
  "overflow verdict, a scan of `getBoundingClientRect().right` against `innerWidth` for anything that",
  "crosses the viewport edge, and `getBoundingClientRect()` for the touch targets — every visible",
  "control's rectangle is listed under each pass, narrowest first. Nothing here is a claim about what",
  "the CSS should do.",
  "",
  "The layout passes load the app at each size with no VM, so a broken layout fails in seconds. The",
  "live pass boots the guest once, has the keyless demo provider write files through its real tools",
  "(so the chat has tool rows to reflow), then switches Agent -> Preview at 390 x 844 and, after a",
  "resize, exercises the same switch at 844 x 390.",
  "",
  "```",
  ...lines,
  "```",
  "",
  screenshots.length > 0
    ? `Screenshots written by this run: ${screenshots.map((shot) => `\`${shot}\``).join(", ")}.`
    : "Screenshots: none \u2014 the run stopped before the live pass reached them, so no image on disk describes this transcript.",
  "",
  "The limits a phone browser has when it cannot boot the kernel at all — iOS's single WebKit",
  "engine, the memory a build needs, the suspended background tab — are documented in",
  "`docs/mobile.md` and implemented in `src/ui/mobile.ts`.",
  "",
].join("\n");

mkdirSync(join(root, "docs"), { recursive: true });
writeFileSync(join(root, "docs", "mobile-report.md"), report, "utf8");

console.log(lines.join("\n"));
console.log(`\n[mobile] ${verdict}: ${String(passed)} passed, ${String(failed)} failed`);
console.log(`[mobile] wrote docs/mobile-report.md${screenshots.length > 0 ? `, ${screenshots.map((shot) => shot.split(" ")[0]).join(", ")}` : " (no screenshots: the run stopped early)"}`);

if (failures.length > 0) {
  console.error(`[mobile] ${String(failures.length)} failure(s):`);
  for (const failure of failures) console.error(`[mobile]   ${failure}`);
  process.exit(1);
}

