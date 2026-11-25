import { describe, expect, it } from "vitest";

import type { ExecutionEnvironment } from "../src/env/execution";
import { readStartScript, startAppServer, startCommandFor } from "../src/preview/app-server";

/** The smallest environment `startAppServer` needs, with the behaviour under test. */
function environment(options: {
  status?: "ready" | "idle";
  execute: (command: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
}): ExecutionEnvironment {
  return {
    workspacePath: "/workspace",
    status: () => options.status ?? "ready",
    snapshot: () => ({
      status: options.status ?? "ready",
      runtime: "node v26.13.1",
      distro: "debian",
      cpus: 2,
      memoryMiB: 2048,
      error: null,
    }),
    onStatus: () => () => undefined,
    initialize: async () => undefined,
    execute: options.execute as ExecutionEnvironment["execute"],
    executeArgv: options.execute as ExecutionEnvironment["executeArgv"],
    openShell: async () => {
      throw new Error("not used");
    },
    readFile: async () => new Uint8Array(),
    writeFile: async () => undefined,
    listFiles: async () => [],
    createDirectory: async () => undefined,
    removeFile: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as ExecutionEnvironment;
}

/** A `fetch` that fails `failures` times, then answers with a status. */
function flakyFetch(failures: number, status = 200): {
  fetch: (url: string) => Promise<Response>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async () => {
      calls += 1;
      if (calls <= failures) throw new Error("connection refused");
      return new Response("<html></html>", { status });
    },
  };
}

/**
 * A command that runs until it is aborted.
 *
 * The real `Environment.execute()` rejects with `ExecutionCancelledError` when its signal
 * aborts, so a fake that stayed pending forever would let a broken `stop()` pass and would
 * hang the test itself. This mirrors the real contract: abort → reject.
 */
function longRunning(options?: { onOutput?: (chunk: { text: string }) => void; signal?: AbortSignal }): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error("cancelled"), { name: "ExecutionCancelledError" }));
    if (options?.signal?.aborted === true) {
      abort();
      return;
    }
    options?.signal?.addEventListener("abort", abort, { once: true });
  });
}

