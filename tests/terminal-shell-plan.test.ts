/**
 * Which shell the terminal opens, and why that is not an arbitrary default.
 *
 * The bug these tests exist to prevent was measured, not imagined: the Debian image's
 * PS1 is bash-style (`\[\033[36m\]\w … ⇒`), the adapter spawned `/bin/sh -l`, dash
 * printed every escape verbatim, and the terminal showed
 *
 *     \[\033[36m\]\w \[\033[35m\]⇒\[\033[0m\]
 *
 * instead of `/workspace ⇒`. So "which program runs" is asserted here, including the
 * fallback that keeps an image without bash readable.
 */

import { describe, expect, it } from "vitest";

import {
  POSIX_SAFE_PROMPT,
  SHELL_PROBE_COMMAND,
  parseBashProbe,
  planShellAttempts,
} from "@/env/shell";

describe("planShellAttempts", () => {
  it("opens bash as a login, interactive shell when the guest has one", () => {
    const attempts = planShellAttempts({ hasBash: true });

    // `-l` loads /etc/profile, where the image defines its prompt; `-i` makes the
    // shell interactive by request instead of by pty-detection luck.
    expect(attempts[0]).toEqual({ file: "/bin/bash", args: ["-li"] });
  });

  it("returns a dash fallback behind bash, for an image whose bash cannot spawn", () => {
    const attempts = planShellAttempts({ hasBash: true });

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.file).toBe("/bin/sh");
    expect(attempts[1]?.args).toEqual(["-i"]);
  });

  it("never lets a login dash inherit the image's bash-only prompt", () => {
    // The whole bug in one assertion: `-l` would re-read /etc/profile and put
    // `\[\033[36m\]\w` back on screen, because dash does not expand it.
    for (const hasBash of [true, false]) {
      for (const attempt of planShellAttempts({ hasBash })) {
        if (attempt.file === "/bin/sh") expect(attempt.args).not.toContain("-l");
      }
    }
  });

  it("sets a prompt that needs no expansion when bash is absent", () => {
    const attempts = planShellAttempts({ hasBash: false });

    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ file: "/bin/sh", args: ["-i"] });
    expect(attempts[0]?.env?.PS1).toBe(POSIX_SAFE_PROMPT);
  });

  it("keeps the fallback prompt free of bash-only escapes", () => {
    // Anything a non-bash shell would print literally: `\[`, `\]`, `\033`, `\w`, `\u`.
    expect(POSIX_SAFE_PROMPT).not.toMatch(/\\[\[]|\\[\]uw]|\\033|\\e/);
    expect(POSIX_SAFE_PROMPT).not.toMatch(/\x1b/);
    expect(POSIX_SAFE_PROMPT.trim().length).toBeGreaterThan(0);
  });

  it("keeps the caller's environment in the fallback, adding only PS1", () => {
    const attempts = planShellAttempts({ hasBash: false, env: { FOO: "bar" } });

    expect(attempts[0]?.env).toEqual({ FOO: "bar", PS1: POSIX_SAFE_PROMPT });
  });

  it("lets an explicit PS1 win over the fallback", () => {
    const attempts = planShellAttempts({ hasBash: false, env: { PS1: "mine$ " } });

    expect(attempts[0]?.env?.PS1).toBe("mine$ ");
  });

  it("does not invent a prompt when bash opens, so the image's own prompt is used", () => {
    const attempts = planShellAttempts({ hasBash: true });

    expect(attempts[0]?.env).toBeUndefined();
  });

  it("runs a caller-named program verbatim, with no correction and no fallback", () => {
    const attempts = planShellAttempts({
      hasBash: true,
      file: "/bin/zsh",
      args: ["-i"],
      env: { PS1: "zsh% " },
    });

    expect(attempts).toEqual([{ file: "/bin/zsh", args: ["-i"], env: { PS1: "zsh% " } }]);
  });

  it("defaults the flags of a caller-named program to a login, interactive shell", () => {
    expect(planShellAttempts({ hasBash: true, file: "/bin/fish" })).toEqual([
      { file: "/bin/fish", args: ["-li"] },
    ]);
  });
});

describe("parseBashProbe", () => {
  it("reads the path the probe printed", () => {
    expect(parseBashProbe("larpable-ok /usr/bin/bash")).toBe(true);
    expect(parseBashProbe("some banner\r\nlarpable-ok /bin/bash\r\n")).toBe(true);
  });

  it("treats the probe's 'none' answer as no bash", () => {
    expect(parseBashProbe("larpable-ok none")).toBe(false);
  });

  it("refuses to guess from anything that is not an absolute path to bash", () => {
    // Guessing wrong puts the unreadable prompt back in front of the user, so the
    // default has to be "no bash" rather than "probably".
    for (const stdout of [
      "",
      "larpable-ok",
      "larpable-ok bash",
      "larpable-ok /usr/bin/bash.exe",
      "larpable-ok /usr/bin/rbash",
      "larpable-ok  ",
      "garbage /bin/bash",
    ]) {
      expect(parseBashProbe(stdout), JSON.stringify(stdout)).toBe(false);
    }
  });
});

describe("SHELL_PROBE_COMMAND", () => {
  it("answers both questions the boot needs, in one process", () => {
    expect(SHELL_PROBE_COMMAND).toContain("larpable-ok");
    expect(SHELL_PROBE_COMMAND).toContain("command -v bash");
    // A missing bash must not fail the probe: the shell still has to be verified.
    expect(SHELL_PROBE_COMMAND).toContain("||");
  });
});
