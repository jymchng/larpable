/**
 * Browser acceptance run for the preview: does a real guest build actually render?
 *
 * Every other test of the preview stops one step short of this. `tests/preview-*.test.ts`
 * prove the routing rules, the proxy decisions, the publish protocol and the pane's markup;
 * `tests/guest/preview.guest.test.ts` proves the guest serves bytes over HTTP through
 * `kernel.fetch()`. None of them loads a document, so none of them can answer the three
 * questions this goal is actually about:
 *
 * 1. does the service worker control the frame the app actually renders? A frame without
 *    `allow-same-origin` is opaque, and Chromium does not hand an opaque frame's requests to
 *    a worker at all — measured: the worker activated, `clients.matchAll()` never listed the
 *    frame, and `/__preview__/<id>/` was answered by the dev server with the app's own HTML.
 *    So the product's sandbox carries `allow-same-origin` and every document carries its own
 *    COOP/COEP; this run is what proves that arrangement renders;
 * 2. does the build's CSS apply — i.e. are root-absolute `/assets/…` URLs rebased and served
 *    from the guest, not from the dev server?
 * 3. does a deep link (`/__preview__/<id>/app/editor`) resolve to the SPA entry and run its
 *    script, rather than 404?
 *
 * The build is written into `/workspace/dist` through the guest's own terminal, so the bytes
 * come from inside the VM and nothing here can substitute a mock for the guest. Every value
 * in the report is read out of the page (or out of the iframe's document) during the run.
 *
 *   bun run dev                        # in another terminal, or let this script start it
 *   bun run acceptance:preview
 *
 * Output:
 *   docs/preview-browser-report.md          rewritten with this run's measurements
 *   docs/evidence/preview-pane.png          the pane showing the rendered site
 *   docs/evidence/preview-deep-link.png     the same frame on an SPA deep link
 *
 * Exit code 0 only when every assertion passed. A red run still writes the report and says
 * FAILED, because a stale green report is worse than no report.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Frame, type Page } from "playwright-core";

import { echoesWholeLine, sizeCommand, sizeLine, writeFileCommand } from "./lib/pty-channel";

const root = resolve(import.meta.dirname, "..");
const reportPath = join(root, "docs", "preview-browser-report.md");
const evidenceDir = join(root, "docs", "evidence");

const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);

const BOOT_TIMEOUT_MS = 240_000;
const SHELL_TIMEOUT_MS = 120_000;
/** First `node` call in a fresh profile downloads the runtime: measured at ~147 s. */
const RUNTIME_WARM_TIMEOUT_MS = 420_000;
/** Server start after a warm runtime. The product allows 300 s; this waits longer and says so. */
const PUBLISH_TIMEOUT_MS = 300_000;
const SERVER_TIMEOUT_MS = 60_000;

/** The colour `dist/assets/style.css` paints the body. A value the build chose, not the app. */
const EXPECTED_BACKGROUND = "rgb(18, 52, 86)";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

class AcceptanceFailure extends Error {}

function expect(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  if (!ok) throw new AcceptanceFailure(`${name} — ${detail}`);
}

interface Session {
  startedAt: string;
  browser: string;
  chromium: string;
  url: string;
  devServer: string;
}

interface Measurements {
  session: Session;
  boot: { status: string; runtime: string | null; wallClockMs: number } | null;
  write: { marker: string | null; files: string | null } | null;
  runtimeWarm: { answered: boolean; line: string | null; wallClockMs: number } | null;
  publish: {
    status: string | null;
    servedBy: string | null;
    /** The controller's own words for a guest-served publish; null when the worker served. */
    note: string | null;
    url: string | null;
    buildId: string | null;
    wallClockMs: number;
  } | null;
  render: {
    background: string | null;
    answer: string | null;
    bodyText: string | null;
    cssApplied: boolean;
    scriptRan: boolean;
  } | null;
  deepLink: { url: string; route: string | null; answer: string | null; title: string | null } | null;
  failure: string | null;
}

function log(step: string, value: unknown): void {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  console.log(`[preview] ${step}: ${rendered}`);
}

function findChromium(): string {
  const explicit = process.env.LARPABLE_CHROMIUM?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`LARPABLE_CHROMIUM does not exist: ${explicit}`);
    return explicit;
  }

  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) {
    throw new Error(`no Playwright browser cache at ${cache}; set LARPABLE_CHROMIUM`);
  }

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

