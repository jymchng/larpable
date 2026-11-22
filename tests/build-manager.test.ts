/**
 * The build manager, against a fake environment.
 *
 * What these tests are for: the manager is the only place that turns "exit 0" into a
 * verdict the preview and the UI act on. A test that stopped at `result.ok === true`
 * would pass for a build that wrote nothing — which is the exact failure the entry-point
 * check exists to catch. So each case asserts the *evidence*: which command ran, what
 * the record says it came from, whether the preview was told, and what a failure names.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ExecutionCancelledError,
  ExecutionTimeoutError,
} from "@/env/environment-errors";
import { FakeEnvironment, type FakeCommandHandler } from "@/env/fake-environment";
import type { ExecutionResult } from "@/env/execution";
import { BuildManager, type WarmRuntime } from "@/build/manager";

const PKG = JSON.stringify({
  name: "site",
  scripts: { build: "vite build" },
  dependencies: { react: "^18.3.1" },
});

const INSTALL = "npm install --no-audit --no-fund";
const BUILD = "npm run build";

function result(command: string, over: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    command,
    argv: ["/bin/sh", "-lc", command],
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 10,
    truncated: false,
    ...over,
  };
}

interface Harness {
  environment: FakeEnvironment;
  manager: BuildManager;
  onBuilt: ReturnType<typeof vi.fn>;
  commands(): string[];
}

async function harness(
  options: {
    tree?: Record<string, string>;
    handlers?: Record<string, FakeCommandHandler>;
    runtime?: WarmRuntime;
    framework?: "react-ts" | "vanilla";
  } = {},
): Promise<Harness> {
  const environment = new FakeEnvironment({ tree: options.tree ?? { "package.json": PKG } });
  await environment.initialize();
  const onBuilt = vi.fn();
  let clock = 1_000;
  // A handler has to write through the environment it belongs to; this is that link.
  currentEnvironment = environment;

  const manager = new BuildManager({
    environment,
    ...(options.framework ? { framework: options.framework } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
    now: () => (clock += 10),
    nextId: (sequence) => `build-${String(sequence)}`,
    onBuilt,
    installTimeoutMs: 600_000,
    buildTimeoutMs: 300_000,
    ...(options.handlers ? { environment } : {}),
  });

  for (const [command, handler] of Object.entries(options.handlers ?? {})) {
    environment.script(command, handler);
  }

  return {
    environment,
    manager,
    onBuilt,
    commands: () =>
      environment.calls.filter((call) => call.method === "execute").map((call) => call.command),
  };
}

/** A build that does what vite does: writes the entry page into the output directory. */
function writesEntry(dir: string, html = "<!doctype html><div id=\"app\"></div>"): FakeCommandHandler {
  return async () => {
    const environment = currentEnvironment;
    await environment.writeFile(`/workspace/${dir}/index.html`, html);
    await environment.writeFile(`/workspace/${dir}/assets/index-abc.js`, "console.log(1)");
    return { stdout: `vite v5.4.11 building for production...\ndist/index.html  0.42 kB\n` };
  };
}

// Set by `harness()` so a handler can write through the same environment it belongs to.
let currentEnvironment: FakeEnvironment;

