import { describe, expect, it } from "vitest";

import { FakeEnvironment } from "@/env/fake-environment";
import { runEnvironmentSelfTest } from "@/env/self-test";

const token = "larpable-test-token";

function fakeEnvironment(overrides: ConstructorParameters<typeof FakeEnvironment>[0] = {}) {
  return new FakeEnvironment({
    tree: { "index.html": "<!doctype html>" },
    handlers: {
      "uname -a": { stdout: "Linux (none) 7.0.0 #1 SMP aarch64 Linux\n" },
    },
    now: () => 0,
    ...overrides,
  });
}

describe("runEnvironmentSelfTest", () => {
  it("proves the shell and both directions of the workspace mount", async () => {
    let elapsed = 0;
    const environment = fakeEnvironment({ now: () => (elapsed += 250) });
    await environment.initialize();

    // The guest write is a shell command in the real adapter; the fake answers only
    // scripted commands, so the script performs the write its shell would have done.
    environment.script(
      `mkdir -p /workspace/.larpable && printf '%s' '${token}g' > /workspace/.larpable/guest-to-host.txt`,
      () => {
        environment.workspace().writeFile("/.larpable/guest-to-host.txt", `${token}g`);
        return { stdout: "" };
      },
    );
    // ...and `cat` reads the file the host just wrote, through the same file system.
    environment.script("cat /workspace/.larpable/host-to-guest.txt", () => ({
      stdout: new TextDecoder().decode(environment.workspace().readFile("/.larpable/host-to-guest.txt")),
    }));

    // The same clock drives the self-test's own duration. With the real `Date.now` a
    // fake environment can finish inside one millisecond, `durationMs` would be 0, and
    // the assertion below failed intermittently without saying anything about the code.
    const result = await runEnvironmentSelfTest(environment, { token, now: () => (elapsed += 250) });

    expect(result.ok).toBe(true);
    expect(result.uname).toContain("aarch64");
    expect(result.steps.map((step) => step.name)).toEqual([
      "guest-shell",
      "host-to-guest",
      "guest-to-host",
    ]);
    expect(result.durationMs).toBeGreaterThan(0);

    // The host write really happened, and the guest was asked to read that exact path.
    const written = environment
      .workspace()
      .readFile("/.larpable/host-to-guest.txt");
    expect(new TextDecoder().decode(written)).toBe(token);
    expect(
      environment.calls.some(
        (call) =>
          call.method === "execute" && call.command === "cat /workspace/.larpable/host-to-guest.txt",
      ),
    ).toBe(true);
  });

  it("reports a step failure without hiding the steps that passed", async () => {
    const environment = fakeEnvironment({
      handlers: {
        "uname -a": { stdout: "Linux\n" },
        "cat /workspace/.larpable/host-to-guest.txt": {
          stdout: "something else\n",
          exitCode: 0,
        },
      },
    });
    await environment.initialize();

    const result = await runEnvironmentSelfTest(environment, { token });

    expect(result.ok).toBe(false);
    expect(result.steps.find((step) => step.name === "guest-shell")?.ok).toBe(true);
    expect(result.steps.find((step) => step.name === "host-to-guest")?.ok).toBe(false);
    expect(result.steps.find((step) => step.name === "host-to-guest")?.detail).toContain(
      "something else",
    );
  });

  it("captures a failed command instead of throwing", async () => {
    const environment = fakeEnvironment({
      handlers: { "uname -a": { stderr: "sh: uname: not found\n", exitCode: 127 } },
    });
    await environment.initialize();

    const result = await runEnvironmentSelfTest(environment, { token });

    expect(result.ok).toBe(false);
    expect(result.uname).toBeNull();
    expect(result.steps[0]?.detail).toContain("exited 127");
  });

  it("fails visibly when the environment is not ready", async () => {
    const environment = fakeEnvironment();

    const result = await runEnvironmentSelfTest(environment, { token });

    expect(result.ok).toBe(false);
    expect(result.steps.every((step) => !step.ok)).toBe(true);
    expect(result.steps[0]?.detail).toContain("must be ready first");
  });

  it("generates a fresh marker when none is given", async () => {
    let elapsed = 0;
    const environment = fakeEnvironment({ now: () => (elapsed += 1) });
    await environment.initialize();
    // Unscripted `cat` exits 127, but the path it was asked to read still shows the token
    // the self-test chose for this run.
    const result = await runEnvironmentSelfTest(environment);

    const hostToGuest = result.steps.find((step) => step.name === "host-to-guest");
    expect(hostToGuest?.detail).toContain("/workspace/.larpable/host-to-guest.txt");
    expect(result.ok).toBe(false);
  });
});
