/**
 * The adapter is only trustworthy if it is driven, so these tests run
 * `UnkernelEnvironment` through a fake kernel that records every call.
 *
 * No WebAssembly, no timers beyond the ones under test, and no network: if one of
 * these fails, the adapter is wrong — not the VM, not the browser, not the machine.
 */

import { describe, expect, it } from "vitest";

import {
  BusyError,
  ExecutionCancelledError,
  ExecutionTimeoutError,
  FileNotFoundError,
  NotReadyError,
  OutsideWorkspaceError,
} from "@/env/environment-errors";
import type {
  ExecutionResult,
  InitializeStage,
  OutputChunk,
} from "@/env/execution";
import { FakeEnvironment } from "@/env/fake-environment";
import { resolveWorkspacePath } from "@/env/paths";
import { UnkernelEnvironment } from "@/env/unkernel-environment";
import type {
  KernelBootRequest,
  KernelEndEvent,
  KernelLike,
  KernelProcessLike,
  KernelSpawnOptions,
} from "@/env/unkernel-kernel";
import { MemoryWorkspace } from "@/env/workspace-fs";

interface ProcessPlan {
  stdout?: string;
  stderr?: string;
  end?: KernelEndEvent;
  /** Never closes or ends until killed: the timeout/cancellation case. */
  hang?: boolean;
  /** Split stdout into chunks of this many bytes, to test streaming decode. */
  chunkBytes?: number;
}

class FakeProcess implements KernelProcessLike {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly ended: Promise<KernelEndEvent>;
  readonly kills: string[] = [];

  #closeStdout: (() => void) | null = null;
  #closeStderr: (() => void) | null = null;
  #resolveEnd: ((end: KernelEndEvent) => void) | null = null;

  constructor(plan: ProcessPlan) {
    const encoder = new TextEncoder();

    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#closeStdout = () => controller.close();
        const bytes = encoder.encode(plan.stdout ?? "");
        const size = plan.chunkBytes ?? Math.max(bytes.byteLength, 1);
        for (let offset = 0; offset < bytes.byteLength; offset += size) {
          controller.enqueue(bytes.slice(offset, offset + size));
        }
        // A hanging program has printed what it printed and then stayed alive, so the
        // stream is left open rather than empty.
        if (!plan.hang) controller.close();
      },
    });

    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#closeStderr = () => controller.close();
        if (plan.stderr) controller.enqueue(encoder.encode(plan.stderr));
        if (!plan.hang) controller.close();
      },
    });

    this.ended = new Promise<KernelEndEvent>((resolve) => {
      this.#resolveEnd = resolve;
      if (!plan.hang) resolve(plan.end ?? { type: "exit", code: 0 });
    });
  }

  kill(signal?: string): void {
    this.kills.push(signal ?? "SIGTERM");
    this.#closeStdout?.();
    this.#closeStderr?.();
    this.#resolveEnd?.({ type: "signal", signal: 9 });
  }

  async close(): Promise<void> {
    this.#closeStdout?.();
    this.#closeStderr?.();
  }
}

class FakeKernel implements KernelLike {
  readonly boots: KernelBootRequest[] = [];
  readonly spawned: Array<{
    file: string;
    args: readonly string[];
    opts: KernelSpawnOptions & { pty: false };
  }> = [];
  readonly processes: FakeProcess[] = [];
  readonly kills: string[] = [];
  stopped = false;
  memoryMiB = 1024;

  readonly exited: Promise<unknown>;
  #resolveExit: ((value: unknown) => void) | null = null;

