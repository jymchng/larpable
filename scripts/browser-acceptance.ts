/**
 * Browser acceptance run for the Linux guest: the machine-checked half of "it boots".
 *
 * The claim this script has to settle is not "the app renders a status card" but "a
 * kernel booted, Linux answered a command, and a file round-tripped through the 9p
 * mount in both directions" — in a real browser, on the real dev server, with the
 * defaults the product ships. So it drives the app the way a user does (click Boot,
 * wait for Ready, click Run self-test), reads the results *out of the rendered page*,
 * and writes down what it saw. Nothing is asserted from constants in this file.
 *
 * It also covers the failure path that is invisible in a capable CI browser:
 * `?simulateSupport=no-jspi` must render the JSPI explanation and offer no boot button,
 * because a button that cannot work is a silent failure.
 *
 *   bun run dev                      # in another terminal, or let this script start it
 *   bun run acceptance:browser
 *
 * Output:
 *   docs/browser-boot-report.md                 rewritten with this run's measurements
 *   docs/evidence/browser-boot-ready.png        booted panel with a passing self-test
 *   docs/evidence/browser-boot-unsupported.png  the unsupported-browser explanation
 *
 * Exit code 0 only when every check passed. On failure the report is still written and
 * says FAILED with the check that failed: a red run must leave evidence too, not a
 * stale green report.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium, type Browser, type Page } from "playwright-core";

import {
  FOOTER_STATUS,
  SELF_TEST_BUTTON,
  SUPPORT_PROBLEMS,
  ensureBooted,
  openDiagnostics,
} from "./lib/boot.ts";

const root = resolve(import.meta.dirname, "..");
const reportPath = join(root, "docs", "browser-boot-report.md");
const evidenceDir = join(root, "docs", "evidence");

const baseUrl = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() || "http://127.0.0.1:5173").replace(
  /\/+$/,
  "",
);

/** A cold boot downloads the image and starts the kernel; ~3 s is typical, 3 min is a hang. */
const BOOT_TIMEOUT_MS = 180_000;
const SELF_TEST_TIMEOUT_MS = 120_000;
const SERVER_TIMEOUT_MS = 60_000;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface Session {
  browser: string;
  chromium: string;
  url: string;
  /** `LARPABLE_ACCEPTANCE_URL` set means this run measured a deployed site, not a dev server. */
  target: "local dev server" | "remote deployment";
  devServer: string;
  startedAt: string;
}

interface BootMeasurement {
  status: string;
  distro: string | null;
  cpus: string | null;
  memory: string | null;
  bootBadge: string | null;
  statusBar: string | null;
  /** Which path `ensureBooted` took: the machine had already started itself, or it was pressed. */
  bootPath: string;
  /** Milliseconds `ensureBooted` spent waiting for the footer to say Ready. */
  helperWaitedMs: number;
  wallClockMs: number;
}

interface SelfTestMeasurement {
  summary: string;
  uname: string;
  hostToGuest: string;
  guestToHost: string;
}

interface UnsupportedMeasurement {
  heading: string;
  problems: string[];
  bootButtons: number;
}

interface Measurements {
  session: Session;
  boot: BootMeasurement | null;
  selfTest: SelfTestMeasurement | null;
  unsupported: UnsupportedMeasurement | null;
}

/** Thrown by `expect`, caught at the top level so a failure still produces a report. */
class AcceptanceFailure extends Error {}

const checks: Check[] = [];

function expect(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  if (!ok) throw new AcceptanceFailure(`${name} — ${detail}`);
}

/**
 * Playwright's registry would download the exact revision its own version wants; this
 * run instead uses whatever Chromium is already cached, newest first, so acceptance
 * never depends on a matching `playwright` install. `LARPABLE_CHROMIUM` wins for a
 * pinned CI image.
 */
