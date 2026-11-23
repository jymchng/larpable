/**
 * Getting a file into a guest, through a terminal, without lying about it.
 *
 * The acceptance run has no filesystem API into the VM: the guest is reached the way a user
 * reaches it, by typing into a pty. That channel loses characters. Typing a nine-line
 * heredoc at 2 ms per character produced three consecutive runs that stopped at "the guest
 * accepted dist/index.html" while the guest held a truncated document, because a dropped
 * character inside a heredoc is silent — the shell happily writes the short file.
 *
 * So this module does two things and nothing else:
 *
 * 1. **carries bytes without quoting hazards.** `printf %s '<base64>' | base64 -d > path`
 *    is one short line, and base64's alphabet (`A–Z a–z 0–9 + / =`) contains no shell
 *    metacharacter, so a stylesheet full of quotes and a script full of `$` need no escaping
 *    at all.
 * 2. **makes the guest state the result.** A second line prints the path and the byte count
 *    `wc -c` measured *inside* the guest. That number is the assertion: a truncated write
 *    prints a smaller count and fails the run.
 *
 * The marker words are assembled by `printf` from separate arguments (`'LARPABLE-%s'` and
 * `SIZE`), so the marker never appears in the *typed* text — only in the output. That
 * distinction matters: an earlier version of the run reported a write as answered when the
 * only occurrence of its marker was the shell's echo of the command that was supposed to
 * produce it. `sizeFromTranscript` therefore ignores echoed command lines, and
 * `isEchoedCommand` is what it uses to tell them apart.
 */

/** The marker word `printf` assembles. Split so it exists only in output, never in a command. */
const MARKER_HEAD = "LARPABLE-%s";

/** The single command that writes `content` to `path` inside the guest. */
export function writeFileCommand(path: string, content: string): string {
  const base64 = Buffer.from(content, "utf8").toString("base64");
  return `printf %s '${base64}' | base64 -d > ${path}`;
}

/** The command that makes the guest report how many bytes it actually stored. */
export function sizeCommand(path: string): string {
  return `printf '${MARKER_HEAD} %s %s\\n' SIZE ${path} "$(wc -c < ${path} | tr -d ' ')"`;
}

/** The exact output line a successful write produces. */
export function sizeLine(path: string, bytes: number): string {
  return `LARPABLE-SIZE ${path} ${bytes}`;
}

/**
 * True when `tail` shows `line` echoed in full by the pty.
 *
 * Whitespace is removed from both sides rather than normalised, because the terminal mirror
 * hard-wraps long lines: a 380-character base64 command arrives with a `\r` every 80
 * columns (measured — `…IGNo\ryc2V0…`), and treating that `\r` as a space makes a
 * perfectly good echo look like a corrupted one. Spaces carry no meaning in the commands
 * this is used on, so dropping them costs nothing and removes the wrap from the comparison.
 */
export function echoesWholeLine(tail: string, line: string): boolean {
  const squeeze = (value: string) => value.replace(/\s+/g, "");
  return squeeze(tail).includes(squeeze(line));
}

/**
 * True when a transcript line is the shell's echo of a typed command rather than output.
 *
 * The shell prints the prompt and then the command text, so an echoed line *ends* with the
 * command. Output never does. This is a heuristic, and it is only used for markers whose
 * own text cannot be typed (see the module note) — but it is the difference between a
 * passing run and a run that passes because it read its own instruction back.
 */
export function isEchoedCommand(line: string, command: string): boolean {
  const normalise = (value: string) => value.replace(/\s+/g, " ").trim();
  const normalisedLine = normalise(line);
  const normalisedCommand = normalise(command);
  return normalisedCommand.length > 0 && normalisedLine.endsWith(normalisedCommand);
}

/**
 * The byte count the guest reported for `path`, or null.
 *
 * Only a line that is *output* counts: a line that merely echoes a command mentioning the
 * marker is rejected, which is the failure mode this whole module exists to prevent.
 */
export function sizeFromTranscript(
  transcript: string,
  path: string,
  commands: readonly string[],
): number | null {
  const prefix = `LARPABLE-SIZE ${path} `;
  for (const line of transcript.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    if (commands.some((command) => isEchoedCommand(trimmed, command))) continue;
    const reported = Number.parseInt(trimmed.slice(prefix.length).trim(), 10);
    if (Number.isFinite(reported)) return reported;
  }
  return null;
}
