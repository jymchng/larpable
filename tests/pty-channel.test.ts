/**
 * The acceptance run's only channel into the guest, tested without a guest.
 *
 * The failure these tests exist for is not an exception: it is a run that reports success
 * because it read its own instruction back. Three previous acceptance runs stopped at "the
 * guest accepted dist/index.html" with a truncated file on disk, so the properties that
 * matter are (a) a file's bytes survive the command line, and (b) a marker only counts when
 * the *guest* printed it.
 */

import { describe, expect, it } from "vitest";

import {
  echoesWholeLine,
  isEchoedCommand,
  sizeCommand,
  sizeFromTranscript,
  sizeLine,
  writeFileCommand,
} from "../scripts/lib/pty-channel";

/** The payload a command is carrying, decoded the way the guest's `base64 -d` would. */
function payloadOf(command: string): string {
  const match = /printf %s '([A-Za-z0-9+/=]*)' \| base64 -d > /.exec(command);
  if (match === null) throw new Error(`not a write command: ${command}`);
  return Buffer.from(match[1] as string, "base64").toString("utf8");
}

describe("writeFileCommand", () => {
  it("carries the exact bytes, including quotes, dollars and backticks", () => {
    const content = [
      '<link rel="stylesheet" href="/assets/index-abc123.css">',
      "const template = `a ${b} $HOME`;",
      "body::before { content: 'answer='; }",
      "",
    ].join("\n");

    const command = writeFileCommand("dist/index.html", content);
    expect(payloadOf(command)).toBe(content);
  });

  it("is one line, so a dropped character cannot silently end a heredoc early", () => {
    const content = `${Array.from({ length: 40 }, (_, i) => `<div id="row-${i}"></div>`).join("\n")}\n`;
    const command = writeFileCommand("dist/index.html", content);
    expect(command).not.toContain("\n");
    expect(payloadOf(command)).toBe(content);
  });

  it("needs no quoting of its own: base64's alphabet holds no shell metacharacter", () => {
    const command = writeFileCommand("dist/assets/index-def456.js", "x".repeat(300));
    const payload = /printf %s '([^']*)'/.exec(command)?.[1] ?? "";
    expect(payload.length).toBeGreaterThan(0);
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+$/);
  });
});

describe("the size marker", () => {
  const path = "dist/index.html";
  const expected = 412;

  it("is never spelled out in the command that produces it", () => {
    // This is the whole trick: the shell echoes the command it is given, so a marker written
    // literally into that command would "answer" before the command had even run.
    expect(sizeCommand(path)).not.toContain("LARPABLE-SIZE");
    expect(sizeCommand(path)).not.toContain(String(expected));
  });

  it("is assembled by printf from separate words, and printed as one line", () => {
    const command = sizeCommand(path);
    expect(command).toContain("printf 'LARPABLE-%s %s %s\\n'");
    expect(command).toContain('SIZE ');
    expect(command).toContain(`wc -c < ${path}`);
  });

  it("accepts a count the guest actually printed", () => {
    const commands = [writeFileCommand(path, "x"), sizeCommand(path)];
    const transcript = [
      "user@unkernel:/workspace$ printf %s 'eA==' | base64 -d > dist/index.html",
      "user@unkernel:/workspace$ printf 'LARPABLE-%s %s %s\\n' SIZE dist/index.html \"$(wc -c < dist/index.html | tr -d ' ')\"",
      sizeLine(path, expected),
      "user@unkernel:/workspace$ ",
    ].join("\r\n");

    expect(sizeFromTranscript(transcript, path, commands)).toBe(expected);
  });

  it("refuses a marker that appears only in the shell's echo of the command", () => {
    // The exact failure mode of the old run: a `runInTerminal` step whose marker was echoed
    // by the shell and read back as though the command had answered. The transcript below
    // contains the marker text, but only inside the echoed instruction.
    const commands = [`printf 'LARPABLE-SIZE dist/index.html 412'`];
    const transcript = [
      `user@unkernel:/workspace$ ${commands[0]}`,
      "user@unkernel:/workspace$ ",
    ].join("\r\n");

    expect(transcript).toContain(sizeLine(path, expected));
    expect(sizeFromTranscript(transcript, path, commands)).toBeNull();
  });

  it("reports the truncated count a short write really produces", () => {
    // A lost character mid-payload is a smaller file, not an error. The run fails because the
    // number disagrees with the fixture, which is why the number is part of the marker.
    const commands = [sizeCommand(path)];
    const transcript = ["user@unkernel:/workspace$ ", sizeLine(path, 311)].join("\r\n");
    const reported = sizeFromTranscript(transcript, path, commands);
    expect(reported).toBe(311);
    expect(reported).not.toBe(expected);
  });

  it("returns null when the guest never answered at all", () => {
    expect(sizeFromTranscript("user@unkernel:/workspace$ ", path, [])).toBeNull();
  });
});

describe("the pty's echo", () => {
  const line = "printf %s 'eA==' | base64 -d > dist/index.html";

  it("counts a line the pty echoed in full", () => {
    expect(echoesWholeLine(`prompt$ ${line}`, line)).toBe(true);
  });

  it("does not count a line the pty echoed only in part", () => {
    // What a dropped character looks like: the command text is not there, so Enter must not
    // be pressed on the short version — it is a different command.
    expect(echoesWholeLine("prompt$ printf %s 'eA==' | base64 -d > dist/inde", line)).toBe(false);
  });

  it("tolerates the whitespace a terminal mirror changes", () => {
    expect(echoesWholeLine(`prompt$  ${line.replace(/ /g, "  ")}`, line)).toBe(true);
  });

  it("accepts an echo the terminal hard-wrapped with a carriage return", () => {
    // Measured: a 380-character base64 command arrives with `\r` every 80 columns, and a
    // comparison that treats `\r` as a space rejects a perfectly good echo.
    const wrapped = (line.match(/.{1,40}/g) ?? []).join("\r");
    expect(wrapped).toContain("\r");
    expect(echoesWholeLine(`prompt$ ${wrapped}`, line)).toBe(true);
  });

  it("tells an echoed command apart from output", () => {
    expect(isEchoedCommand(`user@unkernel:/workspace$ ${line}`, line)).toBe(true);
    expect(isEchoedCommand("LARPABLE-SIZE dist/index.html 412", line)).toBe(false);
  });
});