  constructor(private readonly respond: (file: string, args: readonly string[]) => ProcessPlan) {
    this.exited = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  async spawn(
    file: string,
    args: readonly string[] | undefined,
    opts: KernelSpawnOptions & { pty: false },
  ): Promise<KernelProcessLike> {
    const argv = args ?? [];
    this.spawned.push({ file, args: argv, opts });
    const process = new FakeProcess(this.respond(file, argv));
    const originalKill = process.kill.bind(process);
    process.kill = (signal?: string) => {
      this.kills.push(signal ?? "SIGTERM");
      originalKill(signal);
    };
    // `poweroff` really does halt the guest, so the fake kernel exits with it: that is
    // what makes `shutdown()` a clean halt instead of a timeout.
    if (argv.join(" ").includes("poweroff")) {
      this.#resolveExit?.({ code: 0, reason: "poweroff", kind: "exit" });
    }
    this.processes.push(process);
    return process;
  }

  async stop(): Promise<unknown> {
    this.stopped = true;
    this.#resolveExit?.({ code: 0, reason: "stopped", kind: "stopped" });
    return { code: 0, reason: "stopped", kind: "stopped" };
  }
}

/** A kernel that answers the boot probes and nothing else. */
function bootableKernel(): FakeKernel {
  return new FakeKernel((file, args) => {
    const command = args.join(" ");
    if (command.includes("larpable-ok")) return { stdout: "larpable-ok", end: { type: "exit", code: 0 } };
    if (command.includes("command -v")) {
      return { stdout: "/usr/lib/kw/bin/node\n", end: { type: "exit", code: 0 } };
    }
    if (command.includes("poweroff")) return { end: { type: "exit", code: 0 } };
    return { stdout: "ok\n", end: { type: "exit", code: 0 } };
  });
}

function environment(
  kernel: FakeKernel,
  overrides: Partial<ConstructorParameters<typeof UnkernelEnvironment>[0]> = {},
): UnkernelEnvironment {
  return new UnkernelEnvironment({
    distro: "/distros/alpine.erofs",
    kernelFactory: async (request) => {
      kernel.boots.push(request);
      return kernel;
    },
    workspaceFs: new MemoryWorkspace(),
    commandTimeoutMs: 5_000,
    ...overrides,
  });
}

describe("UnkernelEnvironment initialisation", () => {
  it("walks PRD §5.3 in order and ends ready", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel);
    const statuses: string[] = [];
    const stages: InitializeStage[] = [];
    env.onStatus((snapshot) => statuses.push(snapshot.status));

    await env.initialize({ onStage: (stage) => stages.push(stage) });

    expect(statuses).toEqual(["initializing", "booting", "ready"]);
    expect(stages).toEqual(["boot", "filesystem", "shell", "runtime"]);
    expect(env.status()).toBe("ready");

    // The workspace is mounted at boot, not later: one 9p mount serves every call.
    const mount = kernel.boots[0]?.mounts["/workspace"];
    expect(mount).toBeInstanceOf(MemoryWorkspace);
    expect(kernel.spawned[0]?.opts.pty).toBe(false);
    expect(kernel.spawned[0]?.opts.cwd).toBe("/workspace");
  });

  it("reports the facts it measured and nothing it did not", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel, { memoryMiB: 512 });
    await env.initialize();

    const snapshot = env.snapshot();
    expect(snapshot.distro).toBe("alpine");
    expect(snapshot.runtime).toBe("node (guest shim)");
    expect(snapshot.memoryMiB).toBe(1024); // the kernel's measurement wins over the request
    expect(snapshot.cpus).toBeNull();
    expect(snapshot.error).toBeNull();
  });

  it("ends in error, keeps the message, and still shuts down", async () => {
    const env = environment(bootableKernel(), {
      kernelFactory: async () => {
        throw new Error("no JSPI");
      },
    });
    const statuses: string[] = [];
    env.onStatus((snapshot) => statuses.push(snapshot.status));

    await expect(env.initialize()).rejects.toThrow(/no JSPI/);
    expect(statuses).toEqual(["initializing", "booting", "error"]);
    expect(env.status()).toBe("error");
    expect(env.snapshot().error).toBe("no JSPI");

    await env.shutdown();
    expect(env.status()).toBe("stopped");
  });

  it("refuses a second initialize while one is running", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel);
    const first = env.initialize();
    await expect(env.initialize()).rejects.toBeInstanceOf(BusyError);
    await first;
  });

  it("fails when the guest shell cannot run", async () => {
    const kernel = new FakeKernel(() => ({ end: { type: "exit", code: 127 } }));
    const env = environment(kernel);

    await expect(env.initialize()).rejects.toThrow(/guest shell did not run/);
    expect(env.status()).toBe("error");
  });
});

describe("ready-gating", () => {
  it("rejects commands before ready without touching the kernel", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel);

    await expect(env.execute("npm run build")).rejects.toBeInstanceOf(NotReadyError);
    await expect(env.readFile("/workspace/package.json")).rejects.toBeInstanceOf(NotReadyError);
    expect(kernel.boots).toHaveLength(0);
    expect(kernel.spawned).toHaveLength(0);
    expect(env.status()).toBe("idle");
  });

  it("rejects commands after shutdown", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel);
    await env.initialize();
    await env.shutdown();

    await expect(env.execute("uname -a")).rejects.toBeInstanceOf(NotReadyError);
    expect(env.status()).toBe("stopped");
  });
});

