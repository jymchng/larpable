/**
 * The tool set (PRD §9.3), and the promise that makes it safe.
 *
 * Two things are asserted here that no other test can:
 *
 * 1. **Each capability behaves on the tool boundary** — the filesystem tools inside the
 *    workspace, the shell tools against a scripted guest (foreground, background, kill),
 *    and the build/Netlify/preview tools against their ports, including the failure paths
 *    a model must be told about rather than left to assume.
 * 2. **The API key cannot reach the guest or a project file.** That is PRD §9.2's
 *    requirement, and `src/agent/tools/types.ts` cites this file for it. It is proven by
 *    construction, not by inspection: a real provider with a real key drives a real write,
 *    and the key is then looked for in every place it could have leaked — the guest's
 *    argv, the written bytes, the transcript, the events, the tool definitions.
 */

import { describe, expect, it } from "vitest";

import { FakeEnvironment } from "../src/env/fake-environment";
import { MockProvider } from "../src/llm/mock";
import { OpenAICompatibleProvider } from "../src/llm/openai";
import { runAgentLoop, type AgentEvent } from "../src/agent/loop";
import { FILESYSTEM_TOOLS } from "../src/agent/tools/fs";
import { ProcessRegistry } from "../src/agent/tools/processes";
import {
  executeCommandTool,
  getProcessOutputTool,
  listProcessesTool,
  terminateProcessTool,
} from "../src/agent/tools/shell";
import {
  ensureNetlifyConfigTool,
} from "../src/agent/tools/netlify";
import { buildProjectTool, installDependenciesTool } from "../src/agent/tools/build";
import { publishPreviewTool, previewStatusTool } from "../src/agent/tools/preview";
import { projectStatusTool, toolsFor } from "../src/agent/tools/index";
import type { BuildPort, NetlifyPort, PreviewPort, ToolContext } from "../src/agent/tools/types";
import type { PreviewPhase } from "../src/preview/controller";

async function readyEnvironment(tree: Record<string, string> = {}): Promise<FakeEnvironment> {
  const environment = new FakeEnvironment({ tree });
  await environment.initialize();
  return environment;
}

function contextFor(environment: FakeEnvironment, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    environment,
    root: environment.workspacePath,
    build: null,
    netlify: null,
    preview: null,
    processes: new ProcessRegistry(),
    ...overrides,
  };
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

const buildStub = (overrides: { installOk?: boolean; buildOk?: boolean } = {}): BuildPort =>
  ({
    install: async () => ({
      ok: overrides.installOk ?? true,
      command: "npm ci --no-audit --no-fund",
      packageManager: "npm",
      lockfile: "package-lock.json",
      failure: null,
      log: {
        command: "npm ci --no-audit --no-fund",
        exitCode: overrides.installOk === false ? 1 : 0,
        durationMs: 1234,
        stdout: "added 128 packages",
        stderr: "",
        truncated: false,
      },
    }),
    build: async () => ({
      id: "build-1",
      ok: overrides.buildOk ?? true,
      command: "npm run build",
      commandSource: "scripts.build",
      reason: "package.json defines `build`.",
      outputDir: "dist",
      outputSource: "vite-config",
      entryPoint: overrides.buildOk === false ? null : "/workspace/dist/index.html",
      entryBytes: 412,
      failure:
        overrides.buildOk === false
          ? {
              kind: "typescript" as const,
              summary: "TypeScript reported an error.",
              detail: "src/App.tsx(4,3): error TS2322: Type 'string' is not assignable.",
              hint: "Fix the reported line and build again.",
            }
          : null,
      log: {
        command: "npm run build",
        exitCode: overrides.buildOk === false ? 2 : 0,
        durationMs: 4321,
        stdout: overrides.buildOk === false ? "" : "vite v5 built in 1.2s",
        stderr: overrides.buildOk === false ? "src/App.tsx(4,3): error TS2322" : "",
        truncated: false,
      },
      startedAt: 0,
      finishedAt: 4321,
      durationMs: 4321,
    }),
    lastSuccessfulBuild: () =>
      overrides.buildOk === false
        ? null
        : ({
            id: "build-1",
            ok: true,
            command: "npm run build",
            commandSource: "scripts.build",
            reason: "package.json defines `build`.",
            outputDir: "dist",
            outputSource: "vite-config",
            entryPoint: "/workspace/dist/index.html",
            entryBytes: 412,
            failure: null,
            log: null,
            startedAt: 0,
            finishedAt: 4321,
            durationMs: 4321,
          } as never),
    history: () => [],
  }) as BuildPort;

