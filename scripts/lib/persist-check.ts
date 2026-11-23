/**
 * What "the project survived a reload" means, as pure functions.
 *
 * The boot acceptance run has to prove a claim it cannot see directly: a file written inside
 * Linux is still there after the page reloads. Three things make that provable rather than
 * plausible, and each is a decision worth testing without a browser:
 *
 * 1. **The workspace does not persist by itself.** `src/env/boot.ts` builds a fresh host-side
 *    `MemoryFs` seeded from `DEFAULT_PROJECT_TREE` on every boot, so a file this run writes can
 *    only be back after a reload because `ProjectManager.restore()` read it out of the project
 *    store. The fixture content is therefore *not* in the starter tree: `persist-check.txt` is a
 *    name the default project has never had, and `netlify.toml` carries a unique comment.
 * 2. **The token never appears in the typed text.** The bytes travel as base64
 *    (`scripts/lib/pty-channel.ts`), so the read-back cannot be satisfied by the shell echoing
 *    the command.
 * 3. **The save is confirmed by its own clock, not by a sleep.** The panel prints "Saved 3 s
 *    ago"; `savedAgeSeconds` turns that sentence into a number, and `isFreshSave` answers the
 *    only question that matters before reloading — did a save finish *after* the guest's writes?
 *
 * The checks are assembled here rather than inline in the script so the two stale-save cases — a
 * project created but not saved, and a save that predates the guest's writes — are unit tests
 * with the measured strings, not something rediscovered on a slow run.
 */

/** The shape `runInTerminal` reports; declared structurally so this module needs no Playwright. */
export interface TerminalAnswer {
  answered: boolean;
  line: string | null;
  tail: string;
}

export interface PersistedFile {
  /** Workspace-relative, the way a terminal user writes it. */
  path: string;
  content: string;
  /**
   * The mark this file's content carries, unique per file *and* per run.
   *
   * Unique per file because the read-back is asserted against a terminal transcript, and the
   * previous file's token is still on screen when the next one is read. Unique per run because a
   * second run against the same browser profile must not be satisfied by the first run's file.
   */
  marker: string;
  /** The byte count the guest must report for `content`, counted here and asserted there. */
  bytes: number;
}

export interface PersistenceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** The marker a read-back ends with, so a truncated `cat` cannot look like an absent file. */
export const READ_MARKER = "LARPABLE-READ DONE";

/**
 * A token that is unique per run and safe in a shell word, a file name and a TOML comment.
 *
 * Lower-case base36 because `netlify.toml` is a config a human may read, and the token is also
 * used inside the project name, which is rendered in the panel.
 */
export function persistToken(now: number = Date.now()): string {
  return `larpable-persist-${now.toString(36)}`;
}

/**
 * The two files this run writes, with the byte counts the guest has to confirm.
 *
 * `netlify.toml` gets a real `[build]` table as well as the token: a file that persists but says
 * nothing would prove too little, since the point of the project store is that a person's
 * project — config included — comes back intact.
 */
export function persistedFiles(token: string): PersistedFile[] {
  const contents: Array<{ path: string; marker: string; content: string }> = [
    {
      path: "persist-check.txt",
      marker: `${token}-file`,
      content: `${token}-file\nwritten inside Linux, read back after a reload\n`,
    },
    {
      path: "netlify.toml",
      marker: `${token}-toml`,
      content: [
        `# ${token}-toml`,
        "# Written in the guest's /workspace by scripts/browser-acceptance.ts.",
        "[build]",
        '  command = "npm run build"',
        '  publish = "dist"',
        "",
      ].join("\n"),
    },
  ];

  return contents.map((file) => ({ ...file, bytes: Buffer.byteLength(file.content, "utf8") }));
}

/**
 * The command that prints a file and then a marker, so an empty or truncated read is visible.
 *
 * `cat` alone cannot distinguish "the file is gone" from "the transcript has not caught up":
 * both look like no new output. The trailing `printf` is the arrival signal.
 */
export function readCommand(path: string): string {
  return `cat ${path}; printf '%s\\n' '${READ_MARKER}'`;
}

/**
 * Seconds since the last save, read from the panel's own sentence.
 *
 * The panel prints `Saved just now` / `Saved 12 s ago` / `Saved 3 min ago` / `Saved 2 h ago`
 * (`describeProjectStatus` in `src/ui/project-switcher.tsx`). Only the buckets the confirmation
 * needs are decoded; anything else returns null, which the caller treats as "not yet confirmed"
 * rather than as success.
 */
export function savedAgeSeconds(text: string | null): number | null {
  if (text === null) return null;
  // The panel prints the status and then the open project's name after a middot
  // (`Saved just now · persist-abc`), so the name must not be part of the match.
  const [status = ""] = text.split("·");
  const trimmed = status.trim();
  if (trimmed === "Saved just now") return 0;
  const match = /^Saved (\d+) (s|min|h) ago$/.exec(trimmed);
  if (match === null) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  return unit === "s" ? value : unit === "min" ? value * 60 : value * 3_600;
}

