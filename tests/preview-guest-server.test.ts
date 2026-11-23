/**
 * The guest-side server driver, driven by a stub instead of a VM.
 *
 * `startPreviewServer` is the one piece of the preview that cannot be tested in a browser
 * or in a pure function: it writes a file into the guest, runs it, and waits for that
 * process to say it is listening. The barrier is the interesting part — a fixed sleep is
 * either slow on every build or too short on the first one, when the guest's `node` shim
 * may still be downloading a runtime — so most of these tests are about the ways it can
 * fail and whether the failure says anything useful.
 *
 * The emitted script itself is asserted here too: it is a string, so the compiler never
 * sees it, and its MIME table used to be a second copy of `routing.ts`'s.
 */

import { describe, expect, it } from "vitest";

import type { ExecutionEnvironment, ExecutionOptions, ExecutionResult } from "../src/env/execution";
import {
  DEFAULT_PREVIEW_PORT,
  PREVIEW_LISTEN_MARKER,
  PREVIEW_MANIFEST_PATH,
  PREVIEW_SERVER_DIR,
  PREVIEW_SERVER_SCRIPT,
  previewServerSource,
  startPreviewServer,
} from "../src/preview/guest-server";
import { MIME_TYPES, mimeTypeFor } from "../src/preview/routing";

interface Recorder {
  written: { path: string; content: string }[];
  directories: string[];
  commands: { file: string; args: readonly string[]; options: ExecutionOptions }[];
}

type Execute = (
  file: string,
  args: readonly string[],
  options: ExecutionOptions,
) => Promise<ExecutionResult>;

/** The smallest environment `startPreviewServer` needs, with a scripted `executeArgv`. */
function stubEnvironment(execute: Execute): { environment: ExecutionEnvironment; recorder: Recorder } {
  const recorder: Recorder = { written: [], directories: [], commands: [] };
  const environment = {
    workspacePath: "/workspace",
    status: () => "ready",
    snapshot: () => {
      throw new Error("not used");
    },
    onStatus: () => () => undefined,
    initialize: async () => undefined,
    execute: async () => {
      throw new Error("not used");
    },
    openShell: async () => {
      throw new Error("not used");
    },
    executeArgv: (file: string, args: readonly string[] = [], options: ExecutionOptions = {}) => {
      recorder.commands.push({ file, args, options });
      return execute(file, args, options);
    },
    readFile: async () => new Uint8Array(0),
    writeFile: async (path: string, content: string | Uint8Array) => {
      recorder.written.push({ path, content: String(content) });
    },
    listFiles: async () => [],
    createDirectory: async (path: string) => {
      recorder.directories.push(path);
    },
    removeFile: async () => undefined,
    shutdown: async () => undefined,
  } as unknown as ExecutionEnvironment;
  return { environment, recorder };
}

function result(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    command: "node",
    argv: ["node"],
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    truncated: false,
    ...overrides,
  };
}

/** A server that prints the marker and then stays up until the command is aborted. */
function listeningServer() {
  return (
    _file: string,
    _args: readonly string[],
    options: ExecutionOptions,
  ): Promise<ExecutionResult> =>
    new Promise<ExecutionResult>((resolve) => {
      options.onOutput?.({ stream: "stdout", text: `${PREVIEW_LISTEN_MARKER} 8123 /workspace/dist\n` });
      // Abort is how the driver stops the process; resolve then, as a real guest would.
      options.signal?.addEventListener("abort", () => resolve(result({ exitCode: null })), {
        once: true,
      });
    });
}