/** The bind address this script insists on for a server it starts itself. */
const ACCEPTANCE_DEV_HOST = "127.0.0.1";

async function ensureDevServer(): Promise<{ child: ChildProcess | null; how: string }> {
  if (await reachable(baseUrl)) return { child: null, how: `already running at ${baseUrl}` };

  console.log(`[preview] ${baseUrl} is down; starting \`bun run dev\` on ${ACCEPTANCE_DEV_HOST}`);
  const child = spawn("bun", ["run", "dev"], {
    cwd: root,
    stdio: "inherit",
    // Loopback only, whatever the environment says. A dev server that any host can reach can
    // be made to execute code: measured, a remote `import.meta.glob` payload ran inside Vite
    // and its `vite:error` overlay then covered the page this run needs to click. An
    // acceptance run must not depend on a server the internet can reach.
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
  return value && value.length > 0 ? value : null;
}

/** The transcript the terminal component mirrors into the DOM, so a run can assert on it. */
async function transcript(page: Page): Promise<string> {
  return (await page.locator("[data-testid=terminal-output]").first().textContent()) ?? "";
}

/**
 * Type a command into the live pty and wait for a marker to appear in the transcript.
 *
 * The marker is produced by the command itself (`printf`), not by a sleep: a fixed delay is
 * either wasted on every call or too short on the first, and the first is the case that
 * matters here.
 */
async function runInTerminal(
  page: Page,
  lines: readonly string[],
  marker: string,
  timeoutMs = 60_000,
): Promise<{ answered: boolean; line: string | null; tail: string }> {
  await page.locator("[data-testid=terminal-screen]").click();
  for (const line of lines) {
    const typed = await typeLine(page, line);
    // Do not press Enter on a line the pty did not receive whole: a short command whose tail
    // was lost is a *different* command, and one of them writes a truncated file.
    if (!typed.ok) return { answered: false, line: null, tail: typed.tail };
  }

  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    seen = await transcript(page);
    if (seen.includes(marker)) break;
    await page.waitForTimeout(250);
  }

  const line = seen
    .split(/\r?\n/)
    .filter((entry) => entry.includes(marker))
    .pop();
  return { answered: seen.includes(marker), line: line ?? null, tail: seen.slice(-400) };
}

/**
 * Type one line and press Enter only once the pty has echoed it back in full.
 *
 * Typing into xterm drops characters under load — that is not a bug in this script, it is
 * what a real pty under a real workload does. What the script must not do is *assume* the
 * line arrived. So each attempt types the line, reads the terminal mirror back, and only
 * presses Enter when the echo matches; a partial line is killed with `Ctrl-U` and retyped,
 * a little slower each time. The cost is a few seconds; the alternative is a run that
 * reports a file the guest never received.
 */
async function typeLine(
  page: Page,
  line: string,
  attempts = 3,
): Promise<{ ok: boolean; tail: string }> {
  let tail = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await page.locator("[data-testid=terminal-screen]").click();
    // Throw away anything left on the line by a previous, partial attempt.
    await page.keyboard.press("Control+u");
    await page.keyboard.type(line, { delay: 6 + attempt * 10 });
    // xterm mirrors its buffer into the DOM on animation frames, so the echo trails the
    // keystrokes: poll for it rather than reading once and calling a slow render a lost
    // character.
    const echoDeadline = Date.now() + 5_000;
    while (Date.now() < echoDeadline) {
      tail = await transcript(page);
      if (echoesWholeLine(tail.slice(-6_000), line)) {
        await page.keyboard.press("Enter");
        return { ok: true, tail };
      }
      await page.waitForTimeout(120);
    }
  }
  await page.keyboard.press("Control+u");
  return { ok: false, tail: tail.slice(-400) };
}

/**
 * The fixture build. A Vite-shaped `dist/`: a root-absolute stylesheet, a root-absolute
 * ES module, an SPA entry that reads `location.pathname`, and a binary-free file set.
 *
 * Root-absolute URLs are deliberate: they are what a real build emits, and they are what
 * `routing.ts` has to rebase for the preview's subpath. A relative-only fixture would pass
 * even if rebasing were broken.
 */
