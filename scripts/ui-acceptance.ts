/**
 * Browser acceptance run for §13: does the app's own UI drive a real build, and does the
 * window stay responsive while it does?
 *
 * Every other §13 test stops at the component boundary: `tests/chat-panel.test.tsx` renders a
 * transcript from props, `tests/build-controller.test.ts` folds build events into statuses,
 * `tests/app.test.tsx` asserts the dashboard's slots. None of them can answer the two
 * questions this goal's acceptance actually asks:
 *
 * 1. **Does prompt -> tool activity -> build -> preview work in a page?** The chat must reach
 *    the agent's real tool loop, the tool rows must be readable, the build strip must run the
 *    guest's install and build (and a cancel must not be reported as a failure), and the
 *    preview must render the built site — the starter's clock ticking and its counter counting,
 *    which is the only way to see that the build's own JavaScript ran.
 * 2. **Is the main thread free while that build runs?** A build takes minutes inside the VM and
 *    streams output while it does. If any of that ran on the page's thread, the window would
 *    freeze. This run samples `requestAnimationFrame` gaps and `longtask` entries for the whole
 *    build and fails if a single frame gap exceeds 250 ms — and fails too if the sampler never
 *    ran, because "no gaps recorded" is not evidence of responsiveness.
 *
 * Nothing here is a test-only shortcut: the prompt is typed into the real prompt box, the
 * provider is the keyless demo one (so the conversation is deterministic), the build is the
 * app's own `Install & build` control reaching `BuildManager` in the guest, and the preview is
 * the app's own publish path. Every value below is read out of the live page.
 *
 *   bun run acceptance:ui
 *
 * Output:
 *   docs/evidence/ui-acceptance.txt   the checks, timings, samples and chat transcript
 *   docs/evidence/ui-acceptance.png   the window after the run
 *   docs/evidence/preview-browser-desktop.png   the browser-styled pane, desktop preset
 *   docs/evidence/preview-browser-mobile.png    the same pane at 390 × 844
 *
 * Exit code 0 only when every assertion passed. A red run still writes the transcript, because
 * a stale green record is worse than a recorded failure.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const evidenceDir = join(root, "docs", "evidence");
const transcriptPath = join(evidenceDir, "ui-acceptance.txt");
const screenshotPath = join(evidenceDir, "ui-acceptance.png");

const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);

const BOOT_TIMEOUT_MS = 240_000;
const CHAT_TIMEOUT_MS = 180_000;
/** The warm runtime plus a cold `npm install` through the guest's Wisp proxy, with slack. */
const BUILD_TIMEOUT_MS = 900_000;
const PUBLISH_TIMEOUT_MS = 300_000;
const SERVER_TIMEOUT_MS = 60_000;
/** The ceiling this run holds itself to: no frame may stall longer than this while building. */
const FRAME_GAP_LIMIT_MS = 250;

const ACCEPTANCE_DEV_HOST = "127.0.0.1";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];
const lines: string[] = [];

class AcceptanceFailure extends Error {}

function expect(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
  if (!ok) throw new AcceptanceFailure(`${name} — ${detail}`);
}

function note(step: string, value: string): void {
  lines.push(`${step}: ${value}`);
  console.log(`[ui] ${step}: ${value}`);
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
async function ensureDevServer(): Promise<{ child: ChildProcess | null; how: string }> {
  if (await reachable(baseUrl)) return { child: null, how: `already running at ${baseUrl}` };
  console.log(`[ui] ${baseUrl} is down; starting \`bun run dev\` on ${ACCEPTANCE_DEV_HOST}`);
  const child = spawn("bun", ["run", "dev"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, LARPABLE_DEV_HOST: ACCEPTANCE_DEV_HOST },
  });
  const deadline = Date.now() + SERVER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await reachable(baseUrl)) return { child, how: "started by this script" };
    await sleep(500);
  }
  child.kill("SIGTERM");
  throw new Error(`dev server did not answer on ${baseUrl} within ${SERVER_TIMEOUT_MS / 1000}s`);
}