describe("startPreviewServer", () => {
  it("writes the script into the workspace and runs Node on it", async () => {
    const { environment, recorder } = stubEnvironment(listeningServer());
    const server = await startPreviewServer(environment, { timeoutMs: 2_000 });
    expect(recorder.directories).toEqual(["/workspace/.larpable"]);
    expect(recorder.written).toHaveLength(1);
    expect(recorder.written[0]?.path).toBe(`/workspace/${PREVIEW_SERVER_DIR}/${PREVIEW_SERVER_SCRIPT}`);
    expect(recorder.written[0]?.content).toContain("createServer");
    expect(recorder.commands[0]?.file).toBe("node");
    expect(recorder.commands[0]?.args.slice(0, 3)).toEqual([
      `/workspace/${PREVIEW_SERVER_DIR}/${PREVIEW_SERVER_SCRIPT}`,
      String(DEFAULT_PREVIEW_PORT),
      "/workspace/dist",
    ]);
    await server.stop();
  });

  it("serves the workspace's dist directory by default and a named one on request", async () => {
    const first = await startPreviewServer(stubEnvironment(listeningServer()).environment, {
      timeoutMs: 2_000,
    });
    expect(first.root).toBe("/workspace/dist");
    expect(first.port).toBe(DEFAULT_PREVIEW_PORT);
    await first.stop();

    const second = await startPreviewServer(stubEnvironment(listeningServer()).environment, {
      root: "build",
      port: 9000,
      timeoutMs: 2_000,
    });
    expect(second.root).toBe("/workspace/build");
    expect(second.port).toBe(9000);
    await second.stop();
  });

  it("lets a runtime be named, for an image whose node is somewhere else", async () => {
    const { environment, recorder } = stubEnvironment(listeningServer());
    const server = await startPreviewServer(environment, {
      command: { file: "/usr/lib/kw/bin/node", args: ["--experimental-strip-types"] },
      timeoutMs: 2_000,
    });
    expect(recorder.commands[0]?.file).toBe("/usr/lib/kw/bin/node");
    expect(recorder.commands[0]?.args[0]).toBe("--experimental-strip-types");
    await server.stop();
  });

  it("fails with the process's own output when it exits before listening", async () => {
    // The classic cause: the guest's `node` shim exits 127 on its first call.
    const { environment } = stubEnvironment(async () =>
      result({ exitCode: 127, stderr: "sh: node: not found\n" }),
    );
    await expect(startPreviewServer(environment, { timeoutMs: 2_000 })).rejects.toThrow(
      /exited before it was listening \(exit 127\): sh: node: not found/,
    );
  });

  it("fails with the last lines of output when it never listens", async () => {
    const { environment } = stubEnvironment(
      (_file, _args, options) =>
        new Promise<ExecutionResult>((resolve) => {
          options.onOutput?.({ stream: "stderr", text: "starting…\nreading files\n" });
          options.signal?.addEventListener("abort", () => resolve(result({ exitCode: null })), {
            once: true,
          });
        }),
    );
    await expect(startPreviewServer(environment, { timeoutMs: 120 })).rejects.toThrow(
      /was not listening after 120 ms: starting… \| reading files/,
    );
  });

  it("aborts the guest process on stop()", async () => {
    const { environment, recorder } = stubEnvironment(listeningServer());
    const server = await startPreviewServer(environment, { timeoutMs: 2_000 });
    expect(recorder.commands[0]?.options.signal?.aborted).toBe(false);
    await server.stop();
    expect(recorder.commands[0]?.options.signal?.aborted).toBe(true);
  });

  it("reads files and the manifest through the injected fetch, not a global", async () => {
    const seen: string[] = [];
    const responses: Record<string, string> = {
      [PREVIEW_MANIFEST_PATH]: JSON.stringify({ files: [{ path: "/index.html", size: 5 }] }),
      "/index.html": "<html></html>",
    };
    const { environment } = stubEnvironment(listeningServer());
    const server = await startPreviewServer(environment, {
      timeoutMs: 2_000,
      fetch: async (url: string) => {
        seen.push(url);
        const path = new URL(url).pathname;
        const body = responses[path];
        if (body === undefined) return new Response("not found", { status: 404 });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });

    await expect(server.listFiles()).resolves.toEqual([{ path: "/index.html", size: 5 }]);
    const file = await server.readFile("/index.html");
    expect(file.status).toBe(200);
    expect(file.contentType).toBe("text/html; charset=utf-8");
    expect(new TextDecoder().decode(file.body)).toBe("<html></html>");
    expect(seen).toEqual([
      `http://127.0.0.1:${String(DEFAULT_PREVIEW_PORT)}${PREVIEW_MANIFEST_PATH}`,
      `http://127.0.0.1:${String(DEFAULT_PREVIEW_PORT)}/index.html`,
    ]);
    await server.stop();
  });

  it("reports a manifest that did not answer rather than returning no files", async () => {
    const { environment } = stubEnvironment(listeningServer());
    const server = await startPreviewServer(environment, {
      timeoutMs: 2_000,
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await expect(server.listFiles()).rejects.toThrow(/manifest answered 500/);
    await server.stop();
  });
});

describe("previewServerSource", () => {
  it("takes its MIME table from the routing module, so there is only one", () => {
    const source = previewServerSource();
    // The table is embedded as JSON; parse it back out and compare extension by extension.
    const match = /const TYPES = (\{.*?\});/s.exec(source);
    expect(match).not.toBeNull();
    const embedded = JSON.parse(match?.[1] ?? "{}") as Record<string, string>;
    expect(Object.keys(embedded).sort()).toEqual(Object.keys(MIME_TYPES).sort());
    for (const [extension, type] of Object.entries(embedded)) {
      expect(mimeTypeFor(`/file${extension}`)).toBe(type);
    }
  });

  it("prints a marker nothing else can be mistaken for", () => {
    expect(previewServerSource()).toContain(PREVIEW_LISTEN_MARKER);
    expect(PREVIEW_LISTEN_MARKER).not.toBe("");
  });

  it("refuses paths outside the publish directory", () => {
    // The server is a generic static file server; a path that escapes it would read the
    // workspace, including an .env the user never meant to publish.
    expect(previewServerSource()).toContain("insideRoot");
  });
});