const FIXTURE: { path: string; lines: readonly string[] }[] = [
  {
    path: "dist/index.html",
    lines: [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8">',
      "<title>Guest build</title>",
      '<link rel="stylesheet" href="/assets/index-abc123.css">',
      "</head><body>",
      '<div id="answer"></div>',
      '<div id="route"></div>',
      '<script type="module" src="/assets/index-def456.js"></script>',
      "</body></html>",
    ],
  },
  {
    path: "dist/assets/index-abc123.css",
    lines: [
      "body { margin: 0; background: #123456; color: #ffffff; font-family: monospace; }",
      "#answer::before { content: 'answer='; }",
      "#route::before { content: 'route='; }",
    ],
  },
  {
    path: "dist/assets/index-def456.js",
    lines: [
      "const answer = document.getElementById('answer');",
      "const route = document.getElementById('route');",
      "answer.textContent = '42';",
      "route.textContent = window.location.pathname;",
      "document.title = 'guest-js-ran';",
    ],
  },
];

/** The bytes of a fixture entry, exactly as they land on disk. */
function fixtureContent(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

/**
 * Write one fixture file into the guest and make the guest count it.
 *
 * Two lines, both short: the base64 payload, then the byte count. See `scripts/lib/
 * pty-channel.ts` for why the bytes travel as base64 and why the count comes from `wc`
 * inside the guest rather than from this script. The retry is for a dropped character
 * during typing, which `typeLine` has usually already caught; a second attempt costs a
 * second and removes a whole class of red run.
 */
async function writeFixture(
  page: Page,
  file: { path: string; lines: readonly string[] },
): Promise<{ ok: boolean; detail: string }> {
  const content = fixtureContent(file.lines);
  const bytes = Buffer.byteLength(content, "utf8");
  const commands = [writeFileCommand(file.path, content), sizeCommand(file.path)];
  let last = { answered: false, line: null as string | null, tail: "" };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    last = await runInTerminal(page, commands, sizeLine(file.path, bytes), 45_000);
    if (last.answered) break;
  }
  return { ok: last.answered, detail: last.line ?? last.tail };
}

interface FrameView {
  background: string | null;
  answer: string | null;
  route: string | null;
  title: string | null;
  bodyText: string | null;
}