describe("installing dependencies", () => {
  it("runs npm install without a lockfile, keeping the log", async () => {
    const { manager, commands } = await harness({
      handlers: { [INSTALL]: () => ({ stdout: "added 42 packages\n" }) },
    });

    const install = await manager.install();

    expect(commands()).toEqual([INSTALL]);
    expect(install).toMatchObject({
      ok: true,
      command: INSTALL,
      packageManager: "npm",
      lockfile: null,
      failure: null,
    });
    expect(install.log.stdout).toContain("added 42 packages");
  });

  it("prefers npm ci when the project actually has a lockfile", async () => {
    const { manager, commands } = await harness({
      tree: { "package.json": PKG, "package-lock.json": "{}" },
      handlers: { "npm ci --no-audit --no-fund": () => ({ stdout: "added 42 packages\n" }) },
    });

    const install = await manager.install();

    expect(commands()).toEqual(["npm ci --no-audit --no-fund"]);
    expect(install.lockfile).toBe("package-lock.json");
    expect(install.ok).toBe(true);
  });

  it("classifies a failed install and hands the agent the guest's own error lines", async () => {
    const { manager } = await harness({
      handlers: {
        [INSTALL]: () => ({
          exitCode: 1,
          stderr: "npm ERR! code EAI_AGAIN\nnpm ERR! network request failed\n",
        }),
      },
    });

    const install = await manager.install();

    expect(install.ok).toBe(false);
    expect(install.failure?.kind).toBe("network");
    expect(install.failure?.detail).toContain("EAI_AGAIN");
  });

  it("goes through the warm runtime, so nothing runs before node exists", async () => {
    const exec = vi.fn(async (_command: string) => result(INSTALL, { stdout: "ok\n" }));
    const { manager, commands } = await harness({ runtime: { exec } });

    await manager.install();
    await manager.build();

    expect(commands()).toEqual([]);
    expect(exec.mock.calls.map(([command]) => command)).toEqual([INSTALL, BUILD]);
  });

  it("maps a blown budget to a timeout, not to a compile error", async () => {
    const { manager } = await harness({
      handlers: {
        [INSTALL]: () => {
          throw new ExecutionTimeoutError(600_000, result(INSTALL, { exitCode: null, signal: 9 }));
        },
      },
    });

    const install = await manager.install();

    expect(install.ok).toBe(false);
    expect(install.failure?.kind).toBe("timeout");
    expect(install.failure?.summary).toMatch(/did not finish inside its budget/);
  });

  it("does not turn a cancellation into a failure record", async () => {
    const { manager } = await harness({
      handlers: {
        [INSTALL]: () => {
          throw new ExecutionCancelledError(result(INSTALL, { exitCode: null, signal: 9 }));
        },
      },
    });

    await expect(manager.install()).rejects.toBeInstanceOf(ExecutionCancelledError);
  });
});

describe("a successful build", () => {
  it("verifies the entry point and records an id, the reason and the log", async () => {
    const { manager, onBuilt, commands } = await harness({
      handlers: { [BUILD]: writesEntry("dist") },
    });

    const build = await manager.build();

    expect(commands()).toEqual([BUILD]);
    expect(build).toMatchObject({
      id: "build-1",
      ok: true,
      command: BUILD,
      commandSource: "scripts.build",
      outputDir: "dist",
      outputSource: "framework-default",
      entryPoint: "/workspace/dist/index.html",
      failure: null,
    });
    expect(build.entryBytes).toBeGreaterThan(0);
    expect(build.reason).toContain("package.json defines `build`");
    expect(build.reason).toContain("default");
    expect(build.log?.stdout).toContain("vite v5.4.11");
    expect(build.durationMs).toBe(build.finishedAt - build.startedAt);

    // The preview refreshes only after the output was proven to exist.
    expect(onBuilt).toHaveBeenCalledOnce();
    expect(onBuilt).toHaveBeenCalledWith(build);
    expect(manager.lastSuccessfulBuild()).toBe(build);
  });

  it("uses a custom outDir from vite.config instead of assuming dist", async () => {
    const { manager } = await harness({
      tree: {
        "package.json": PKG,
        "vite.config.ts": 'export default defineConfig({ build: { outDir: "public" } });',
      },
      handlers: { [BUILD]: writesEntry("public") },
    });

    const build = await manager.build();

    expect(build).toMatchObject({ ok: true, outputDir: "public", outputSource: "vite-config" });
    expect(build.entryPoint).toBe("/workspace/public/index.html");
  });

  it("uses netlify.toml's publish when vite does not name a directory", async () => {
    const { manager } = await harness({
      tree: { "package.json": PKG, "netlify.toml": '[build]\n  publish = "site"\n' },
      handlers: { [BUILD]: writesEntry("site") },
    });

    const build = await manager.build();

    expect(build).toMatchObject({ ok: true, outputDir: "site", outputSource: "netlify-toml" });
  });

  it("gives every attempt its own id, and keeps failures in the history", async () => {
    let attempt = 0;
    const { manager } = await harness({
      handlers: {
        [BUILD]: async () => {
          attempt += 1;
          if (attempt === 1) return { exitCode: 1, stderr: "error TS2322: bad type\n" };
          await currentEnvironment.writeFile("/workspace/dist/index.html", "<!doctype html>");
          return { stdout: "built\n" };
        },
      },
    });

    const failed = await manager.build();
    const succeeded = await manager.build();

    expect(failed.id).toBe("build-1");
    expect(succeeded.id).toBe("build-2");
    expect(manager.history().map((entry) => entry.id)).toEqual(["build-1", "build-2"]);
    expect(manager.lastSuccessfulBuild()?.id).toBe("build-2");
  });
});