function findChromium(): string {
  const explicit = process.env.LARPABLE_CHROMIUM?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`LARPABLE_CHROMIUM does not exist: ${explicit}`);
    return explicit;
  }

  const cache = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(cache)) {
    throw new Error(
      `no Playwright browser cache at ${cache}; run \`bunx playwright install chromium\` or set LARPABLE_CHROMIUM`,
    );
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

/**
 * Use the dev server if one is already listening; otherwise start one and stop it on the
 * way out. The URL is fixed on purpose: a second Vite on another port would quietly test
 * a different server than the one the developer is looking at.
 */
async function ensureDevServer(): Promise<{ child: ChildProcess | null; how: Session["devServer"] }> {
  if (await reachable(baseUrl)) return { child: null, how: "already running" };

  console.log(`[acceptance] ${baseUrl} is down; starting \`bun run dev\``);
  const child = spawn("bun", ["run", "dev"], { cwd: root, stdio: "inherit" });

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

async function bootsToReady(page: Page): Promise<BootMeasurement> {
  await page.goto(`${baseUrl}/`, { waitUntil: "load" });

  expect(
    "supported browser: the app rendered",
    (await page.locator("[data-testid=environment-panel]").count()) === 1,
    `environment panel at ${baseUrl}`,
  );

  const supportProblems = await text(page, SUPPORT_PROBLEMS);
  expect(
    "supported browser: support probe passes",
    supportProblems === null,
    supportProblems ?? "no support problems reported",
  );

  /*
   * The machine starts itself on load and the manual Boot control lives inside the debug
   * popover, which is closed by default and whose button is disabled while a boot runs. So the
   * run waits on the footer (the only status visible without a click) through `ensureBooted`,
   * which presses Boot only when nothing is running and reports which path it took \u2014 see
   * `scripts/lib/boot.ts` for why an unconditional click is not an option any more.
   */
  const startedAt = Date.now();
  const boot = await ensureBooted(page, {
    timeoutMs: BOOT_TIMEOUT_MS,
    log: (line) => {
      console.log(`[acceptance] ${line}`);
    },
  });
  const wallClockMs = Date.now() - startedAt;

  // The badges below live in the popover's Machine section, so open it (a no-op when the
  // helper already did) and read them where the user would.
  await openDiagnostics(page);

  expect(
    "supported browser: boot control offered in the debug popover",
    (await page.locator("[data-testid=boot-button]").count()) === 1,
    `${await page.locator("[data-testid=boot-button]").count()} boot button(s)`,
  );

  const status = (await text(page, "[data-testid=env-status]")) ?? "";
  expect("environment reports Ready", status === "Ready", `status badge reads ${JSON.stringify(status)}`);

  const measurement: BootMeasurement = {
    status,
    distro: await text(page, "[data-testid=env-distro]"),
    cpus: await text(page, "[data-testid=env-cpus]"),
    memory: await text(page, "[data-testid=env-memory]"),
    bootBadge: await text(page, "[data-testid=boot-duration]"),
    statusBar: await text(page, FOOTER_STATUS),
    bootPath: boot.path,
    helperWaitedMs: boot.waitedMs,
    wallClockMs,
  };

  expect("environment reports its distro", measurement.distro !== null, measurement.distro ?? "no distro badge");
  expect("environment reports its CPUs", measurement.cpus !== null, measurement.cpus ?? "no CPU badge");
  expect("environment reports its memory", measurement.memory !== null, measurement.memory ?? "no memory badge");
  expect(
    "status bar shows the live environment",
    (measurement.statusBar ?? "").includes("Ready"),
    measurement.statusBar ?? "no status bar",
  );

  return measurement;
}

async function runsSelfTest(page: Page): Promise<SelfTestMeasurement> {
  // The self-test control is one of the three the debug popover owns.
  await openDiagnostics(page);
  await page.locator(SELF_TEST_BUTTON).click();
  await page.locator("[data-testid=self-test-report]").first().waitFor({ timeout: SELF_TEST_TIMEOUT_MS });

  const summary = (await text(page, "[data-testid=self-test-summary]")) ?? "";
  const uname = (await text(page, "[data-testid=uname-output]")) ?? "";
  const guestShell = (await text(page, "[data-testid=self-test-guest-shell]")) ?? "";
  const hostToGuest = (await text(page, "[data-testid=self-test-host-to-guest]")) ?? "";
  const guestToHost = (await text(page, "[data-testid=self-test-guest-to-host]")) ?? "";

  expect(
    "self-test: guest command ran",
    guestShell.includes("unkernel") || uname.includes("unkernel"),
    guestShell || "(empty)",
  );
  expect("self-test: uname reports aarch64", uname.includes("aarch64"), uname || "(no uname output)");
  expect(
    "self-test: host -> guest round-trip",
    hostToGuest.includes("arrived intact"),
    hostToGuest || "(empty)",
  );
  expect(
    "self-test: guest -> host round-trip",
    guestToHost.includes("arrived intact"),
    guestToHost || "(empty)",
  );
  expect("self-test: overall verdict", summary.startsWith("The guest answered"), summary || "(empty)");

  return { summary, uname, hostToGuest, guestToHost };
}

async function unsupportedPath(page: Page): Promise<UnsupportedMeasurement> {
  await page.goto(`${baseUrl}/?simulateSupport=no-jspi`, { waitUntil: "load" });

  /*
   * Where the problems render changed with the debug popover. The environment card is `compact`
   * inside it now, so the card's own `support-problems` alert does not render at all; the
   * popover's *Requirements* section lists the same strings instead. Both live in the surface,
   * which stays in the DOM while closed, so the wait is on the list being *attached* and the
   * popover is then opened to read it as a person would.
   */
  const problems = page.locator("[data-testid=requirement-problems]");
  await problems.first().waitFor({ state: "attached", timeout: 30_000 });
  await openDiagnostics(page);

  const heading = (await text(page, "[data-testid=requirement-problems] li")) ?? "";
  const problemsText = (await problems.first().innerText()).trim();
  const bootButtons = await page.locator("[data-testid=boot-button]").count();

  expect("unsupported browser: explains itself", problemsText.includes("JSPI"), heading || "(no heading)");
  expect(
    "unsupported browser: names browsers that work",
    /Chrome\/Edge|Firefox|Safari/.test(problemsText),
    problemsText.split("\n").find((line) => line.includes("Chrome/Edge")) ?? problemsText,
  );
  expect("unsupported browser: no boot control", bootButtons === 0, `${bootButtons} boot button(s) rendered`);

  return {
    heading,
    problems: problemsText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    bootButtons,
  };
}

function renderReport(measurements: Measurements, failure: Error | null): string {
  const { session, boot, selfTest, unsupported } = measurements;
  const passed = checks.filter((check) => check.ok).length;
  // A production run must not overwrite the dev-server evidence files, or the two reports
  // would show the same picture while claiming different things.
  const remote = session.target === "remote deployment";
  const bootShot = remote ? "production-boot.png" : "browser-boot-ready.png";
  const unsupportedShot = remote ? "production-unsupported.png" : "browser-boot-unsupported.png";

  const lines: string[] = [
    "# Browser boot report",
    "",
    "Generated by `bun run acceptance:browser`. Every value below was read out of the",
    "rendered page during a real browser session — nothing here is estimated or typed by",
    "hand. Re-run the command to replace this file with fresh measurements.",
    "",
    `**Verdict: ${failure === null ? "PASS" : "FAIL"}** — ${passed}/${checks.length} checks passed.`,
    "",
  ];

  if (failure) {
    lines.push("## Failure", "", "```", failure.message, "```", "");
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
    `| Target | ${session.target} |`,
    `| Dev server | ${session.devServer} |`,
    "",
    "## Checks",
    "",
    "| Check | Result | Detail |",
    "| --- | --- | --- |",
    ...checks.map(
      (check) => `| ${check.name} | ${check.ok ? "PASS" : "FAIL"} | ${check.detail.replace(/\|/g, "\\|")} |`,
    ),
    "",
  );

  if (boot) {
    lines.push(
      "## Supported browser: boot to ready",
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Status badge | ${boot.status} |`,
      `| Distro | ${boot.distro ?? "not shown"} |`,
      `| CPUs | ${boot.cpus ?? "not shown"} |`,
      `| Memory | ${boot.memory ?? "not shown"} |`,
      `| Boot duration (app-measured) | ${boot.bootBadge ?? "not shown"} |`,
      `| Boot path (auto-boot vs pressed) | ${boot.bootPath} |`,
      `| Waited by the boot helper | ${boot.helperWaitedMs} ms |`,
      `| Wall clock from the first observation to Ready | ${boot.wallClockMs} ms |`,
      `| Status bar | ${boot.statusBar ?? "not rendered"} |`,
      "",
    );
  }

  if (selfTest) {
    lines.push(
      "## Supported browser: self-test round-trip",
      "",
      `Panel summary: “${selfTest.summary}”`,
      "",
      "| Step | Detail |",
      "| --- | --- |",
      `| Run a command in the guest | ${selfTest.uname || "see summary"} |`,
      `| Write from the host, read in Linux | ${selfTest.hostToGuest} |`,
      `| Write in Linux, read on the host | ${selfTest.guestToHost} |`,
      "",
      "`uname -a` from inside the guest:",
      "",
      "```",
      selfTest.uname || "(no output)",
      "```",
      "",
      `![Booted environment with a passing self-test](evidence/${bootShot})`,
      "",
    );
  }

  if (unsupported) {
    lines.push(
      "## Unsupported browser path",
      "",
      `Opened \`${session.url}/?simulateSupport=no-jspi\`, the dev-only probe simulation that`,
      "pretends `WebAssembly.Suspending` is missing — the one failure a capable browser",
      "cannot reach on its own. The panel rendered:",
      "",
      ...unsupported.problems.map((line) => `- ${line}`),
      "",
      `Boot controls rendered: **${unsupported.bootButtons}** — the page never invites a boot`,
      "that cannot work, and never spins forever.",
      "",
      `![Unsupported browser explanation](evidence/${unsupportedShot})`,
      "",
    );
  }

  lines.push(
    "## Why this is evidence and not a claim",
    "",
    "The numbers come from the app's own state machine (`EnvironmentSnapshot`,",
    "`bootDurationMs`) and from a self-test that runs real commands in the guest through the",
    "9p-mounted `/workspace` — the same path a user exercises. The screenshots are of the",
    "page as rendered. The same behaviour is covered headlessly by `bun run test`",
    "(`tests/boot.test.ts`, `tests/self-test.test.ts`, `tests/app.test.tsx`) and by",
    "`bun run test:guest`, which boots the real Alpine kernel under Node.",
    "",
    "## Reproducing",
    "",
    "```sh",
    "bun run acceptance:browser        # starts a dev server if one is not already running",
    "```",
    "",
    "The guest's own network access (needed by `npm install`) goes through a Wisp proxy.",
    "Setting `VITE_LINUX_NETWORK=0` resolves the boot config to `network: \"none\"` for hosts",
    "that do not run a proxy.",
    "",
  );

  return lines.join("\n");
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });

  const remote = (process.env.LARPABLE_ACCEPTANCE_URL?.trim() ?? "").length > 0;
  const evidenceNames = {
    boot: remote ? "production-boot.png" : "browser-boot-ready.png",
    unsupported: remote ? "production-unsupported.png" : "browser-boot-unsupported.png",
  };

  const measurements: Measurements = {
    session: {
      browser: "unknown",
      chromium: findChromium(),
      url: baseUrl,
      target: remote ? "remote deployment" : "local dev server",
      devServer: remote ? "not used (the URL is a deployment)" : "already running",
      startedAt: new Date().toISOString(),
    },
    boot: null,
    selfTest: null,
    unsupported: null,
  };

  let failure: Error | null = null;
  const { child, how } = await ensureDevServer();
  measurements.session.devServer = how;
  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({ executablePath: measurements.session.chromium, headless: true });
    measurements.session.browser = `Chromium ${browser.version()}`;

    const page = await browser.newPage();
    measurements.boot = await bootsToReady(page);
    measurements.selfTest = await runsSelfTest(page);
    await page.screenshot({ path: join(evidenceDir, evidenceNames.boot), fullPage: true });

    measurements.unsupported = await unsupportedPath(page);
    await page.screenshot({ path: join(evidenceDir, evidenceNames.unsupported), fullPage: true });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    await browser?.close().catch(() => undefined);
    child?.kill("SIGTERM");
  }

  writeFileSync(reportPath, renderReport(measurements, failure), "utf8");

  for (const check of checks) {
    console.log(`[acceptance] ${check.ok ? "PASS" : "FAIL"} ${check.name} — ${check.detail}`);
  }
  console.log(`[acceptance] report: ${reportPath}`);

  if (failure) {
    console.error(`[acceptance] FAILED: ${failure.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[acceptance] PASSED (${checks.length} checks)`);
}

await main();
