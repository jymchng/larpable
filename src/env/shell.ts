/**
 * Which shell a terminal opens, and what its prompt may contain.
 *
 * This module exists because of a measured bug, not a preference. The Debian image
 * ships a **bash-style** prompt:
 *
 *     PS1='\[\033[36m\]\w \[\033[35m\]⇒\[\033[0m\] '
 *
 * The adapter used to spawn `/bin/sh -l`. On Debian `/bin/sh` is dash, which expands
 * none of `\[`, `\]`, `\033` or `\w`, so it printed the string verbatim and the user
 * saw escape litter instead of `/workspace ⇒`:
 *
 *     \[[36m\]\w \[[35m\]⇒\[[0m\]
 *
 * (Measured in a real browser: `scripts/probe-terminal.ts`.) No prompt, nothing
 * meaningful to select. The shell was wrong, not the terminal.
 *
 * The rules below encode what the image's prompt requires:
 *
 * - **bash when it exists**, as a login *and* interactive shell (`-li`). `-l` loads
 *   `/etc/profile`, which is where the image defines that prompt; `-i` makes the shell
 *   interactive by explicit request rather than by luck of pty detection.
 * - **dash never inherits that prompt.** On an image without bash the fallback is
 *   `/bin/sh -i`: interactive, but *not* a login shell, so `/etc/profile` cannot
 *   overwrite `PS1` with bash-only escapes. The prompt is set in the environment to a
 *   string that needs no expansion at all, which every POSIX shell prints as written.
 * - **the caller wins.** An explicit `file`/`args` is used exactly as given: a test or a
 *   power user asking for `/bin/zsh -i` must get that, not a corrected guess.
 */

/** A prompt that is correct in any POSIX shell: no escapes for anyone to not expand. */
export const POSIX_SAFE_PROMPT = "larpable$ ";

/** The marker every boot probe looks for. */
export const SHELL_PROBE_MARKER = "larpable-ok";

/**
 * The boot probe. It answers two questions in one process: *can the guest run a shell*
 * and *is there a bash to open a terminal with*. `command -v` is a builtin, so this costs
 * nothing beyond the shell that already had to run; a missing bash prints `none` rather
 * than failing the probe.
 */
export const SHELL_PROBE_COMMAND =
  "printf 'larpable-ok %s' \"$(command -v bash 2>/dev/null || echo none)\"";

/** One way to start a terminal, in the order worth trying. */
export interface ShellAttempt {
  file: string;
  args: readonly string[];
  /** Environment for the guest program. `PS1` here only appears in the fallback. */
  env?: Record<string, string>;
}

export interface ShellPlanInput {
  /** True when the boot probe found an executable bash in the guest. */
  hasBash: boolean;
  /** Caller-requested program, used verbatim when present. */
  file?: string;
  args?: readonly string[];
  env?: Record<string, string>;
}

/** Flags for a shell the caller named but did not fully specify. */
const EXPLICIT_ARGS: readonly string[] = ["-li"];

/**
 * The shells to try, best first. More than one attempt only matters when the preferred
 * program exists but cannot actually be spawned (a broken image, an exec that fails);
 * `openShell` walks the list and reports every attempt in its error.
 */
export function planShellAttempts(input: ShellPlanInput): ShellAttempt[] {
  if (input.file !== undefined) {
    return [{ file: input.file, args: input.args ?? EXPLICIT_ARGS, ...envOf(input.env) }];
  }

  const fallback: ShellAttempt = {
    file: "/bin/sh",
    // `-i` without `-l` on purpose: see the header. A login dash re-reads the image's
    // profile and would put the bash-only PS1 straight back on screen.
    args: ["-i"],
    env: { ...input.env, PS1: input.env?.PS1 ?? POSIX_SAFE_PROMPT },
  };

  if (!input.hasBash) return [fallback];

  return [
    { file: "/bin/bash", args: ["-li"], ...envOf(input.env) },
    fallback,
  ];
}

function envOf(env: Record<string, string> | undefined): { env?: Record<string, string> } {
  return env ? { env } : {};
}

/**
 * Read the bash answer out of the probe's output.
 *
 * Deliberately strict: only an absolute path ending in `bash` counts as "there is a
 * bash". Anything else — `none`, an empty string, a half-written line, a login shell's
 * banner text — means the fallback, because guessing wrong puts the unreadable prompt
 * back in front of the user.
 */
export function parseBashProbe(stdout: string): boolean {
  for (const line of stdout.split(/\r?\n/)) {
    const at = line.indexOf(SHELL_PROBE_MARKER);
    if (at === -1) continue;
    const answer = line.slice(at + SHELL_PROBE_MARKER.length).trim();
    return /^\/(?:[^\s/]+\/)*bash$/.test(answer);
  }
  return false;
}