/**
 * True when the panel's sentence reports a save younger than `withinSeconds`.
 *
 * The question is not "has anything ever saved" — creating the project saves immediately — but
 * "did a save finish after the writes this run made". A save older than the writes leaves the
 * new bytes only in the workspace, where the next reload would lose them.
 */
export function isFreshSave(text: string | null, withinSeconds = 2): boolean {
  const age = savedAgeSeconds(text);
  return age !== null && age <= withinSeconds;
}

export interface PersistenceFacts {
  projectName: string;
  files: readonly PersistedFile[];
  /** Project names in the panel, read before the reload. */
  rowsBeforeReload: readonly string[];
  /** What `wc -c` printed inside the guest for each file, keyed by path; null when unanswered. */
  guestBytes: Readonly<Record<string, number | null>>;
  /**
   * The transcript tail after each write attempt, keyed by path.
   *
   * Only used to explain a failure: "the guest never answered" on its own does not say whether
   * the terminal showed a prompt, an error, or nothing at all, and that difference is the whole
   * diagnosis. Optional so a test can state the facts without inventing a transcript.
   */
  guestTails?: Readonly<Record<string, string>>;
  /**
   * Whether the panel ever reported a save younger than the writes (`isFreshSave`).
   *
   * Measured separately from the read-back because it is a different claim: the files came back
   * *because* a save stored them, and a run that reloads on a creation save would be testing
   * luck. Reported in the table either way, but a false here has to fail the run.
   */
  saveConfirmed: boolean;
  /**
   * The transcript captured immediately after each read-back, keyed by path, taken *after* the
   * reload. A file missing from this map was never read back.
   */
  readAfterReload: Readonly<Record<string, string>>;
  /** Project names in the panel, read after the reload. */
  rowsAfterReload: readonly string[];
  /** The open project's name after the reload, or null when the panel reports none. */
  activeAfterReload: string | null;
}

/**
 * The verdicts, in the order a reader needs them: it was created, it reached the disk, it was
 * saved, it came back twice, and the panel still says it is open.
 */
export function persistenceChecks(facts: PersistenceFacts): PersistenceCheck[] {
  const checks: PersistenceCheck[] = [];

  checks.push({
    name: "persistence: project created through the panel",
    ok: facts.rowsBeforeReload.includes(facts.projectName),
    detail: `rows before the reload: ${listOrNone(facts.rowsBeforeReload)}`,
  });

  for (const file of facts.files) {
    const reported = facts.guestBytes[file.path] ?? null;
    const tail = facts.guestTails?.[file.path] ?? "";
    checks.push({
      name: `persistence: /workspace/${file.path} holds the bytes the host sent`,
      ok: reported === file.bytes,
      // "never answered" and "reported 12 bytes" are different failures - a lost command is not a
      // truncated write - so the two cases read differently rather than both saying "nothing".
      detail:
        reported === null
          ? `the guest never answered; host sent ${String(file.bytes)} bytes; transcript tail: ${tailOf(tail)}`
          : `guest reported ${String(reported)} bytes, host sent ${String(file.bytes)} bytes`,
    });
  }

  checks.push({
    name: "persistence: a save finished after the guest's writes",
    ok: facts.saveConfirmed,
    detail: facts.saveConfirmed
      ? "the panel reported a fresh save before the reload"
      : "no save finished after the writes, so the reload could only find what the creation save stored",
  });

  for (const file of facts.files) {
    const seen = facts.readAfterReload[file.path] ?? "";
    checks.push({
      name: `persistence: /workspace/${file.path} survived a full page reload`,
      ok: seen.includes(file.marker),
      detail: seen.includes(file.marker)
        ? `read back after the reload, containing ${file.marker}`
        : `no read-back of ${file.path} contained ${file.marker}; transcript tail: ${tailOf(seen)}`,
    });
  }

  checks.push({
    name: "persistence: the reloaded app still lists the project, and it is the open one",
    ok: facts.rowsAfterReload.includes(facts.projectName) && facts.activeAfterReload === facts.projectName,
    detail: `rows after the reload: ${listOrNone(facts.rowsAfterReload)}; open project: ${facts.activeAfterReload ?? "none"}`,
  });

  return checks;
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "(none)" : values.join(", ");
}

function tailOf(transcript: string): string {
  const collapsed = transcript.replace(/\s+/g, " ").trim();
  return collapsed.length === 0 ? "(empty)" : collapsed.slice(-200);
}

/**
 * Why the run cannot measure persistence against this target, or null when it can.
 *
 * A deployment is whatever was last pushed: a build that predates the projects panel has no
 * glyph to press, and reporting that as "persistence is broken" would blame the app for the age
 * of a deploy. The run says it did not measure it, and why, which is the difference between a
 * gap and a false claim.
 */
export function persistenceSkipReason(projectsToggleCount: number, remote: boolean): string | null {
  if (projectsToggleCount > 0) return null;
  return remote
    ? "the deployed build has no projects control (it predates the panel, or the panel was removed); run this against a dev server"
    : "the app has no projects control any more (the header surface was removed on request), so this check has no panel to drive";
}