async function inspectFrame(frame: Frame): Promise<FrameView> {
  return await frame.evaluate(() => {
    const element = (id: string) => document.getElementById(id);
    return {
      background: getComputedStyle(document.body).backgroundColor,
      answer: element("answer")?.textContent ?? null,
      route: element("route")?.textContent ?? null,
      title: document.title,
      bodyText: (document.body.textContent ?? "").slice(-300),
    };
  });
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });

  const measurements: Measurements = {
    session: {
      startedAt: new Date().toISOString(),
      browser: "unknown",
      chromium: findChromium(),
      url: baseUrl,
      devServer: "already running",
    },
    boot: null,
    write: null,
    runtimeWarm: null,
    publish: null,
    render: null,
    deepLink: null,
    failure: null,
  };

  const { child, how } = await ensureDevServer();
  measurements.session.devServer = how;

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      executablePath: measurements.session.chromium,
      headless: true,
    });
    measurements.session.browser = `Chromium ${browser.version()}`;

    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
    page.on("console", (message) => {
      if (message.type() === "error") log("console.error", message.text());
    });
    await page.goto(`${baseUrl}/`, { waitUntil: "load" });

    // ---------------------------------------------------------------- boot
    const bootStartedAt = Date.now();
    await page.locator("[data-testid=boot-button]").click();
    await page
      .locator("[data-testid=env-status]", { hasText: "Ready" })
      .first()
      .waitFor({ timeout: BOOT_TIMEOUT_MS });
    measurements.boot = {
      status: (await text(page, "[data-testid=env-status]")) ?? "",
      runtime: await text(page, "footer > span"),
      wallClockMs: Date.now() - bootStartedAt,
    };
    expect("the guest booted to Ready", measurements.boot.status === "Ready", measurements.boot.status);

    await page
      .locator("[data-testid=terminal-panel][data-connection=connected]")
      .waitFor({ timeout: SHELL_TIMEOUT_MS });
    expect("a shell is attached to the guest", true, "terminal panel reports connected");

    // ------------------------------------------------- runtime, then the build
    // The preview server runs `node`. In a fresh profile that first call downloads the
    // runtime (~147 s measured), so it is paid here, deliberately, with a marker — not
    // inside a publish where a timeout would read as a broken preview.
    const warmStartedAt = Date.now();
    const warm = await runInTerminal(
      page,
      ['printf "LARPABLE-%s\\n" "RUNTIME node=$(node --version 2>&1 | tail -1)"'],
      "LARPABLE-RUNTIME",
      RUNTIME_WARM_TIMEOUT_MS,
    );
    measurements.runtimeWarm = {
      answered: warm.answered,
      line: warm.line,
      wallClockMs: Date.now() - warmStartedAt,
    };
    expect("the guest's node answered", warm.answered, warm.line ?? warm.tail);
    expect(
      "node reports a version",
      /v\d+\./.test(warm.line ?? ""),
      warm.line ?? "(no version in the marker line)",
    );

    await runInTerminal(
      page,
      ['mkdir -p dist/assets', 'printf "LARPABLE-%s\\n" "MKDIR ready"'],
      "LARPABLE-MKDIR",
      30_000,
    );
    for (const file of FIXTURE) {
      const wrote = await writeFixture(page, file);
      const bytes = Buffer.byteLength(fixtureContent(file.lines), "utf8");
      // The detail is the guest's own count: "LARPABLE-SIZE <path> <bytes>" is printed by
      // `printf` inside the VM, so a truncated write reports a smaller number and fails here.
      expect(`the guest took ${file.path} whole (${bytes} bytes)`, wrote.ok, wrote.detail);
    }
    const listing = await runInTerminal(
      page,
      ['printf "LARPABLE-%s\\n" "LS $(find dist -type f | sort | tr \'\\n\' \' \')"'],
      "LARPABLE-LS",
      30_000,
    );
    measurements.write = { marker: listing.line, files: listing.line };
    expect("the build is in the guest's dist/", listing.answered, listing.line ?? listing.tail);
    expect(
      "dist/ holds the three build files",
      /dist\/index\.html/.test(listing.line ?? "") &&
        /dist\/assets\/index-abc123\.css/.test(listing.line ?? "") &&
        /dist\/assets\/index-def456\.js/.test(listing.line ?? ""),
      listing.line ?? "(no listing)",
    );

    // ------------------------------------------------------------- publish
    const publishStartedAt = Date.now();
    await page.locator("[data-testid=preview-reload]").click();
    await page.locator("[data-testid=preview-iframe]").waitFor({ timeout: PUBLISH_TIMEOUT_MS });

    const buildId = await page
      .locator("[data-testid=preview-iframe]")
      .first()
      .getAttribute("data-build-id");
    const src = await page.locator("[data-testid=preview-iframe]").first().getAttribute("src");
    // The transient status sentence is a toast now; the durable note about *why* the guest is
    // answering lives on the toolbar row that survives (user request: all notifications are
    // toasts, so no sentence is printed in that row any more).
    const note =
      (await page.locator("[data-testid=preview-toolbar]").first().getAttribute("data-note")) ?? "";
    measurements.publish = {
      status: await text(page, "[data-testid=preview-served-by]"),
      servedBy: await text(page, "[data-testid=preview-served-by]"),
      note: note.length > 0 ? note : null,
      url: src,
      buildId,
      wallClockMs: Date.now() - publishStartedAt,
    };
    log("publish", measurements.publish);
    expect("the pane published a build", buildId !== null, `build id ${String(buildId)}`);
    // "guest" means the worker refused the publish, and `/__preview__/<id>/` then falls through
    // to the dev server's SPA fallback — the iframe renders the *app*, not the build. That is a
    // failure of this goal, not a variation of it, so it is asserted rather than merely reported.
    expect(
      "the preview worker holds the build",
      measurements.publish.servedBy === "worker",
      measurements.publish.note ??
        `served by ${String(measurements.publish.servedBy)}, and the controller gave no reason`,
    );
    expect(
      "the preview URL names the build",
      (src ?? "").startsWith(`/__preview__/${String(buildId)}/`),
      src ?? "(no src)",
    );

    // -------------------------------------------------------------- render
    const iframe = page.locator("[data-testid=preview-iframe]").first();
    const handle = await iframe.elementHandle();
    const frame = handle ? await handle.contentFrame() : null;
    expect("the iframe has a document", frame !== null, "contentFrame() resolved");

    // The worker holds the build; give the frame's own module + stylesheet a moment.
    const renderDeadline = Date.now() + 30_000;
    let view: FrameView = await inspectFrame(frame as Frame);
    while (Date.now() < renderDeadline && view.answer !== "42") {
      await page.waitForTimeout(250);
      view = await inspectFrame(frame as Frame);
    }
    measurements.render = {
      background: view.background,
      answer: view.answer,
      bodyText: view.bodyText,
      cssApplied: view.background === EXPECTED_BACKGROUND,
      scriptRan: view.answer === "42",
    };
    log("render", measurements.render);

    expect(
      "the build's stylesheet applied inside the iframe",
      view.background === EXPECTED_BACKGROUND,
      `computed body background is ${String(view.background)}, expected ${EXPECTED_BACKGROUND}`,
    );
    expect(
      "the build's module executed inside the iframe",
      view.answer === "42",
      `#answer reads ${JSON.stringify(view.answer)}`,
    );
    await page.screenshot({ path: join(evidenceDir, "preview-pane.png"), fullPage: true });

    // ------------------------------------------------------------ deep link
    const deepLinkUrl = `${baseUrl}/__preview__/${String(buildId)}/app/editor`;
    await (frame as Frame).goto(deepLinkUrl, { waitUntil: "load" });
    const deepDeadline = Date.now() + 30_000;
    let deep: FrameView = await inspectFrame(frame as Frame);
    while (Date.now() < deepDeadline && deep.answer !== "42") {
      await page.waitForTimeout(250);
      deep = await inspectFrame(frame as Frame);
    }
    measurements.deepLink = {
      url: deepLinkUrl,
      route: deep.route,
      answer: deep.answer,
      title: deep.title,
    };
    log("deep-link", measurements.deepLink);

    expect(
      "an SPA deep link resolves to the entry document",
      deep.answer === "42",
      `#answer reads ${JSON.stringify(deep.answer)} — the fallback did not serve index.html`,
    );
    expect(
      "the deep link keeps its own path",
      deep.route === `/__preview__/${String(buildId)}/app/editor`,
      `#route reads ${JSON.stringify(deep.route)}`,
    );
    await page.screenshot({ path: join(evidenceDir, "preview-deep-link.png"), fullPage: true });
  } catch (error) {
    measurements.failure = error instanceof Error ? error.message : String(error);
  } finally {
    await browser?.close().catch(() => undefined);
    child?.kill("SIGTERM");
  }

  writeFileSync(reportPath, renderReport(measurements), "utf8");
  for (const check of checks) {
    console.log(`[preview] ${check.ok ? "PASS" : "FAIL"} ${check.name} — ${check.detail}`);
  }
  console.log(`[preview] report: ${reportPath}`);

  if (measurements.failure) {
    console.error(`[preview] FAILED: ${measurements.failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[preview] PASSED (${checks.length} checks)`);
}