describe("startAppServer", () => {
  it("refuses before the machine is ready, instead of starting a command in a dead guest", async () => {
    const result = await startAppServer({
      environment: environment({ status: "idle", execute: async () => undefined }),
      command: "bun run start",
      fetch: async () => new Response("", { status: 200 }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("denied");
    expect(result.message).toMatch(/not running/);
  });

  it("says a kernel without fetch() cannot show a running app", async () => {
    const result = await startAppServer({
      environment: environment({ execute: async () => undefined }),
      command: "bun run start",
      fetch: null,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-http");
  });

  it("waits for the guest to answer, and reports the first answer", async () => {
    const flaky = flakyFetch(3, 200);
    const stages: string[] = [];

    const result = await startAppServer({
      environment: environment({
        // A server does not exit; it runs until the session is stopped.
        execute: (_command, execute_options) =>
          longRunning(execute_options as unknown as { signal?: AbortSignal }),
      }),
      command: "bun run start",
      port: 3111,
      fetch: flaky.fetch,
      intervalMs: 0,
      sleep: async () => undefined,
      onStage: (stage) => stages.push(stage),
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.session?.url).toBe("http://127.0.0.1:3111/");
    expect(result.session?.status).toBe(200);
    // Readiness is the guest's answer, not a sleep: three refusals then a 200.
    expect(flaky.calls()).toBe(4);
    expect(stages.at(-1)).toMatch(/answered 200/);
    await result.session?.stop();
  });

  it("reports a process that died, with its own output, instead of polling until a timeout", async () => {
    const result = await startAppServer({
      environment: environment({
        execute: async (_command, options) => {
          options?.signal?.addEventListener("abort", () => undefined);
          return { command: "bun run start", exitCode: 1, stdout: "", stderr: "Cannot find module 'next'" };
        },
      }),
      command: "bun run start",
      fetch: async () => {
        throw new Error("connection refused");
      },
      intervalMs: 0,
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("exited");
    expect(result.message).toContain("exited before it answered on port 3000");
  });

  it("times out with the budget it was given, and aborts the process", async () => {
    let aborted = false;
    let clock = 0;

    const result = await startAppServer({
      environment: environment({
        execute: (_command, options) => {
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return longRunning(options as unknown as { signal?: AbortSignal });
        },
      }),
      command: "bun run start",
      port: 3000,
      fetch: async () => {
        throw new Error("connection refused");
      },
      timeoutMs: 1_000,
      intervalMs: 100,
      now: () => clock,
      // One "second" per poll, so the loop ends after ten attempts.
      sleep: async (ms) => {
        clock += ms;
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("timeout");
    expect(result.message).toContain("did not answer on port 3000 within 1 s");
    expect(aborted).toBe(true);
  });

  it("stops the server by aborting the execution", async () => {
    let signal: AbortSignal | undefined;
    const result = await startAppServer({
      environment: environment({
        execute: (_command, options) => {
          signal = options?.signal;
          return longRunning(options as unknown as { signal?: AbortSignal });
        },
      }),
      command: "bun run start",
      fetch: async () => new Response("ok", { status: 200 }),
      intervalMs: 0,
      sleep: async () => undefined,
    });

    expect(result.ok).toBe(true);
    expect(signal?.aborted).toBe(false);
    await result.session?.stop();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps only the tail of a chatty server's log", async () => {
    let emit: ((chunk: { text: string }) => void) | null = null;
    // A closure, not a direct `emit?.(...)` call: TypeScript narrows `emit` to `null` at the
    // call site (its only assignment is inside the fake's `execute`), which makes the direct
    // call "not callable". In a nested function the declared union type is used instead.
    const notify = (chunk: { text: string }) => {
      emit?.(chunk);
    };
    const result = await startAppServer({
      environment: environment({
        execute: (_command, options) => {
          emit = (options as unknown as { onOutput?: (chunk: { text: string }) => void }).onOutput ?? null;
          return longRunning(options as unknown as { signal?: AbortSignal });
        },
      }),
      command: "bun run start",
      fetch: async () => new Response("ok", { status: 200 }),
      intervalMs: 0,
      sleep: async () => undefined,
    });

    for (let index = 0; index < 400; index += 1) notify({ text: `line ${String(index)}\n` });
    expect(result.session?.output()).toContain("line 399");
    expect(result.session?.output()!.length).toBeLessThan(2_000);
    await result.session?.stop();
  });
});

describe("startCommandFor", () => {
  it("runs the project's own start script with the project's own manager", () => {
    expect(startCommandFor({ packageManager: "bun", startScript: "next start" })).toBe("bun run start");
    expect(startCommandFor({ packageManager: "npm", startScript: "next start" })).toBe("npm run start");
    expect(startCommandFor({ packageManager: "pnpm", startScript: "next start" })).toBe("pnpm start");
    expect(startCommandFor({ packageManager: "yarn", startScript: "next start" })).toBe("yarn start");
  });

  it("has no answer for a project with no start script, rather than inventing one", () => {
    expect(startCommandFor({ packageManager: "bun", startScript: null })).toBeNull();
    expect(startCommandFor({ packageManager: "bun", startScript: "   " })).toBeNull();
  });
});

/** A guest whose files are exactly `files`, keyed by absolute path. */
function filesystem(files: Record<string, string>): ExecutionEnvironment {
  const base = environment({ execute: async () => undefined });
  return {
    ...base,
    readFile: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`no such file: ${path}`);
      return new TextEncoder().encode(content);
    },
  } as ExecutionEnvironment;
}

function packageJson(scripts: Record<string, unknown>): string {
  return JSON.stringify({ name: "demo", scripts });
}

describe("readStartScript", () => {
  it("prefers `dev` when the project has both, because that is the developer's server", async () => {
    const facts = await readStartScript(
      filesystem({
        "/workspace/package.json": packageJson({ dev: "next dev", start: "next start" }),
        "/workspace/bun.lock": "",
      }),
      "/workspace",
    );

    expect(facts).toEqual({
      dev: "next dev",
      start: "next start",
      command: "bun run dev",
      script: "dev",
      packageManager: "bun",
      problem: null,
    });
  });

  it("falls back to `start` for a project that only documents one", async () => {
    const facts = await readStartScript(
      filesystem({ "/workspace/package.json": packageJson({ start: "next start" }) }),
      "/workspace",
    );

    expect(facts.command).toBe("npm run start");
    expect(facts.script).toBe("start");
    expect(facts.dev).toBeNull();
    expect(facts.problem).toBeNull();
  });

  it("answers with a sentence, not a guessed command, when the project has neither", async () => {
    const facts = await readStartScript(
      filesystem({ "/workspace/package.json": packageJson({ build: "vite build" }) }),
      "/workspace",
    );

    expect(facts.command).toBeNull();
    expect(facts.script).toBeNull();
    expect(facts.problem).toContain("No `dev` or `start` script");
    // The manager is still reported: the build half of the app needs it either way.
    expect(facts.packageManager).toBe("npm");
  });

  it("treats a blank script as absent, because `\"dev\": \"\"` is not a dev server", async () => {
    const facts = await readStartScript(
      filesystem({
        "/workspace/package.json": packageJson({ dev: "   ", start: "node server.js" }),
      }),
      "/workspace",
    );

    expect(facts.dev).toBeNull();
    expect(facts.script).toBe("start");
    expect(facts.command).toBe("npm run start");
  });

  it("says package.json is unreadable rather than pretending the project has no scripts", async () => {
    const facts = await readStartScript(
      filesystem({
        "/workspace/package.json": "{ this is not json",
        "/workspace/pnpm-lock.yaml": "",
      }),
      "/workspace",
    );

    expect(facts.command).toBeNull();
    expect(facts.problem).toContain("not valid JSON");
    expect(facts.packageManager).toBe("pnpm");
  });

  it("names a missing package.json as the reason", async () => {
    const facts = await readStartScript(filesystem({ "/workspace/index.html": "" }), "/workspace");

    expect(facts.command).toBeNull();
    expect(facts.problem).toContain("no package.json");
  });

  it("spells the command the way each project's own manager does", async () => {
    const manager = async (lockfile: string | null) => {
      const files: Record<string, string> = {
        "/workspace/package.json": packageJson({ dev: "vite" }),
      };
      if (lockfile !== null) files[`/workspace/${lockfile}`] = "";
      const facts = await readStartScript(filesystem(files), "/workspace");
      return `${facts.packageManager}: ${facts.command ?? "(none)"}`;
    };

    expect(await manager("bun.lock")).toBe("bun: bun run dev");
    expect(await manager("bun.lockb")).toBe("bun: bun run dev");
    expect(await manager("pnpm-lock.yaml")).toBe("pnpm: pnpm dev");
    expect(await manager("yarn.lock")).toBe("yarn: yarn dev");
    // No lockfile at all is npm: the only manager that needs no marker to be the default.
    expect(await manager(null)).toBe("npm: npm run dev");
  });
});
