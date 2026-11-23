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
 *   docs/evidence/browser-persist.png           the projects panel after the reload
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
  SELF_TEST_BUTTON,
  SUPPORT_PROBLEMS,
  ensureBooted,
  openDiagnostics,
  readStatusText,
} from "./lib/boot.ts";
import { sizeCommand, sizeFromTranscript, sizeLine, writeFileCommand } from "./lib/pty-channel.ts";
import {
  READ_MARKER,
  isFreshSave,
  persistToken,
  persistenceChecks,
  persistenceSkipReason,
  persistedFiles,
  readCommand,
  type PersistedFile,
  type PersistenceFacts,
} from "./lib/persist-check.ts";
import { runInTerminal, transcript } from "./lib/term-channel.ts";

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
/** A shell is spawned after the kernel is up; the guest's first `/bin/bash -l` takes a moment. */
const SHELL_TIMEOUT_MS = 120_000;
/** The manager polls the workspace every 1.5 s and debounces a save by 400 ms; 30 s is slack. */
const SAVE_CONFIRM_TIMEOUT_MS = 30_000;

/* The projects panel, as the browser renders it (goal `5db99b55`). These ids are asserted by
 * `tests/project-switcher.test.tsx`, so a rename breaks a unit test before it breaks this run. */
const PROJECTS_TOGGLE = "[data-testid=projects-toggle]";
const PROJECT_NAME_INPUT = "[data-testid=project-name]";
const PROJECT_CREATE_SUBMIT = "[data-testid=project-create-submit]";
const PROJECT_ROW = "[data-testid=project-row]";
const PROJECTS_STATUS = "[data-testid=projects-status]";
const PROJECTS_ACTIVE_NAME = "[data-testid=projects-active-name]";
/** The terminal panel says when its shell is attached; typing before that drops characters. */
const TERMINAL_READY = "[data-testid=terminal-panel][data-connection=connected]";

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

/**
 * What the persistence step measured. It carries the facts the pure checks read
 * (`scripts/lib/persist-check.ts`), plus the timings and the reload's boot path — so the report
 * can show the run's own numbers instead of asserting that they were fine.
 */
interface PersistenceMeasurement extends PersistenceFacts {
  files: PersistedFile[];
  guestBytes: Record<string, number | null>;
  rowsBeforeReload: string[];
  readAfterReload: Record<string, string>;
  rowsAfterReload: string[];
  /** The panel's own sentence before the reload, kept verbatim: it is what `isFreshSave` judged. */
  savedStatus: string | null;
  saveConfirmed: boolean;
  saveWaitMs: number;
  reloadBootPath: string;
  reloadWallClockMs: number;
  /** The screenshots written for this step, relative to `docs/`; empty when a check failed. */
  shots: string[];
}

interface Measurements {
  session: Session;
  boot: BootMeasurement | null;
  selfTest: SelfTestMeasurement | null;
  persistence: PersistenceMeasurement | null;
  /** Why the persistence step was not run, when it was not; null when it ran. */
  persistenceSkip: string | null;
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
    statusBar: (await readStatusText(page)) || null,
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

/** The project names the panel lists, read from the DOM even while the surface is closed. */
async function projectNames(page: Page): Promise<string[]> {
  const names = await page.locator("[data-testid=project-open]").allTextContents();
  return names.map((name) => name.trim()).filter((name) => name.length > 0);
}

/** The open project's name, which the panel prints after a middot; null when none is open. */
async function openProjectName(page: Page): Promise<string | null> {
  const raw = await text(page, PROJECTS_ACTIVE_NAME);
  if (raw === null) return null;
  const name = raw.replace(/^\u00b7\s*/, "").trim();
  return name.length === 0 ? null : name;
}

/**
 * Write one file into the guest and return the byte count the guest itself reported.
 *
 * Two lines per file, both short: the base64 payload and `wc -c`. The byte count is the
 * assertion — a dropped character produces a short file and a different count, and the retry is
 * for the dropped character `typeLine` did not catch.
 */
async function writesInGuest(page: Page, file: PersistedFile): Promise<number | null> {
  const commands = [writeFileCommand(file.path, file.content), sizeCommand(file.path)];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const answer = await runInTerminal(page, commands, sizeLine(file.path, file.bytes), 60_000);
    const seen = await transcript(page);
    const reported = sizeFromTranscript(seen, file.path, commands);
    if (answer.answered && reported !== null) return reported;
    console.log(`[acceptance] retrying the write of ${file.path} (attempt ${attempt})`);
  }
  return null;
}

/**
 * The persistence claim, measured end to end: create a project in the panel, write a project
 * file and a `netlify.toml` inside Linux, let the manager save, reload the page, and read both
 * files back out of the guest.
 *
 * Why a reload proves the *store* and not just the VM: `src/env/boot.ts` builds a fresh host-side
 * workspace from `DEFAULT_PROJECT_TREE` on every boot, so the only way a file this run invented
 * can be in `/workspace` afterwards is `ProjectManager.restore()` reading it back from
 * `IndexedDbProjectStore`. Neither `persist-check.txt` nor `netlify.toml` is in that starter tree.
 *
 * The tokens never appear in the typed text (the bytes travel as base64), so a read-back cannot
 * be satisfied by the shell echoing the command that was supposed to write it.
 */