function renderReport(measurements: Measurements): string {
  const passed = checks.filter((check) => check.ok).length;
  const { session, boot, write, runtimeWarm, publish, render, deepLink } = measurements;

  const lines: string[] = [
    "# Preview browser report",
    "",
    "Generated by `bun run acceptance:preview`. Every value below was read out of the page —",
    "or out of the iframe's own document — during a real browser session against a real",
    "guest. Re-run the command to replace this file with fresh measurements.",
    "",
    `**Verdict: ${measurements.failure === null ? "PASS" : "FAIL"}** — ${passed}/${checks.length} checks passed.`,
    "",
  ];

  if (measurements.failure) {
    lines.push("## Failure", "", "```", measurements.failure, "```", "");
  }

  lines.push(
    "## Session",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Started at | ${session.startedAt} |`,
    `| Browser | ${session.browser} |`,
    `| Chromium binary | \`${session.chromium}\` |`,
    `| Page | ${session.url} |`,
    `| Dev server | ${session.devServer} |`,
    "",
    "## Checks",
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...checks.map(
      (check) =>
        `| ${check.name} | ${check.ok ? "PASS" : "FAIL"} | ${check.detail.replace(/\|/g, "\\|")} |`,
    ),
    "",
  );

  if (boot) {
    lines.push(
      "## The guest",
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Status badge | ${boot.status} |`,
      `| Runtime detected at boot | ${boot.runtime ?? "not shown"} |`,
      `| Click to Ready | ${boot.wallClockMs} ms |`,
      "",
    );
  }

  if (runtimeWarm) {
    lines.push(
      "## Warming the runtime the preview server needs",
      "",
      "The guest's `node` is a first-use shim: in a fresh profile the first call downloads the",
      "runtime. The run pays that once, in the terminal, and measures it:",
      "",
      "```",
      runtimeWarm.line ?? "(no marker line)",
      "```",
      "",
      `Answered: **${String(runtimeWarm.answered)}**, wall clock: **${runtimeWarm.wallClockMs} ms**.`,
      "",
    );
  }

  if (write) {
    lines.push(
      "## The build, as written into the guest",
      "",
      "```",
      write.files ?? "(no listing)",
      "```",
      "",
      "Written one file per command: the bytes travel as base64 (`printf %s … | base64 -d`,",
      "which no quote or `$` can break) and the guest prints the byte count `wc -c` measured",
      "for itself, so a truncated write fails the run instead of passing it.",
      "",
      "Three files: an SPA entry with root-absolute `/assets/…` URLs, a stylesheet that paints",
      "the body `#123456`, and a module that writes `42` into `#answer` and `location.pathname`",
      "into `#route`. Root-absolute URLs are what a real build emits, and what `routing.ts` has",
      "to rebase for the preview's subpath.",
      "",
    );
  }

  if (publish) {
    lines.push(
      "## Publishing to the service worker",
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Build id in the iframe's URL | \`${publish.buildId ?? "none"}\` |`,
      `| iframe \`src\` | \`${publish.url ?? "none"}\` |`,
      `| Pane status | ${publish.status ?? "none"} |`,
      `| Served by | ${publish.servedBy ?? "worker (no badge)"} |`,
      `| Why the guest answered, if it did | ${publish.note ?? "(not applicable)"} |`,
      `| Click to published iframe | ${publish.wallClockMs} ms |`,
      "",
      publish.servedBy === "guest"
        ? "**Served by the guest**, not the worker: this browser refused service-worker control of\n" +
          "the iframe (an opaque origin is the sandbox's price), so the documented fallback answered\n" +
          "from the guest instead. The preview still rendered; it is slower per asset."
        : "**Served by the worker**: the service worker answered from the published snapshot, so the\n" +
          "iframe's own module and stylesheet requests never made a round trip into the guest.",
      "",
    );
  }

  if (render) {
    lines.push(
      "## What the iframe rendered",
      "",
      "| Measurement | Value | Meaning |",
      "| --- | --- | --- |",
      `| \`getComputedStyle(body).backgroundColor\` | \`${render.background ?? "none"}\` | the stylesheet the build emitted applied |`,
      `| \`#answer\` text | \`${render.answer ?? "none"}\` | the build's module executed |`,
      "",
      "Body text as the frame sees it:",
      "",
      "```",
      render.bodyText ?? "(empty)",
      "```",
      "",
      `stylesheet applied: **${String(render.cssApplied)}**, module executed: **${String(render.scriptRan)}**`,
      "",
      "![The preview pane showing the guest build](evidence/preview-pane.png)",
      "",
    );
  }

  if (deepLink) {
    lines.push(
      "## An SPA deep link",
      "",
      `Navigated the iframe to \`${deepLink.url}\` — a path that exists in no file, exactly what a`,
      "router-based site needs at runtime.",
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| \`#route\` (written from \`location.pathname\`) | \`${deepLink.route ?? "none"}\` |`,
      `| \`#answer\` (the module ran again) | \`${deepLink.answer ?? "none"}\` |`,
      `| \`document.title\` | ${deepLink.title ?? "none"} |`,
      "",
      "![The same frame on an SPA deep link](evidence/preview-deep-link.png)",
      "",
    );
  }

  lines.push(
    "## Why this is evidence and not a claim",
    "",
    "The build is written into `/workspace/dist` through the guest's own terminal, so the bytes",
    "come from inside the VM. The pane is then published by the app's real code path —",
    "`startPreviewServer` → `collectPreviewSnapshot` → the worker's publish protocol →",
    "`PreviewFrame` — with no test-only shortcut. The assertions are read out of the rendered",
    "document: a computed background colour the build's CSS chose, a value the build's module",
    "wrote, and the pathname of a deep link.",
    "",
    "## Reproducing",
    "",
    "```sh",
    "bun run dev            # or let the script start one",
    "bun run acceptance:preview",
    "```",
    "",
  );

  return lines.join("\n");
}

await main();