describe("a build that exits 0 but produced nothing", () => {
  it("fails with missing-entry instead of telling the preview to refresh", async () => {
    const { manager, onBuilt } = await harness({ handlers: { [BUILD]: () => ({ stdout: "done\n" }) } });

    const build = await manager.build();

    expect(build.ok).toBe(false);
    expect(build.failure?.kind).toBe("missing-entry");
    expect(build.failure?.summary).toContain("/workspace/dist/index.html");
    expect(build.failure?.hint).toMatch(/outDir/);
    // exit 0 is still recorded: the log is evidence about what the build claimed.
    expect(build.log?.stdout).toBe("done\n");
    expect(onBuilt).not.toHaveBeenCalled();
    expect(manager.lastSuccessfulBuild()).toBeNull();
  });

  it("refuses a file named index.html that is not HTML", async () => {
    const { manager } = await harness({
      handlers: { [BUILD]: writesEntry("dist", '{"not":"html"}') },
    });

    const build = await manager.build();

    expect(build.ok).toBe(false);
    expect(build.failure?.kind).toBe("missing-entry");
    expect(build.failure?.summary).toMatch(/is not HTML/);
    expect(build.failure?.detail).toContain("not");
  });
});

describe("a build that cannot even be planned", () => {
  it("records a missing project as its own failure, with no log to show", async () => {
    const { manager, commands } = await harness({ tree: {} });

    const build = await manager.build();

    expect(build.ok).toBe(false);
    expect(build.commandSource).toBe("none");
    expect(build.log).toBeNull();
    expect(build.failure?.kind).toBe("missing-script");
    expect(build.reason).toMatch(/no package.json/);
    expect(commands()).toEqual([]);
  });

  it("refuses to invent a build script for an unknown framework", async () => {
    const { manager, commands } = await harness({
      tree: { "package.json": JSON.stringify({ name: "site", scripts: { dev: "vite" } }) },
    });

    const build = await manager.build();

    expect(build.ok).toBe(false);
    expect(build.failure?.kind).toBe("missing-script");
    expect(build.failure?.hint).toMatch(/Add a `build` script/);
    expect(commands()).toEqual([]);
  });
});

describe("failures with output", () => {
  it("classifies a compile failure and carries the guest's lines through", async () => {
    const stderr = "\u001b[31msrc/App.tsx(3,7): error TS2322: Type 'string' is not assignable\u001b[0m\n";
    const { manager } = await harness({ handlers: { [BUILD]: () => ({ exitCode: 2, stderr }) } });

    const build = await manager.build();

    expect(build.ok).toBe(false);
    expect(build.failure?.kind).toBe("compile");
    expect(build.failure?.detail).toContain("error TS2322");
    expect(build.failure?.detail).not.toContain("\u001b[");
    expect(build.log?.exitCode).toBe(2);
  });

  it("maps a blown build budget to a timeout and keeps it in the history", async () => {
    const { manager } = await harness({
      handlers: {
        [BUILD]: () => {
          throw new ExecutionTimeoutError(300_000, result(BUILD, { exitCode: null, signal: 9 }));
        },
      },
    });

    const build = await manager.build();

    expect(build.ok).toBe(false);
    expect(build.failure?.kind).toBe("timeout");
    expect(manager.history()).toHaveLength(1);
  });

  it("rethrows a cancellation without recording a verdict", async () => {
    const { manager, onBuilt } = await harness({
      handlers: {
        [BUILD]: () => {
          throw new ExecutionCancelledError(result(BUILD, { exitCode: null, signal: 9 }));
        },
      },
    });

    await expect(manager.build()).rejects.toBeInstanceOf(ExecutionCancelledError);
    expect(manager.history()).toEqual([]);
    expect(onBuilt).not.toHaveBeenCalled();
  });
});

describe("the framework hint", () => {
  it("uses the framework default command when package.json has no build script", async () => {
    const { manager } = await harness({
      tree: { "package.json": JSON.stringify({ name: "site", scripts: {} }) },
      framework: "react-ts",
      handlers: { "vite build": writesEntry("dist") },
    });

    const build = await manager.build();

    expect(build.command).toBe("vite build");
    expect(build.commandSource).toBe("framework-default");
    expect(build.ok).toBe(true);
  });
});
