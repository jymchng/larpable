/**
 * The user's terminal has to be a real shell conversation, so these tests drive it the
 * way a person does: type a line, press Enter, read what came back.
 *
 * They run against `FakeEnvironment`, whose shell executes lines through `execute()`.
 * That is what makes the assertions meaningful — the terminal and the command runner
 * agree, so a bug in either shows up here rather than in a browser session.
 */

import { describe, expect, it } from "vitest";

import { NotReadyError } from "@/env/environment-errors";
import type { TerminalSession } from "@/env/execution";
import { FakeEnvironment } from "@/env/fake-environment";

function ready(tree: Record<string, string> = {}, handlers = {}): FakeEnvironment {
  const environment = new FakeEnvironment({ tree, handlers });
  return environment;
}

/** Read everything currently buffered, without waiting for the stream to close. */
async function drain(session: TerminalSession, ms = 20): Promise<string> {
  const reader = session.output.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 5),
      ),
    ]);
    if (done) break;
    if (value) text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => undefined);
  return text;
}

describe("the guest terminal", () => {
  it("refuses to open before the environment is ready", async () => {
    const environment = new FakeEnvironment();
    await expect(environment.openShell()).rejects.toBeInstanceOf(NotReadyError);
  });

  it("starts in the workspace with a prompt that says so", async () => {
    const environment = ready();
    await environment.initialize();

    const session = await environment.openShell();
    expect(await drain(session)).toContain("user@larpable:/workspace$");
    await session.close();
  });

  it("runs the line the user typed and prints its output", async () => {
    const environment = ready();
    await environment.initialize();
    environment.script("ls", { stdout: "index.html\nsrc\n" });

    const session = await environment.openShell();
    await session.write("ls\r");

    const output = await drain(session);
    expect(output).toContain("index.html");
    expect(output).toContain("src");
    expect(environment.calls.some((call) => call.method === "execute" && call.command === "ls")).toBe(
      true,
    );
    await session.close();
  });

  it("echoes what was typed, the way a pty does", async () => {
    const environment = ready();
    await environment.initialize();
    environment.script("cat package.json", { stdout: '{"name":"site"}' });

    const session = await environment.openShell();
    await session.write("cat package.json\r");
    const output = await drain(session);

    expect(output).toContain("cat package.json");
    expect(output).toContain('{"name":"site"}');
    await session.close();
  });

  it("reports a non-zero exit instead of pretending the command worked", async () => {
    const environment = ready();
    await environment.initialize();
    environment.script("cat missing.txt", { stderr: "no such file\n", exitCode: 1 });

    const session = await environment.openShell();
    await session.write("cat missing.txt\r");
    const output = await drain(session);

    expect(output).toContain("no such file");
    expect(output).toContain("[exit 1]");
    await session.close();
  });

  it("clears the pending line on Ctrl-C and stays usable", async () => {
    const environment = ready();
    await environment.initialize();
    environment.script("ls", { stdout: "index.html\n" });

    const session = await environment.openShell();
    await session.write("cat never-runs");
    await session.write("\u0003");
    await session.write("ls\r");
    const output = await drain(session);

    expect(output).toContain("^C");
    expect(output).toContain("index.html");
    expect(
      environment.calls.some(
        (call) => call.method === "execute" && call.command.startsWith("cat never-runs"),
      ),
    ).toBe(false);
    await session.close();
  });

  it("carries the window size to the guest, so full-screen programs can lay out", async () => {
    const environment = ready();
    await environment.initialize();

    const session = await environment.openShell({ cols: 100, rows: 30 });
    expect(environment.calls).toContainEqual({
      method: "openShell",
      cwd: "/workspace",
      cols: 100,
      rows: 30,
    });

    session.resize(120, 40);
    expect(session.output).toBeInstanceOf(ReadableStream);
    await session.close();
    await expect(session.ended).resolves.toEqual({ type: "closed" });
  });
});
