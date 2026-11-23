/**
 * Typing into the guest's pty from an acceptance script, without lying about what arrived.
 *
 * An acceptance run has no filesystem API into the VM: the guest is reached the way a user
 * reaches it, by typing into a terminal. That channel loses characters under load — measured,
 * not assumed: typing a nine-line heredoc at 2 ms per character left a truncated file in the
 * guest three runs in a row, and the shell happily wrote it. So the rules are:
 *
 * 1. **Do not press Enter on a line the pty did not echo whole.** `typeLine` types, reads the
 *    terminal's DOM mirror back, and only then presses Enter; a partial line is killed with
 *    `Ctrl-U` and retyped, slower each attempt. The cost is a few seconds, and it removes the
 *    failure mode where a short command — a *different* command — runs instead.
 * 2. **Wait for a marker the command produces, never for a fixed sleep.** A sleep is either
 *    wasted on every call or too short on the first, and the first is the case that matters.
 * 3. **Keep the payload out of the typed text.** `scripts/lib/pty-channel.ts` carries bytes as
 *    base64 and makes the guest print its own `wc -c`, so an assertion cannot be satisfied by
 *    the shell echoing the instruction back.
 *
 * This module is the page-side half of that pair; `pty-channel.ts` is the text half and is
 * importable without Playwright. Extracted from `scripts/preview-browser-acceptance.ts`, which
 * had the only copy, when the boot acceptance run needed the same channel to prove that a file
 * written in `/workspace` survives a page reload.
 */

import type { Page } from "playwright-core";

import { echoesWholeLine } from "./pty-channel.ts";

/** The transcript the terminal component mirrors into the DOM, so a run can assert on it. */
export async function transcript(page: Page): Promise<string> {
  return (await page.locator("[data-testid=terminal-output]").first().textContent()) ?? "";
}

/**
 * Type a command into the live pty and wait for a marker to appear in the transcript.
 *
 * The marker is produced by the command itself (`printf`), not by a sleep. Returns the last
 * transcript line that carried the marker, plus a tail for a failure message, so a red run can
 * say what the guest actually printed.
 */
export async function runInTerminal(
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
 * `delay` grows per attempt because a dropped character is a load problem, and load is
 * transient: the third attempt at 26 ms per character has always been enough in practice.
 * xterm mirrors its buffer into the DOM on animation frames, so the echo trails the keystrokes
 * — hence the poll rather than a single read, which would call a slow render a lost character.
 */
export async function typeLine(
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