async function text(page: Page, selector: string): Promise<string | null> {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  const value = (await locator.textContent())?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * How opaque the preset's tooltip bubble is right now, as the browser paints it.
 *
 * The device toolbar's dimensions live in a `role="tooltip"` bubble (`components/tooltip.tsx`)
 * that is always in the DOM and revealed by CSS, so "is it shown?" is a question about computed
 * opacity rather than about a node existing. Reading the number here is the only way to prove
 * the row is quiet until the user asks — the markup looks identical either way.
 */
async function bubbleOpacity(page: Page, name: string): Promise<number> {
  const bubble = page.locator(`[data-testid=preview-viewport-hint-${name}]`).first();
  if ((await bubble.count()) === 0) return -1;
  return Number(
    await bubble.evaluate((node) => window.getComputedStyle(node).opacity),
  );
}

/** Hover a preset button and wait for its bubble to finish fading in (150 ms transition). */
async function hoverPreset(page: Page, name: string): Promise<number> {
  const selector = `[data-testid=preview-viewport-${name}]`;
  await page.locator(selector).hover();
  await page
    .waitForFunction(
      (sel) => {
        const node = document.querySelector(sel);
        return node !== null && Number(getComputedStyle(node).opacity) > 0.9;
      },
      `[data-testid=preview-viewport-hint-${name}]`,
      { timeout: 4_000 },
    )
    .catch(() => undefined);
  return bubbleOpacity(page, name);
}

interface PerfSample {
  frames: number;
  maxGapMs: number;
  over250Ms: number;
  longTasks: number;
  longestTaskMs: number;
}

interface PerfWindow {
  reset(): Promise<void>;
  read(): Promise<PerfSample>;
}

/**
 * The sampler, installed before any app code runs.
 *
 * `requestAnimationFrame` is the honest probe for "is this window frozen": the browser calls it
 * once per frame, so a gap is time the user spent looking at a still image. `longtask` entries
 * catch the same thing from the other side (a task over 50 ms). Both are read out of the page
 * afterwards rather than inferred from Node's event loop, which would measure the wrong thread.
 */
function perfWindow(page: Page): PerfWindow {
  return {
    async reset() {
      await page.evaluate(() => {
        const w = window as unknown as { __larpablePerf?: { reset(): void } };
        w.__larpablePerf?.reset();
      });
    },
    async read() {
      return await page.evaluate(() => {
        const w = window as unknown as {
          __larpablePerf?: { read(): { gaps: number[]; longTasks: number[] } };
        };
        const raw = w.__larpablePerf?.read() ?? { gaps: [], longTasks: [] };
        const gaps = raw.gaps.filter((gap) => Number.isFinite(gap));
        return {
          frames: gaps.length,
          maxGapMs: gaps.length === 0 ? 0 : Math.round(Math.max(...gaps)),
          over250Ms: gaps.filter((gap) => gap > 250).length,
          longTasks: raw.longTasks.length,
          longestTaskMs:
            raw.longTasks.length === 0 ? 0 : Math.round(Math.max(...raw.longTasks)),
        };
      });
    },
  };
}

function summarise(sample: PerfSample): string {
  return `${String(sample.frames)} frames, max gap ${String(sample.maxGapMs)} ms, ${String(
    sample.over250Ms,
  )} gaps over 250 ms, ${String(sample.longTasks)} long tasks (longest ${String(
    sample.longestTaskMs,
  )} ms)`;
}

const INIT_SAMPLER = () => {
  const gaps: number[] = [];
  const longTasks: number[] = [];
  let last = performance.now();
  const tick = (now: number): void => {
    gaps.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    }).observe({ entryTypes: ["longtask"] });
  } catch {
    // A browser without `longtask`: the frame gaps still answer the question.
  }
  (window as unknown as { __larpablePerf: unknown }).__larpablePerf = {
    reset() {
      gaps.length = 0;
      longTasks.length = 0;
      last = performance.now();
    },
    read() {
      return { gaps: [...gaps], longTasks: [...longTasks] };
    },
  };
};

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });

  lines.push(
    "§13 UI acceptance run — prompt -> tool activity -> build -> preview, with frame-gap sampling",
    `started: ${new Date().toISOString()}`,
    `page: ${baseUrl}`,
    "",
  );

  const { child, how } = await ensureDevServer();
  lines.push(`dev server: ${how}`, "");

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      executablePath: findChromium(),
      headless: true,
      // A headless page can be treated as hidden, which throttles rAF and would make the
      // responsiveness sample meaningless in the safe direction (it would hide a stall).
      args: [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
      ],
    });
    lines.push(`browser: Chromium ${browser.version()}`, "");

    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    page.on("console", (message) => {
      if (message.type() === "error") lines.push(`console.error: ${message.text()}`);
    });
    page.on("pageerror", (error) => lines.push(`pageerror: ${error.message}`));
    await page.addInitScript(INIT_SAMPLER);
    await page.goto(`${baseUrl}/`, { waitUntil: "load" });
    await page.bringToFront();

    // ------------------------------------------------------------ the §13 layout
    // The six facts live inside the debug popover now (goal #33), so open it the way a person
    // would before measuring them. A press anywhere outside closes it again, which is why the
    // rest of this run is unaffected.
    const debugToggle = page.locator("[data-testid=diagnostics-toggle]");
    if ((await debugToggle.getAttribute("aria-expanded")) !== "true") {
      await debugToggle.click();
      await page.waitForTimeout(200);
    }
    expect(
      "the debug popover holds the six status facts",
      (await page.locator("[data-testid=status-facts]").count()) === 1 &&
        (await page
          .locator("[data-testid=status-facts] [data-testid^=status-]")
          .count()) >= 6,
      `${String(await page.locator("[data-testid=status-facts] [data-testid^=status-]").count())} rows`,
    );
    expect(
      "the split pane has a separator with bounds",
      (await page.locator("[data-testid=split-handle]").count()) === 1,
      `separator present, agent pane starts at ${(await page
        .locator("[data-testid=agent-pane]")
        .getAttribute("data-basis")) ?? "?"} %`,
    );
    expect(
      "settings offer the keyless demo provider first, and the key field is a password",
      (await page.locator("[data-testid=settings-provider-demo]").getAttribute("aria-pressed")) ===
        "true" &&
        (await page.locator("[data-testid=settings-key]").getAttribute("type")) === "password",
      "demo pressed, key field type=password",
    );

    // ---------------------------------------------------------------- boot
    const bootStartedAt = Date.now();
    await page.locator("[data-testid=boot-button]").click();
    await page
      .locator("[data-testid=env-status]", { hasText: "Ready" })
      .first()
      .waitFor({ timeout: BOOT_TIMEOUT_MS });
    const bootMs = Date.now() - bootStartedAt;
    expect("the guest booted to Ready", true, `${String(bootMs)} ms from click to Ready`);

    // ------------------------------------------------- prompt -> tool activity
    const prompt = "Write the demo site into dist/ so the preview has something to publish.";
    const chatStartedAt = Date.now();
    await page.locator("[data-testid=chat-input]").fill(prompt);
    await page.locator("[data-testid=chat-input]").press("Enter");

    await page.locator("[data-testid=chat-user]").first().waitFor({ timeout: 15_000 });
    expect(
      "the prompt appears in the transcript",
      ((await text(page, "[data-testid=chat-user]")) ?? "").includes("demo site"),
      (await text(page, "[data-testid=chat-user]")) ?? "(empty)",
    );

    // The demo provider asks for three `write_file` calls; each becomes its own row.
    await page
      .locator("[data-testid=chat-tool][data-status=ok]")
      .nth(2)
      .waitFor({ timeout: CHAT_TIMEOUT_MS });
    const toolRows = await page.locator("[data-testid=chat-tool]").count();
    const toolNames = await page
      .locator("[data-testid=chat-tool]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-tool")));
    const chatMs = Date.now() - chatStartedAt;
    expect(
      "the agent's tool calls appear as completed rows",
      toolRows >= 3 && toolNames.every((name) => name === "write_file"),
      `${String(toolRows)} rows: ${toolNames.join(", ")} (${String(chatMs)} ms)`,
    );

    const firstTool = page.locator("[data-testid=chat-tool]").first();
    const inspectable = firstTool.locator("[data-testid=chat-tool-output]");
    expect(
      "a tool row's output is inspectable, and opening it shows the tool's own result",
      (await inspectable.count()) === 1,
      `first row: ${(await firstTool.getAttribute("data-tool")) ?? "?"} ` +
        `${(await firstTool.getAttribute("data-status")) ?? "?"}`,
    );
    await inspectable.first().locator("summary").click();
    const toolOutput = (await inspectable.first().textContent())?.trim() ?? "";
    expect(
      "the inspectable output carries the tool's result text",
      toolOutput.length > 20,
      `${String(toolOutput.length)} chars: ${toolOutput.slice(0, 80).replace(/\s+/g, " ")}…`,
    );
    expect(
      "the assistant's own words are in the transcript",
      ((await text(page, "[data-testid=chat-assistant]")) ?? "").length > 20,
      (await text(page, "[data-testid=chat-assistant]"))?.slice(0, 100) ?? "(empty)",
    );

    // --------------------------------------------------------- build + cancel
    // A cancel must not be reported as a failure, and must leave the control usable again.
    await page.locator("[data-testid=preview-install-build]").click();
    await page.locator("[data-testid=preview-cancel-build]").waitFor({ timeout: 60_000 });
    const busyText = (await text(page, "[data-testid=preview-build-status]")) ?? "";
    expect(
      "the strip says what it is doing while the build runs",
      /Installing|Building/.test(busyText),
      busyText,
    );
    await page.locator("[data-testid=preview-cancel-build]").click();
    await page.locator("[data-testid=preview-cancel-build]").waitFor({ state: "detached", timeout: 30_000 });
    const afterCancel = (await text(page, "[data-testid=preview-build-status]")) ?? "";
    expect(
      "a cancelled build is not reported as a failure",
      !/failed/i.test(afterCancel),
      afterCancel,
    );
    expect(
      "the control is usable again after the cancel",
      (await page.locator("[data-testid=preview-install-build]").isEnabled()) === true,
      "Install & build is enabled",
    );

    // ------------------------------------------------------ the real build
    const perf = perfWindow(page);
    await perf.reset();
    const buildStartedAt = Date.now();
    await page.locator("[data-testid=preview-install-build]").click();

    await page
      .locator("[data-testid=preview-build-status]", { hasText: /succeeded|failed/i })
      .first()
      .waitFor({ timeout: BUILD_TIMEOUT_MS });
    const buildMs = Date.now() - buildStartedAt;
    const buildText = (await text(page, "[data-testid=preview-build-status]")) ?? "";
    const buildKind = (await page.locator("[data-testid=preview-build-strip]").getAttribute("data-kind")) ?? "";
    const buildSample = await perf.read();
    note("build", `${buildText} (${String(buildMs)} ms, kind=${buildKind})`);
    note("responsiveness during the build", summarise(buildSample));

    expect(
      "the build reached a verdict from the manager, not from a timer",
      /succeeded/i.test(buildText) && buildKind === "ok",
      `${buildText} (kind=${buildKind})`,
    );
    expect(
      "the main thread stayed responsive while the build ran",
      // A sampler that never ran proves nothing, so "no frames" is a failure, not a pass.
      // A sampler that never ran proves nothing, so "no frames" is a failure, not a pass.
      buildSample.frames > 30 &&
        buildSample.maxGapMs <= FRAME_GAP_LIMIT_MS &&
        buildSample.longestTaskMs <= FRAME_GAP_LIMIT_MS,
      summarise(buildSample),
    );

    // ------------------------------------------------------------ the preview
    const publishStartedAt = Date.now();
    // A successful build already asks the preview to publish that build's id, so the frame may
    // be there without a click. If it is not, the pane's own button is the fallback — the same
    // control a user would press.
    let autoPublished = true;
    try {
      await page.locator("[data-testid=preview-iframe]").first().waitFor({ timeout: 120_000 });
    } catch {
      autoPublished = false;
      await page.locator("[data-testid=preview-reload]").click();
      await page.locator("[data-testid=preview-iframe]").first().waitFor({ timeout: PUBLISH_TIMEOUT_MS });
    }
    const publishMs = Date.now() - publishStartedAt;
    note(
      "preview",
      `${String(publishMs)} ms to a frame (${autoPublished ? "published by the build" : "after Preview build"})`,
    );
    const frame = page.frameLocator("[data-testid=preview-iframe]");
    await frame.locator("body").waitFor({ timeout: 60_000 });

    const clockText = await frame.locator("[data-clock]").innerText().catch(() => "");
    const bodyText = await frame.locator("body").innerText();
    expect(
      "the preview renders the built starter, not a blank frame",
      /counter/i.test(bodyText) && /\d{2}:\d{2}:\d{2}/.test(bodyText),
      `${String(publishMs)} ms to a frame; body: ${bodyText.replace(/\s+/g, " ").slice(0, 90)}…`,
    );

    // The clock is the build's own JavaScript: if the module did not run, it cannot tick.
    await sleep(1_200);
    const clockLater = await frame.locator("[data-clock]").innerText().catch(() => "");
    expect(
      "the build's own module runs inside the preview (the clock advances)",
      clockText.length > 0 && clockLater !== clockText,
      `${clockText} -> ${clockLater}`,
    );

    // The counter is the interactive half of the starter, driven by real clicks in the frame.
    const before = await frame.locator("[data-counter]").innerText().catch(() => "");
    await frame.locator("[data-counter-increment]").click();
    const after = await frame.locator("[data-counter]").innerText().catch(() => "");
    expect(
      "clicking the built page's counter changes it inside the preview",
      before !== after && after.trim().length > 0,
      `${before.trim()} -> ${after.trim()}`,
    );

    // ------------------------------------------- the pane is a browser, not an iframe
    const previewPane = page.locator("[data-testid=preview-pane]");
    const chromeTab = await text(page, "[data-testid=preview-tab]");
    const buildInTab = (await text(page, "[data-testid=preview-tab-build]")) ?? "";
    const frameSrc = await page.locator("[data-testid=preview-iframe]").first().getAttribute("src");
    const addressValue = await page.locator("[data-testid=preview-address]").inputValue();
    const backDisabled = await page.locator("[data-testid=preview-back]").isDisabled();
    const forwardDisabled = await page.locator("[data-testid=preview-forward]").isDisabled();
    // The dimensions are a tooltip now, so there is no size readout in the row to read; the
    // count is asserted rather than assumed, because a resurrected readout would silently make
    // the hover check below pass for the wrong reason.
    const inlineSizeReadout = await page.locator("[data-testid=preview-device-size]").count();
    const mobileHintIdle = await bubbleOpacity(page, "mobile");
    note(
      "browser chrome",
      `tab="${chromeTab ?? ""}" build=${buildInTab} address=${addressValue} back=${String(backDisabled)} forward=${String(forwardDisabled)} inline-size-readouts=${String(inlineSizeReadout)} mobile-bubble-opacity=${String(mobileHintIdle)}`,
    );
    expect(
      "the pane is wrapped in browser chrome that names the build it shows",
      /preview/i.test(chromeTab ?? "") && buildInTab.length > 0,
      `tab=${chromeTab ?? "(none)"} build=${buildInTab}`,
    );
    expect(
      "the address bar shows the preview URL the frame is actually on",
      addressValue.length > 0 && addressValue === frameSrc && addressValue.startsWith("/__preview__/"),
      `address=${addressValue} src=${frameSrc ?? "(none)"}`,
    );
    expect(
      "back and forward are disabled, because this build has no history to move through",
      backDisabled && forwardDisabled,
      `back=${String(backDisabled)} forward=${String(forwardDisabled)}`,
    );

    const desktopScreenshot = join(evidenceDir, "preview-browser-desktop.png");
    await previewPane.screenshot({ path: desktopScreenshot });
    lines.push("", `screenshot: ${desktopScreenshot}`, "");

    // --------------------------------------------- viewports, split, status bar
    const desktopBox = await page.locator("[data-testid=preview-iframe]").first().boundingBox();
    await page.locator("[data-testid=preview-viewport-mobile]").click();
    const mobileSelected = await page
      .locator("[data-testid=preview-viewport-mobile]")
      .getAttribute("data-selected");
    const mobileBox = await page.locator("[data-testid=preview-iframe]").first().boundingBox();
    expect(
      "the mobile viewport narrows the frame and marks itself selected",
      mobileSelected === "true" &&
        desktopBox !== null &&
        mobileBox !== null &&
        mobileBox.width < desktopBox.width,
      `${String(Math.round(desktopBox?.width ?? 0))} px -> ${String(Math.round(mobileBox?.width ?? 0))} px`,
    );

    // The device toolbar is a toolbar, not a decoration: it states the size it is applying —
    // but only while the pointer is over the button, in a styled bubble rather than in a
    // permanent readout — and the site inside the frame is still the real build at that size.
    const mobileHintShown = await hoverPreset(page, "mobile");
    const mobileHint = (await text(page, "[data-testid=preview-viewport-hint-mobile]")) ?? "";
    const mobileBody = await frame.locator("body").innerText().catch(() => "");
    const mobileScreenshot = join(evidenceDir, "preview-browser-mobile.png");
    await previewPane.screenshot({ path: mobileScreenshot });
    lines.push("", `screenshot: ${mobileScreenshot}`, "");
    expect(
      "the mobile size is a tooltip over its own button, invisible until hovered",
      inlineSizeReadout === 0 && mobileHintIdle < 0.05 && mobileHintShown > 0.9,
      `readouts=${String(inlineSizeReadout)} opacity ${String(mobileHintIdle)} -> ${String(mobileHintShown)}`,
    );
    expect(
      "the tooltip states the exact size and its limit, and the site still renders inside it",
      mobileHint.includes("390 × 844") &&
        mobileHint.includes("no touch events or device pixel ratio") &&
        /counter/i.test(mobileBody),
      `bubble="${mobileHint.replace(/\s+/g, " ").trim()}" body: ${mobileBody.replace(/\s+/g, " ").slice(0, 60)}…`,
    );
    await page.locator("[data-testid=preview-viewport-desktop]").click();

    // The reload arrow has to be a real reload — a fresh document at the same URL — and not a
    // no-op that leaves the old page (and the state the user was in) on screen.
    await frame
      .locator("html")
      .evaluate(() => {
        (window as unknown as Record<string, unknown>).__acceptanceMark = 1;
      })
      .catch(() => undefined);
    await page.locator("[data-testid=preview-reload]").click();
    // A reload re-publishes the build, and the pane hides the frame while it does; the URL must
    // come back unchanged and the document must be new.
    await page.locator("[data-testid=preview-iframe]").first().waitFor({ timeout: PUBLISH_TIMEOUT_MS });
    await frame.locator("body").waitFor({ timeout: 60_000 });
    const markAfterReload = await frame
      .locator("html")
      .evaluate(() => typeof (window as unknown as Record<string, unknown>).__acceptanceMark)
      .catch(() => "unreadable");
    const srcAfterReload = await page
      .locator("[data-testid=preview-iframe]")
      .first()
      .getAttribute("src");
    expect(
      "reload loads a fresh document at the same URL",
      markAfterReload === "undefined" && srcAfterReload === frameSrc,
      `mark=${markAfterReload} src=${srcAfterReload ?? "(none)"} (was ${frameSrc ?? "(none)"})`,
    );

    const basisBefore = Number(
      (await page.locator("[data-testid=agent-pane]").getAttribute("data-basis")) ?? "0",
    );
    await page.locator("[data-testid=split-handle]").focus();
    await page.keyboard.press("ArrowLeft");
    const basisAfter = Number(
      (await page.locator("[data-testid=agent-pane]").getAttribute("data-basis")) ?? "0",
    );
    expect(
      "the split resizes by keyboard and stays inside 20-80 %",
      basisAfter < basisBefore && basisAfter >= 20 && basisAfter <= 80,
      `${String(basisBefore)} % -> ${String(basisAfter)} %`,
    );

    // Re-open: the settings popover and the split drag above both pressed outside this one.
    if ((await debugToggle.getAttribute("aria-expanded")) !== "true") {
      await debugToggle.click();
      await page.waitForTimeout(200);
    }
    const statusSegments = await page
      .locator("[data-testid=status-facts] [data-testid^=status-]")
      .evaluateAll((nodes) =>
        nodes.map((node) => `${node.getAttribute("data-testid") ?? ""}=${(node.textContent ?? "").trim()}`),
      );
    note("status facts", statusSegments.join(" | "));
    expect(
      "the status bar's Build segment reports the build that actually ran",
      statusSegments.some((segment) => segment.startsWith("status-build=") && /build/i.test(segment)),
      statusSegments.find((segment) => segment.startsWith("status-build=")) ?? "(no build segment)",
    );

    await page.screenshot({ path: screenshotPath, fullPage: false });
    lines.push("", `screenshot: ${screenshotPath}`, "");

    const transcript = await text(page, "[data-testid=chat-transcript]");
    lines.push("", "--- chat transcript, as the page shows it ---", transcript ?? "(empty)", "");
    const rows = await page
      .locator("[data-testid=chat-tool]")
      .evaluateAll((nodes) =>
        nodes.map(
          (node) =>
            `${node.getAttribute("data-tool") ?? "?"} ${node.getAttribute("data-status") ?? "?"}: ${
              (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
            }`,
        ),
      );
    lines.push("--- tool rows ---", ...rows, "");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push("", `FAILED: ${message}`, "");
    checks.push({ name: "run", ok: false, detail: message });
  } finally {
    await browser?.close().catch(() => undefined);
    child?.kill("SIGTERM");
  }

  const passed = checks.filter((check) => check.ok).length;
  const failed = checks.length - passed;
  const verdict = failed === 0 && checks.length > 0 ? "PASS" : "FAIL";
  lines.unshift(`verdict: ${verdict} — ${String(passed)}/${String(checks.length)} checks passed`, "");

  writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`[ui] ${verdict}: ${String(passed)}/${String(checks.length)} — ${transcriptPath}`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

await main();
