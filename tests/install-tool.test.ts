/**
 * `install_dependencies` (PRD §7.2–7.3, §9.3 "Project") — the tool that came back, and the one
 * promise it makes.
 *
 * The promise is *"dependencies are installed, or here is the guest's own error"*, and it is
 * Bun-only by the user's decision. So the assertions are about the two ways that promise can
 * be broken, and neither is visible from the happy path:
 *
 * 1. **A silent substitution.** `BuildManager` can re-run an install with npm when `bun` is
 *    missing (the pane wants that; a button must work). The tool must not: it passes
 *    `fallbackToNpm: false`, so a guest without Bun produces the guest's own 127 rather than
 *    an npm install the model would then believe was Bun. That is proven with a real manager
 *    whose `fallbackToNpm` is *on* — the strictest configuration to test against.
 * 2. **A claim without a command.** On a machine whose runtime detection chose npm, the tool
 *    refuses *before* running anything. The fake port here throws if `install` is reached, so
 *    "zero commands ran" is asserted by construction rather than by counting.
 *
 * The command spelling (`bun install` vs `bun install --frozen-lockfile`) is not re-implemented
 * here: it is read back from `src/runtime/detect.ts` through a real `BuildManager` against a
 * scripted guest, so a lockfile in the tree is what makes the frozen flag appear.
 */

import { describe, expect, it } from "vitest";

import { BuildManager } from "@/build/manager";
import { FakeEnvironment } from "@/env/fake-environment";
import { installDependenciesTool } from "@/agent/tools/install";
import { ProcessRegistry } from "@/agent/tools/processes";
import type { BuildPort, ToolContext } from "@/agent/tools/types";

async function guest(tree: Record<string, string> = {}): Promise<FakeEnvironment> {
  const environment = new FakeEnvironment({ tree });
  await environment.initialize();
  return environment;
}

function contextFor(environment: FakeEnvironment, build: BuildPort | null): ToolContext {
  return {
    environment,
    root: environment.workspacePath,
    build,
    netlify: null,
    preview: null,
    processes: new ProcessRegistry(),
  };
}

/** The app's manager: Bun, with the fallback the *pane* is allowed and this tool is not. */
function bunManager(environment: FakeEnvironment, fallbackToNpm = true): BuildManager {
  return new BuildManager({
    environment,
    packageManager: "bun",
    fallbackToNpm,
    now: () => 1_000,
  });
}

describe("install_dependencies", () => {
  it("runs the guest's Bun and reports the command, the exit and what it printed", async () => {
    const environment = await guest();
    environment.script("bun install", {
      stdout: "Resolved, downloaded and extracted [84]\nSaved lockfile\n",
      durationMs: 41_900,
    });

    const result = await installDependenciesTool.run(
      {},
      contextFor(environment, bunManager(environment)),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("`bun install` succeeded (41900 ms)");
    // No `bun.lock` in the tree, so the honest sentence says the install was not frozen.
    expect(result.content).toContain("not frozen");
    expect(result.content).toContain("Resolved, downloaded and extracted [84]");
    expect(result.content).toContain("Package manager: bun.");
    expect(result.data).toEqual({
      ok: true,
      command: "bun install",
      packageManager: "bun",
      lockfile: null,
      exitCode: 0,
      durationMs: 41_900,
      ran: true,
    });
  });

  it("asks Bun for the frozen install when the project has a Bun lockfile", async () => {
    const environment = await guest({ "bun.lock": "lockfileVersion: 1\n" });
    environment.script("bun install --frozen-lockfile", {
      stdout: "Resolved, downloaded and extracted [84]\n",
      durationMs: 5_200,
    });

    const result = await installDependenciesTool.run(
      {},
      contextFor(environment, bunManager(environment)),
    );

    expect(result.ok).toBe(true);
    expect(result.content).toContain("`bun install --frozen-lockfile` succeeded");
    expect(result.content).toContain("Installed reproducibly from bun.lock");
    expect((result.data as { lockfile: string | null }).lockfile).toBe("bun.lock");
  });

  it("carries the guest's own error lines when the install fails", async () => {
    const environment = await guest();
    environment.script("bun install", {
      exitCode: 1,
      stderr: 'error: Could not resolve "react"\n  at /workspace/package.json:12:3\n',
      durationMs: 900,
    });

    const result = await installDependenciesTool.run(
      {},
      contextFor(environment, bunManager(environment)),
    );

    expect(result.ok).toBe(false);
    expect(result.content).toContain('error: Could not resolve "react"');
    expect(result.content).toContain("failed (900 ms, exit 1)");
    expect((result.data as { exitCode: number | null }).exitCode).toBe(1);
  });

  it("reports a guest with no Bun rather than letting npm install in its place", async () => {
    const environment = await guest();
    let npmRuns = 0;
    environment.script("npm install --no-audit --no-fund", () => {
      npmRuns += 1;
      return { stdout: "added 84 packages, and audited 85 packages in 5s\n", durationMs: 5_000 };
    });

    // `fallbackToNpm: true` is the pane's setting. The tool must still not use it.
    const manager = bunManager(environment, true);
    const result = await installDependenciesTool.run({}, contextFor(environment, manager));

    expect(result.ok).toBe(false);
    // The un-scripted `bun install` answers 127, which is the guest's own "no bun here".
    expect(result.content).toContain("`bun install` failed");
    expect(result.content).toContain("exit 127");
    expect(npmRuns).toBe(0);
    expect(manager.packageManager).toBe("bun");
  });

  it("refuses on a machine that installs with npm, and runs nothing at all", async () => {
    const environment = await guest();
    const note = "`bun --version` exited 127: sh: bun: not found";
    const manager: BuildPort = {
      packageManager: "npm",
      runtimeNote: note,
      install: async () => {
        throw new Error("install_dependencies must not run an install on an npm machine");
      },
      build: async () => {
        throw new Error("install_dependencies must not build");
      },
      lastSuccessfulBuild: () => null,
      history: () => [],
    };

    const result = await installDependenciesTool.run({}, contextFor(environment, manager));

    expect(result.ok).toBe(false);
    expect(result.content).toContain("installs with npm");
    expect(result.content).toContain("runs Bun only");
    expect(result.content).toContain(note);
    expect(result.data).toEqual({ packageManager: "npm", ran: false, note });
    // Nothing was executed in the guest either: the tool did not fall back to a shell.
    expect(environment.calls.filter((call) => call.method === "execute")).toEqual([]);
  });

  it("says a run with no build manager cannot install, instead of pretending", async () => {
    const environment = await guest();

    const result = await installDependenciesTool.run({}, contextFor(environment, null));

    expect(result.ok).toBe(false);
    expect(result.content).toContain("no build manager");
    expect(result.content).toContain("instead of claiming it happened");
    expect(environment.calls.filter((call) => call.method === "execute")).toEqual([]);
  });

  it("is a mutating tool with no arguments: installing is an action, not a query", () => {
    const definition = installDependenciesTool.definition;
    expect(definition.name).toBe("install_dependencies");
    expect(definition.readOnly).toBe(false);

    const { parameters } = definition;
    if (parameters.type !== "object") throw new Error("install_dependencies must take an object");
    expect(Object.keys(parameters.properties)).toEqual([]);
    expect(parameters.required ?? []).toEqual([]);
  });
});