describe("execute", () => {
  it("returns a non-zero exit instead of throwing, with both streams captured", async () => {
    const kernel = new FakeKernel((file, args) => {
      if (args.join(" ").includes("larpable-ok")) return { stdout: "larpable-ok" };
      if (args.join(" ").includes("command -v")) return { stdout: "/usr/lib/kw/bin/node\n" };
      return {
        stdout: "vite build\n",
        stderr: "error TS2322: Type 'string' is not assignable\n",
        end: { type: "exit", code: 2 },
      };
    });
    const env = environment(kernel);
    await env.initialize();

    const result = await env.execute("npm run build");
    expect(result.exitCode).toBe(2);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("vite build");
    expect(result.stderr).toContain("error TS2322");
    expect(result.argv).toEqual(["/bin/sh", "-lc", "npm run build"]);
  });

  it("streams output in order and decodes characters split across chunks", async () => {
    const kernel = new FakeKernel((file, args) => {
      const command = args.join(" ");
      if (command.includes("larpable-ok")) return { stdout: "larpable-ok" };
      if (command.includes("command -v")) return { stdout: "" };
      // "héllo 🚀" is 11 bytes; 2-byte chunks cut both the é and the emoji in half.
      return {
        stdout: "héllo 🚀\n",
        stderr: "warn\n",
        chunkBytes: 2,
        end: { type: "exit", code: 0 },
      };
    });
    const env = environment(kernel);
    await env.initialize();

    const chunks: OutputChunk[] = [];
    const result = await env.execute("echo test", { onOutput: (chunk) => chunks.push(chunk) });

    expect(result.stdout).toBe("héllo 🚀\n");
    expect(chunks.filter((chunk) => chunk.stream === "stdout").map((chunk) => chunk.text).join("")).toBe(
      "héllo 🚀\n",
    );
    expect(chunks.some((chunk) => chunk.stream === "stderr" && chunk.text === "warn\n")).toBe(true);
  });

  it("kills the program and reports the partial output on timeout", async () => {
    const kernel = new FakeKernel((file, args) => {
      const command = args.join(" ");
      if (command.includes("larpable-ok")) return { stdout: "larpable-ok" };
      if (command.includes("command -v")) return { stdout: "" };
      return { stdout: "starting install\n", hang: true };
    });
    const env = environment(kernel);
    await env.initialize();

    const failure = await env.execute("npm install", { timeoutMs: 20 }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ExecutionTimeoutError);
    const timeout = failure as ExecutionTimeoutError;
    expect(timeout.timeoutMs).toBe(20);
    expect(timeout.result.stdout).toBe("starting install\n");
    expect(kernel.kills).toContain("SIGKILL");
  });

  it("kills the program and reports cancellation", async () => {
    const kernel = new FakeKernel((file, args) => {
      const command = args.join(" ");
      if (command.includes("larpable-ok")) return { stdout: "larpable-ok" };
      if (command.includes("command -v")) return { stdout: "" };
      return { stdout: "building…\n", hang: true };
    });
    const env = environment(kernel);
    await env.initialize();

    const controller = new AbortController();
    const pending = env.execute("npm run build", { signal: controller.signal });
    controller.abort();

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ExecutionCancelledError);
    expect((failure as ExecutionCancelledError).result.stdout).toBe("building…\n");
    expect(kernel.kills).toContain("SIGKILL");
  });

  it("runs an explicit argv without a shell", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel);
    await env.initialize();

    const result = await env.executeArgv("cat", ["/workspace/hello.txt"]);
    expect(result.argv).toEqual(["cat", "/workspace/hello.txt"]);
    expect(kernel.spawned.at(-1)?.args).toEqual(["/workspace/hello.txt"]);
  });

  it("resolves cwd inside the workspace and refuses to escape it", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel);
    await env.initialize();

    await env.execute("ls", { cwd: "src" });
    expect(kernel.spawned.at(-1)?.opts.cwd).toBe("/workspace/src");

    await expect(env.execute("ls", { cwd: "../../etc" })).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
  });
});

describe("workspace file operations", () => {
  it("round-trips files and lists directory entries with kinds", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel);
    await env.initialize();

    await env.writeFile("package.json", '{"name":"demo"}');
    await env.createDirectory("/workspace/src");
    await env.writeFile("/workspace/src/App.tsx", "export default 1;\n");

    expect(new TextDecoder().decode(await env.readFile("/workspace/package.json"))).toBe(
      '{"name":"demo"}',
    );

    const root = await env.listFiles("/workspace");
    expect(root.map((entry) => [entry.name, entry.kind])).toEqual([
      ["package.json", "file"],
      ["src", "directory"],
    ]);
    expect(root[0]?.size).toBe(15); // `{"name":"demo"}`

    const src = await env.listFiles("src");
    expect(src).toHaveLength(1);
    expect(src[0]?.path).toBe("/workspace/src/App.tsx");

    await env.removeFile("/workspace/package.json");
    await expect(env.readFile("/workspace/package.json")).rejects.toBeInstanceOf(FileNotFoundError);
  });

  it("refuses paths outside the workspace", async () => {
    const env = environment(bootableKernel());
    await env.initialize();

    await expect(env.writeFile("../escape.txt", "no")).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
    await expect(env.readFile("/etc/passwd")).rejects.toBeInstanceOf(OutsideWorkspaceError);
    await expect(env.listFiles("/workspace/../..")).rejects.toBeInstanceOf(
      OutsideWorkspaceError,
    );
  });
});