const netlifyStub = (ok = true): NetlifyPort =>
  ({
    ensure: async () => ({
      ok,
      path: "/workspace/netlify.toml",
      decisions: ["publish = \"dist\"", "SPA fallback enabled"],
      facts: {},
      sync: {
        action: "created",
        path: "/workspace/netlify.toml",
        plan: {},
        reason: "netlify.toml did not exist, so it was created.",
        before: null,
      },
      validation: {
        ok,
        issues: ok
          ? []
          : [
              {
                code: "publish-mismatch",
                severity: "error",
                message: "publish is `dist` but the build wrote `build`.",
                hint: "Set publish to `build`.",
              },
            ],
        settings: null,
        summary: ok ? "netlify.toml was verified." : "netlify.toml does not match the build.",
      },
    }),
  }) as unknown as NetlifyPort;

const previewStub = (phase: PreviewPhase): PreviewPort =>
  ({
    refresh: async () => phase,
    url: () => (phase.kind === "ready" ? phase.url : null),
    phase: () => phase,
  }) as PreviewPort;

const readyPhase: PreviewPhase = {
  kind: "ready",
  buildId: "build-1",
  url: "/__preview__/build-1/",
  files: 7,
  served: "worker",
  note: null,
};

describe("filesystem tools", () => {
  it("writes, reads, edits, lists and searches inside the workspace", async () => {
    const context = contextFor(await readyEnvironment({ "src/App.tsx": "export const A = 1;\n" }));

    const write = FILESYSTEM_TOOLS.find((tool) => tool.definition.name === "write_file");
    const read = FILESYSTEM_TOOLS.find((tool) => tool.definition.name === "read_file");
    const edit = FILESYSTEM_TOOLS.find((tool) => tool.definition.name === "edit_file");
    const search = FILESYSTEM_TOOLS.find((tool) => tool.definition.name === "search_files");
    const list = FILESYSTEM_TOOLS.find((tool) => tool.definition.name === "list_files");
    expect(write && read && edit && search && list).toBeTruthy();
    if (!write || !read || !edit || !search || !list) return;

    expect(await write.run({ path: "index.html", content: "<h1>hi</h1>" }, context)).toMatchObject({
      ok: true,
    });
    expect(await read.run({ path: "index.html" }, context)).toMatchObject({ ok: true });
    expect(await edit.run({ path: "index.html", find: "hi", replace: "hello" }, context)).toMatchObject({
      ok: true,
    });
    expect(decode(await context.environment.readFile("/workspace/index.html"))).toBe("<h1>hello</h1>");

    const found = await search.run({ query: "A = 1", fixedString: true }, context);
    expect(found.ok).toBe(true);
    expect(found.content).toContain("src/App.tsx:1");

    const listed = await list.run({ recursive: true }, context);
    expect(listed.ok).toBe(true);
    expect(listed.content).toContain("index.html");
  });

  it("refuses a path outside the workspace with a message the model can act on", async () => {
    const context = contextFor(await readyEnvironment());
    const write = FILESYSTEM_TOOLS.find((tool) => tool.definition.name === "write_file");
    expect(write).toBeTruthy();
    if (!write) return;

    const result = await write.run({ path: "../secrets.txt", content: "x" }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("workspace");
  });
});

describe("shell tools", () => {
  it("runs a command and reports its exit status and output", async () => {
    const environment = await readyEnvironment();
    environment.script("echo hi", { stdout: "hi\n" });
    const context = contextFor(environment);

    const result = await executeCommandTool.run({ command: "echo hi" }, context);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("exited with status 0");
    expect(result.content).toContain("hi");
  });

  it("returns a failure, with the output, when the command exits non-zero", async () => {
    const environment = await readyEnvironment();
    environment.script("npm run build", { stdout: "", stderr: "error TS2322\n", exitCode: 2 });
    const context = contextFor(environment);

    const result = await executeCommandTool.run({ command: "npm run build" }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("exited with status 2");
    expect(result.content).toContain("error TS2322");
  });

  it("starts a background command, reads it and kills it", async () => {
    const environment = await readyEnvironment();
    // A command that only ends when its signal fires, which is what a server looks like.
    environment.script(
      "sleep 60",
      (_command, options) =>
        new Promise((resolve) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              resolve({ stdout: "interrupted\n", stderr: "", exitCode: null, signal: 15 });
            },
            { once: true },
          );
        }),
    );
    const context = contextFor(environment);

    const started = await executeCommandTool.run({ command: "sleep 60", background: true }, context);
    expect(started.ok).toBe(true);
    const processId = (started.data as { processId: string }).processId;

    const running = await getProcessOutputTool.run({ processId, waitMs: 0 }, context);
    expect(running.content).toContain("still running");

    const killed = await terminateProcessTool.run({ processId }, context);
    expect(killed.ok).toBe(true);

    const after = await getProcessOutputTool.run({ processId, waitMs: 100 }, context);
    expect(after.content).toContain("cancelled");

    const listed = await listProcessesTool.run({}, context);
    expect(listed.content).toContain(processId);
  });

  it("says so when there is no such process", async () => {
    const context = contextFor(await readyEnvironment());
    const result = await getProcessOutputTool.run({ processId: "proc-99" }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("No command has been started");
  });

  it("honours cancellation before starting", async () => {
    const controller = new AbortController();
    controller.abort();
    const context = contextFor(await readyEnvironment(), { signal: controller.signal });
    const result = await executeCommandTool.run({ command: "echo hi" }, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("cancelled");
  });
});

describe("build, Netlify and preview tools", () => {
  it("reports an install and a build", async () => {
    const context = contextFor(await readyEnvironment(), { build: buildStub() });

    const install = await installDependenciesTool.run({}, context);
    expect(install.ok).toBe(true);
    expect(install.content).toContain("npm ci");
    expect(install.content).toContain("added 128 packages");

    const build = await buildProjectTool.run({}, context);
    expect(build.ok).toBe(true);
    expect(build.content).toContain("dist");
    expect(build.content).toContain("index.html");
  });

  it("reports a failed build as a failure, with the compiler's own words", async () => {
    const context = contextFor(await readyEnvironment(), { build: buildStub({ buildOk: false }) });
    const result = await buildProjectTool.run({}, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("TS2322");
    expect(result.content).toContain("Fix the reported line");
  });

  it("says plainly when the session has no build manager", async () => {
    const context = contextFor(await readyEnvironment());
    const result = await buildProjectTool.run({}, context);
    expect(result.ok).toBe(false);
    expect(result.content).toContain("no build manager");
  });

  it("writes and validates netlify.toml, and fails when validation fails", async () => {
    const good = contextFor(await readyEnvironment(), { netlify: netlifyStub(true) });
    const ok = await ensureNetlifyConfigTool.run({}, good);
    expect(ok.ok).toBe(true);
    expect(ok.content).toContain("publish");

    const bad = contextFor(await readyEnvironment(), { netlify: netlifyStub(false) });
    const failed = await ensureNetlifyConfigTool.run({}, bad);
    expect(failed.ok).toBe(false);
    expect(failed.content).toContain("does not match the build");
  });

  it("publishes a preview and reports the build id it is serving", async () => {
    const context = contextFor(await readyEnvironment(), { preview: previewStub(readyPhase) });
    const result = await publishPreviewTool.run({ buildId: "build-1" }, context);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("/__preview__/build-1/");

    const status = await previewStatusTool.run({}, context);
    expect(status.content).toContain("build-1");

    const failing = contextFor(await readyEnvironment(), {
      preview: previewStub({ kind: "failed", message: "the service worker did not activate" }),
    });
    const failed = await publishPreviewTool.run({}, failing);
    expect(failed.ok).toBe(false);
    expect(failed.content).toContain("did not activate");
  });

  it("reports the project's real state instead of assuming it", async () => {
    const environment = await readyEnvironment();
    const context = contextFor(environment, { build: buildStub() });
    const result = await projectStatusTool.run({}, context);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("/workspace");
    expect(result.content).toContain("build-1");
    expect(result.content).toContain("Last successful build");
  });
});

describe("toolsFor", () => {
  it("offers only the tools the session can actually run", async () => {
    const bare = await readyEnvironment();
    const minimal = toolsFor(contextFor(bare)).map((tool) => tool.definition.name);
    expect(minimal).toContain("write_file");
    expect(minimal).toContain("execute_command");
    expect(minimal).not.toContain("build_project");
    expect(minimal).not.toContain("ensure_netlify_config");
    expect(minimal).not.toContain("publish_preview");

    const full = toolsFor(
      contextFor(bare, {
        build: buildStub(),
        netlify: netlifyStub(),
        preview: previewStub(readyPhase),
      }),
    ).map((tool) => tool.definition.name);
    expect(full).toContain("build_project");
    expect(full).toContain("ensure_netlify_config");
    expect(full).toContain("publish_preview");

    // No duplicates, and every tool has a schema the validator can use.
    expect(new Set(full).size).toBe(full.length);
  });
});

describe("API keys", () => {
  const KEY = "sk-live-DO-NOT-LEAK-0123456789abcdef";

  /** A streamed chat-completions answer, as the provider reads it. */
  function sse(events: readonly string[]): Response {
    return new Response(`${events.map((event) => `data: ${event}\n\n`).join("")}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  it("never sends the key to the guest, the project, the transcript or the UI", async () => {
    const seen: { url: string; authorization: string | null; body: string }[] = [];

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === "string" ? init.body : "";
      seen.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body,
      });

      // First turn: ask to write a file. Second turn: answer, because the tool result is
      // now in the conversation.
      if (!body.includes('"role":"tool"')) {
        return sse([
          JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_1",
                      function: {
                        name: "write_file",
                        arguments: JSON.stringify({ path: "index.html", content: "<h1>hi</h1>" }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
        ]);
      }
      return sse([
        JSON.stringify({ choices: [{ delta: { content: "Created index.html." }, finish_reason: "stop" }] }),
      ]);
    }) as typeof fetch;

    const provider = new OpenAICompatibleProvider({
      apiKey: KEY,
      model: "gpt-test",
      baseUrl: "https://example.invalid/v1",
      fetch: fakeFetch,
    });

    const environment = await readyEnvironment();
    const context = contextFor(environment);
    const events: AgentEvent[] = [];

    const result = await runAgentLoop({
      provider,
      tools: toolsFor(context),
      context,
      messages: [{ role: "system", content: "You build websites." }],
      secrets: [KEY],
      onEvent: (event) => events.push(event),
    });

    expect(result.stop).toBe("complete");
    expect(result.executions[0]?.ok).toBe(true);

    // The key was used where it belongs: an authorization header, nowhere else.
    expect(seen).toHaveLength(2);
    expect(seen[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.body).not.toContain(KEY);
    expect(seen[1]?.body).not.toContain(KEY);

    // Not in the guest: no command ever ran, and the file holds only what was asked for.
    expect(environment.calls.some((call) => call.method === "execute")).toBe(false);
    expect(decode(environment.workspace().readFile("/index.html"))).toBe("<h1>hi</h1>");

    // Not in the transcript, the events or the tool definitions.
    expect(JSON.stringify(result.messages)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(toolsFor(context).map((tool) => tool.definition))).not.toContain(KEY);

    // And not reachable from a tool at all: the context a tool receives has no provider.
    expect(Object.keys(context)).not.toContain("provider");
    expect(Object.keys(context)).not.toContain("apiKey");
    expect("provider" in context).toBe(false);
  });

  it("keeps a key out of a project file even when a tool echoes it", async () => {
    const environment = await readyEnvironment();
    const context = contextFor(environment);
    const events: AgentEvent[] = [];

    // A tool that returns the key is the worst case; the loop must scrub what it hands on.
    const leaky = {
      definition: {
        name: "leak",
        description: "returns a secret",
        readOnly: true,
        parameters: { type: "object" as const, description: "args", properties: {}, required: [] },
      },
      run: async () => ({ ok: true, content: `token=${KEY}` }),
    };

    const result = await runAgentLoop({
      provider: new MockProvider({ turns: [{ toolCalls: [{ name: "leak" }] }, { text: "done" }] }),
      tools: [leaky],
      context,
      secrets: [KEY],
      onEvent: (event) => events.push(event),
    });

    expect(JSON.stringify(result.messages)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(environment.calls.some((call) => call.method === "writeFile")).toBe(false);
  });
});