async function measuresPersistence(
  page: Page,
  remote: boolean,
): Promise<{ measurement: PersistenceMeasurement | null; skip: string | null }> {
  const toggleCount = await page.locator(PROJECTS_TOGGLE).count();
  const skip = persistenceSkipReason(toggleCount, remote);
  if (skip !== null) {
    console.log(`[acceptance] not measuring project persistence: ${skip}`);
    return { measurement: null, skip };
  }

  const token = persistToken();
  const files = persistedFiles(token);
  const project = `persist-${token.slice("larpable-persist-".length)}`;

  // ---- create the project through the panel, the way a person does
  await page.locator(PROJECTS_TOGGLE).click();
  await page.locator(PROJECT_NAME_INPUT).fill(project);
  await page.locator(PROJECT_CREATE_SUBMIT).click();
  await page.locator(PROJECT_ROW).filter({ hasText: project }).first().waitFor({ timeout: 30_000 });
  const rowsBeforeReload = await projectNames(page);
  // Close the surface: the terminal below must be pressable rather than covered by the popover.
  await page.keyboard.press("Escape");

  await page.locator(TERMINAL_READY).waitFor({ timeout: SHELL_TIMEOUT_MS });

  // ---- write both files inside Linux, and have Linux count them
  const guestBytes: Record<string, number | null> = {};
  for (const file of files) {
    guestBytes[file.path] = await writesInGuest(page, file);
  }

  // ---- wait for the manager's own save, judged by the panel's sentence
  const saveStartedAt = Date.now();
  let savedStatus: string | null = null;
  let saveConfirmed = false;
  while (Date.now() - saveStartedAt < SAVE_CONFIRM_TIMEOUT_MS) {
    savedStatus = await text(page, PROJECTS_STATUS);
    if (isFreshSave(savedStatus)) {
      saveConfirmed = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  const saveWaitMs = Date.now() - saveStartedAt;

  // ---- the reload: a new document, a new kernel, a fresh workspace
  const reloadStartedAt = Date.now();
  await page.reload({ waitUntil: "load" });
  const reboot = await ensureBooted(page, {
    timeoutMs: BOOT_TIMEOUT_MS,
    log: (line) => {
      console.log(`[acceptance] reload: ${line}`);
    },
  });
  const reloadWallClockMs = Date.now() - reloadStartedAt;
  await page.locator(TERMINAL_READY).waitFor({ timeout: SHELL_TIMEOUT_MS });

  const readAfterReload: Record<string, string> = {};
  for (const file of files) {
    const answer = await runInTerminal(page, [readCommand(file.path)], READ_MARKER, 60_000);
    readAfterReload[file.path] = answer.answered
      ? await transcript(page)
      : `(the read-back of ${file.path} never answered; ${answer.tail})`;
  }

  await page.locator(PROJECTS_TOGGLE).click();
  const rowsAfterReload = await projectNames(page);
  const activeAfterReload = await openProjectName(page);

  return {
    measurement: {
      projectName: project,
      files,
      guestBytes,
      rowsBeforeReload,
      readAfterReload,
      rowsAfterReload,
      activeAfterReload,
      savedStatus,
      saveConfirmed,
      saveWaitMs,
      reloadBootPath: reboot.path,
      reloadWallClockMs,
      shots: [],
    },
    skip: null,
  };
}

async function unsupportedPath(page: Page): Promise<UnsupportedMeasurement> {
  await page.goto(`${baseUrl}/?simulateSupport=no-jspi`, { waitUntil: "load" });

  /*
   * Where the problems render depends on the build, not on the app: in the current one the
   * environment card is `compact` inside the debug popover, so the card's own `support-problems`
   * alert never renders and the popover's *Requirements* section lists the same strings instead.
   * A deployment can still be the older shape, where the card rendered in full and the popover
   * had no Requirements section — measured: waiting only for `requirement-problems` timed out
   * 30 s against the live site *after* every boot and self-test check had passed, which reads as
   * an app failure and is really the script asking for one build's markup.
   *
   * `SUPPORT_PROBLEMS` is the union of both, and the surface stays in the DOM while closed, so the
   * wait is on the list being *attached*; the popover is then opened to read it as a person would.
   */
  const problems = page.locator(SUPPORT_PROBLEMS);
  await problems.first().waitFor({ state: "attached", timeout: 30_000 });
  await openDiagnostics(page);

  // Read the popover's list when this build has it, otherwise the card's own alert.
  const requirementList = page.locator("[data-testid=requirement-problems]");
  const problemsText = (
    (await requirementList.count()) > 0
      ? await requirementList.first().innerText()
      : await problems.first().innerText()
  ).trim();
  const heading = (await text(page, "[data-testid=requirement-problems] li")) ?? "";
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
  const { session, boot, selfTest, persistence, persistenceSkip, unsupported } = measurements;
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

  if (persistence) {
    const bytes = (count: number | null) => (count === null ? "the guest never answered" : `${String(count)} bytes`);
    lines.push(
      "## Project persistence across a page reload",
      "",
      "The claim measured here: a file written inside Linux, and a real `netlify.toml`, are still",
      "in `/workspace` after the page reloads. It can only be true through the project store —",
      "every boot builds a fresh host-side workspace from `DEFAULT_PROJECT_TREE`",
      "(`src/env/boot.ts`), and neither file is in that tree — so a pass means",
      "`IndexedDbProjectStore` + `WorkspaceBridge` put the bytes back, not that a VM remembered",
      "them.",
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Project created in the panel | \`${persistence.projectName}\` |`,
      `| Files written inside the guest | ${persistence.files.map((file) => `\`${file.path}\` (${String(file.bytes)} bytes)`).join(", ")} |`,
      `| Bytes the guest confirmed with \`wc -c\` | ${persistence.files.map((file) => `\`${file.path}\`: ${bytes(persistence.guestBytes[file.path] ?? null)}`).join("; ")} |`,
      `| Panel status before the reload | ${persistence.savedStatus ?? "not rendered"} |`,
      `| A save finished after the writes | ${persistence.saveConfirmed ? "yes" : "no"} (waited ${String(persistence.saveWaitMs)} ms) |`,
      `| Projects in the panel before the reload | ${persistence.rowsBeforeReload.join(", ") || "(none)"} |`,
      `| Boot path on the reload | ${persistence.reloadBootPath} |`,
      `| Reload to Ready | ${String(persistence.reloadWallClockMs)} ms |`,
      `| Projects in the panel after the reload | ${persistence.rowsAfterReload.join(", ") || "(none)"} |`,
      `| Open project after the reload | ${persistence.activeAfterReload ?? "none"} |`,
      "",
      "Read back inside the guest, after the reload:",
      "",
      ...persistence.files.flatMap((file) => [
        `\`cat ${file.path}\`:`,
        "",
        "```",
        (persistence.readAfterReload[file.path] ?? "(no read-back)")
          .split(/\r?\n/)
          .filter((line) => line.trim().length > 0)
          .slice(-6)
          .join("\n"),
        "```",
        "",
      ]),
      ...persistence.shots.map((shot) => `![Projects panel after the reload](evidence/${shot})`),
      "",
    );
  } else {
    lines.push(
      "## Project persistence across a page reload — not measured",
      "",
      persistenceSkip ?? "the persistence step did not run",
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
  } else {
    // Said out loud rather than left as a missing section: a reader must be able to tell "this run
    // did not measure it" from "this run measured it and it passed".
    lines.push(
      "## Unsupported browser path — not measured",
      "",
      "`?simulateSupport=no-jspi` is a dev-only probe simulation, so a run against a deployment",
      "measures the boot path only. Run `bun run acceptance:browser` against a dev server for",
      "this path; `bun run acceptance:autoboot` covers it on every run.",
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
    persistence: remote ? "production-persist.png" : "browser-persist.png",
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
    persistence: null,
    persistenceSkip: null,
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

    /*
     * Persistence, measured before the unsupported-browser pass because that pass navigates away
     * and would take a booted machine with it. The checks themselves live in
     * `scripts/lib/persist-check.ts` and are unit tested there; a failing check throws through
     * `expect`, so the report still records which one failed.
     */
    const persistence = await measuresPersistence(page, remote);
    measurements.persistence = persistence.measurement;
    measurements.persistenceSkip = persistence.skip;
    if (persistence.measurement !== null) {
      for (const check of persistenceChecks(persistence.measurement)) {
        expect(check.name, check.ok, check.detail);
      }
      const shot = evidenceNames.persistence;
      await page.screenshot({ path: join(evidenceDir, shot), fullPage: true });
      persistence.measurement.shots = [shot];
    }

    /*
     * The `?simulateSupport=no-jspi` path is a *dev-only* probe simulation (see
     * `src/env/support.ts`): it exists because a CI browser cannot be made to lack
     * `WebAssembly.Suspending`. It is skipped against a deployment on purpose — the deployed
     * build's popover is whatever was last pushed, so an assertion about *where* it renders its
     * problems measures the deploy's age rather than the app's behaviour, and a red verdict here
     * would say "the deploy is broken" when the deploy had just booted Linux and round-tripped
     * `/workspace` twice in the checks above. What a production run measures is the boot path;
     * what it does not measure is written into the report instead of being quietly implied.
     */
    if (remote) {
      console.log(
        "[acceptance] skipping the unsupported-browser path: it is a dev-only probe simulation",
      );
    } else {
      measurements.unsupported = await unsupportedPath(page);
      await page.screenshot({ path: join(evidenceDir, evidenceNames.unsupported), fullPage: true });
    }
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