describe("shutdown", () => {
  it("powers off the guest, then stops the kernel, and is idempotent", async () => {
    const kernel = bootableKernel();
    const env = environment(kernel);
    await env.initialize();

    await env.shutdown();
    expect(kernel.spawned.at(-1)?.args.join(" ")).toContain("poweroff");
    expect(kernel.stopped).toBe(true);
    expect(env.status()).toBe("stopped");

    await env.shutdown();
    expect(env.status()).toBe("stopped");
  });

  it("stops the kernel even when the guest no longer answers", async () => {
    const kernel = new FakeKernel((file, args) => {
      const command = args.join(" ");
      if (command.includes("larpable-ok")) return { stdout: "larpable-ok" };
      if (command.includes("command -v")) return { stdout: "" };
      return { hang: true };
    });
    // A wedged guest: the shutdown budgets collapse to the command budget, so this
    // test measures "shutdown still stops the kernel", not the 15 s poweroff ceiling.
    const env = environment(kernel, { commandTimeoutMs: 20 });
    await env.initialize();
    await env.shutdown();

    expect(kernel.stopped).toBe(true);
    expect(env.status()).toBe("stopped");
    expect(kernel.kills).toContain("SIGKILL");
  });
});

describe("path rules", () => {
  it("normalises inside the workspace and rejects escapes", () => {
    expect(resolveWorkspacePath("/workspace", "src/App.tsx")).toBe("/workspace/src/App.tsx");
    expect(resolveWorkspacePath("/workspace", "/workspace//./a.txt")).toBe("/workspace/a.txt");
    expect(resolveWorkspacePath("/workspace", "/workspace/")).toBe("/workspace");
    expect(resolveWorkspacePath("/workspace", "")).toBe("/workspace");

    for (const bad of ["..", "../x", "../../etc/passwd", "/etc/passwd", "/workspace/../etc"]) {
      expect(() => resolveWorkspacePath("/workspace", bad)).toThrow(OutsideWorkspaceError);
    }
  });
});

describe("FakeEnvironment", () => {
  it("records ordering and gates commands on ready", async () => {
    const env = new FakeEnvironment({
      tree: { "package.json": "{}" },
      handlers: { "npm run build": { stdout: "built\n", exitCode: 0 } },
      runtime: "node 22",
    });

    await expect(env.execute("npm run build")).rejects.toBeInstanceOf(NotReadyError);

    await env.initialize();
    const result = await env.execute("npm run build");
    await env.readFile("package.json");
    await env.shutdown();

    expect(result.stdout).toBe("built\n");
    expect(env.calls.map((call) => call.method)).toEqual([
      "initialize",
      "execute",
      "readFile",
      "shutdown",
    ]);
    expect(env.snapshot().status).toBe("stopped");
  });

  it("answers unscripted commands with a visible failure, not a fake success", async () => {
    const env = new FakeEnvironment();
    await env.initialize();

    const result = await env.execute("npm install");
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("no script for");
  });

  it("surfaces a boot failure as the error state", async () => {
    const env = new FakeEnvironment({ initializeError: "no cross-origin isolation" });
    await expect(env.initialize()).rejects.toThrow(/cross-origin isolation/);
    expect(env.status()).toBe("error");
    expect(env.snapshot().error).toBe("no cross-origin isolation");
  });
});

describe("ExecutionResult shape", () => {
  it("keeps exit code and signal distinct", async () => {
    const kernel = new FakeKernel((file, args) => {
      const command = args.join(" ");
      if (command.includes("larpable-ok")) return { stdout: "larpable-ok" };
      if (command.includes("command -v")) return { stdout: "" };
      return { stderr: "Segmentation fault\n", end: { type: "signal", signal: 11 } };
    });
    const env = environment(kernel);
    await env.initialize();

    const result: ExecutionResult = await env.execute("./crash");
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe(11);
    expect(result.stderr).toContain("Segmentation fault");
  });
});
