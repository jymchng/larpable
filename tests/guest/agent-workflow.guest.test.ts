/**
 * The autonomous agent workflows of PRD §18.3-18.5, end to end in a real guest.
 *
 * `tests/agent-workflows.test.ts` proves the *decisions*: which tool the model is told to
 * call, in what order, and what the session says about the result. It does that against a
 * fake environment and a scripted compiler, which is the only way to run it on every commit.
 * This file proves the other half, and nothing else can: that the same session, the same
 * tools, the same build manager, the same Netlify flow and the same preview controller
 * operate on a real Debian guest — a real `npm install`, a real `vite build`, a real
 * `netlify.toml` on the mounted disk, and real HTTP bytes out of the guest's own loopback.
 *
 * What stays scripted is only the model's choices, because a test cannot depend on a
 * language model's mood. The `ScriptedProvider` below emits the same tool calls a model
 * would; every effect those calls have is real. The optional second test removes even that
 * script and drives a real model, but it needs a key and is skipped without one.
 *
 * The three flows, in one guest and one continuous conversation (which is itself the point:
 * a modify and a recovery happen on the project the previous flow built):
 *
 * 1. **Create (§18.3)** — scaffold, write the landing page, install, generate and validate
 *    `netlify.toml`, build, publish. The acceptance is a validated config, a `BuildResult`
 *    whose entry point was read back out of the guest, and a preview the guest answers over
 *    HTTP.
 * 2. **Modify (§18.4)** — the hero becomes dark with an animated gradient. The acceptance
 *    is a *new* build id, `netlify.toml` untouched byte for byte, and every section the user
 *    did not ask about still present in the built bundle.
 * 3. **Recover (§18.5)** — a real mismatched JSX tag makes a real `vite build` fail. The
 *    model is handed the compiler's own message, reads the file, repairs it, rebuilds and
 *    publishes. The acceptance is that the failure text quoted by the agent came from the
 *    compiler, not from this test.
 *
 * Skipped unless `LARPABLE_GUEST_TESTS=1`, like every other guest test: it needs Node >= 24
 * (JSPI), the Debian image in `public/distros/`, and outbound network on first run.
 *
 * ```sh
 * bun run fetch:distros   # once
 * bun run test:guest      # LARPABLE_GUEST_TESTS=1 under .tooling/node
 * ```
 */

import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BuildManager } from "@/build/manager";
import type { KernelLike } from "@/env/unkernel-kernel";
import { UnkernelEnvironment } from "@/env/unkernel-environment";
import { ensureNetlifyConfig } from "@/netlify/flow";
import type { NetlifyBuildOutput } from "@/netlify/validator";
import { DEFAULT_PREVIEW_PORT } from "@/preview/guest-server";
import { createPreviewController, type PreviewController } from "@/preview/controller";
import { RuntimeBootstrap } from "@/runtime/bootstrap";
import { detectRuntime } from "@/runtime/detect";
import { createAgentSession, finalAssistantText, type AgentSession } from "@/agent/session";
import type { AgentEvent } from "@/agent/loop";
import type { NetlifyPort } from "@/agent/tools/types";
import { OpenAICompatibleProvider } from "@/llm/openai";
import type {
  ConversationMessage,
  GenerateOptions,
  LLMProvider,
  LLMResponse,
  ToolCallRequest,
  ToolDefinition,
} from "@/llm/types";

const enabled = process.env.LARPABLE_GUEST_TESTS === "1";

const WORKSPACE = "/workspace";
const PROMPT =
  "Create a modern landing page for an AI coding assistant. Use React, TypeScript and Tailwind CSS. " +
  "Include a hero section, feature cards, pricing, testimonials and responsive navigation.";

// ---------------------------------------------------------------------------------------
// The source the scripted model writes. It has to be ordinary React + TS the guest's own
// vite can compile, because the point of the flow is that the build is real.
// ---------------------------------------------------------------------------------------

const LANDING_APP = `const features = [
  { title: "Reads your repository", body: "It inspects the project before it edits a file." },
  { title: "Builds for real", body: "A build is green only when vite wrote an entry point." },
  { title: "Deploys without surprises", body: "netlify.toml is generated and validated." },
];

export function App() {
  return (
    <div className="app">
      <nav className="nav" aria-label="Primary">
        <a className="nav__brand" href="/">Larpable</a>
        <ul className="nav__links">
          <li><a href="#features">Features</a></li>
          <li><a href="#pricing">Pricing</a></li>
          <li><a href="#testimonials">Testimonials</a></li>
        </ul>
      </nav>
      <header className="hero">
        <h1 className="hero__title">Ship a site before your coffee gets cold</h1>
        <p className="hero__lede">An AI coding assistant that scaffolds, builds and deploys in one browser tab.</p>
      </header>
      <section id="features" className="features">
        <h2>Features</h2>
        <ul>{features.map((feature) => <li key={feature.title}>{feature.title}: {feature.body}</li>)}</ul>
      </section>
      <section id="pricing" className="pricing">
        <h2>Pricing</h2>
        <p>Free while it is in beta.</p>
      </section>
      <section id="testimonials" className="testimonials">
        <h2>Testimonials</h2>
        <p>"It deployed my site while I was still describing it." - a beta user</p>
      </section>
    </div>
  );
}

export default App;
`;

/** The same page after §18.4: one class on the hero, and the gradient in the stylesheet. */
const MODIFIED_APP = LANDING_APP.replace(
  '<header className="hero">',
  '<header className="hero hero--dark">',
);

const LANDING_CSS = `.nav { display: flex; gap: 1rem; align-items: center; }
.nav__links { display: flex; gap: 1rem; list-style: none; }
.hero { padding: 4rem 1rem; background: #f6f7fb; }
.hero__title { font-size: 2.5rem; margin: 0 0 1rem; }
.features, .pricing, .testimonials { padding: 3rem 1rem; }
@media (max-width: 640px) { .nav__links { display: none; } }
`;

const MODIFIED_CSS = `${LANDING_CSS}
.hero--dark {
  background: #0b0b12;
  color: #f7f7ff;
  background-image: linear-gradient(120deg, #0b0b12, #2b1055, #0b0b12);
  background-size: 300% 300%;
  animation: heroGradient 12s ease infinite;
}
@keyframes heroGradient {
  0% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
  100% { background-position: 0% 50%; }
}
`;

/**
 * The §18.5 break: an opening `<h1>` closed by `</h2>`. A real compiler error that names
 * `src/App.tsx`, so the assertion on the tool result can be "the agent quoted the compiler"
 * rather than "the test quoted itself".
 */
const BROKEN_APP = MODIFIED_APP.replace(
  '<h1 className="hero__title">Ship a site before your coffee gets cold</h1>',
  '<h1 className="hero__title">Ship a site before your coffee gets cold</h2>',
);

// ---------------------------------------------------------------------------------------
// The deterministic provider. Every turn sees the previous tool results, which the script
// needs: `publish_preview` has to be given the id `build_project` just returned.
// ---------------------------------------------------------------------------------------

interface TurnState {
  lastBuildId: string | null;
  lastBuildOk: boolean | null;
}

interface ScriptedTurn {
  text?: string;
  calls?: readonly { name: string; arguments?: Record<string, unknown> }[];
}

class ScriptedProvider implements LLMProvider {
  readonly id = "scripted";
  readonly model = "scripted-1";
  readonly requests: { messages: readonly ConversationMessage[] }[] = [];

  readonly #state: TurnState;
  readonly #script: readonly ((state: TurnState) => ScriptedTurn)[];

  constructor(state: TurnState, script: readonly ((state: TurnState) => ScriptedTurn)[]) {
    this.#state = state;
    this.#script = script;
  }

  async generate(
    messages: readonly ConversationMessage[],
    _tools: readonly ToolDefinition[],
    _options?: GenerateOptions,
  ): Promise<LLMResponse> {
    const turn = this.requests.length;
    this.requests.push({ messages: [...messages] });

    const scripted = this.#script[turn];
    const spec: ScriptedTurn = scripted === undefined ? {} : scripted(this.#state);
    const toolCalls: ToolCallRequest[] = (spec.calls ?? []).map((call, index) => ({
      id: `call-${String(turn)}-${String(index)}`,
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    }));

    return {
      text: spec.text ?? "",
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    };
  }
}

// ---------------------------------------------------------------------------------------
// One guest, booted once: the expensive resource every flow shares.
// ---------------------------------------------------------------------------------------

interface Guest {
  environment: UnkernelEnvironment;
  manager: BuildManager;
  preview: PreviewController;
  runtime: RuntimeBootstrap;
  detected: Awaited<ReturnType<typeof detectRuntime>>;
  /** The Netlify flow as the tools see it: the real one, with the real build as evidence. */
  netlify: NetlifyPort;
  http(): NonNullable<ReturnType<UnkernelEnvironment["guestHttp"]>>;
  read(path: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function bootGuest(label: string): Promise<Guest> {
  const unkernel = await import("unkernel/node");
  const distro = new URL("../../public/distros/debian.erofs", import.meta.url).pathname;
  // A 4 GiB sparse disk with real blocks belongs on the checkout's disk, not in a tmpfs.
  const scratch = new URL("../../.tmp", import.meta.url).pathname;
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, `${label}-`));
  const diskPath = join(dir, "kwdata.img");

  const module = await WebAssembly.compile(
    await readFile(new URL("../../node_modules/unkernel/dist/unkernel.wasm", import.meta.url)),
  );
  const template = unkernel.bundledBoot(module).datadisk;
  expect(template, "the kernel carries a kwdata template").toBeTruthy();
  await unkernel.createImageFromKwsparse(diskPath, template as Uint8Array);

  type MountSource = NonNullable<Parameters<typeof unkernel.createKernel>[0]>["mounts"];

  const environment = new UnkernelEnvironment({
    distro,
    network: "direct",
    workspaceFs: new unkernel.MemoryFs(),
    memoryMiB: 2048,
    commandTimeoutMs: 900_000,
    kernelFactory: async (request) =>
      (await unkernel.createKernel({
        distro: request.distro,
        net: unkernel.directBackend(),
        disks: [await unkernel.openDisk(diskPath)],
        mounts: { "/workspace": request.mounts["/workspace"] } as MountSource,
        memoryMiB: request.memoryMiB,
      })) as unknown as KernelLike,
  });

  await environment.initialize();

  const runtime = new RuntimeBootstrap({
    environment,
    persistentDataDisk: true,
    warmupTimeoutMs: 900_000,
  });
  const warm = await runtime.ensureReady();
  expect(warm.state).toBe("ready");

  // Measured, not assumed: the manager uses whatever the guest actually answers.
  const detected = await detectRuntime(environment);

  const manager = new BuildManager({
    environment,
    runtime,
    framework: "react-ts",
    packageManager: detected.packageManager,
    installTimeoutMs: 900_000,
    buildTimeoutMs: 600_000,
  });

  const netlify: NetlifyPort = {
    ensure: async (options) => {
      const last = manager.lastSuccessfulBuild();
      const entries =
        last === null
          ? []
          : (await environment.listFiles(`${WORKSPACE}/${last.outputDir}`)).map(
              (entry) => entry.name,
            );
      const build: NetlifyBuildOutput | null =
        last === null
          ? null
          : {
              dir: last.outputDir,
              entryExists: last.entryPoint !== null,
              // The publish check reads the guest's own directory listing.
              entries,
            };
      return ensureNetlifyConfig(environment, {
        ...(options?.root === undefined ? {} : { root: options.root }),
        hints: {
          framework: "react-ts",
          packageManager: detected.packageManager,
          packageManagerVersion: detected.packageManagerVersion,
        },
        build,
      });
    },
  };

  const preview = createPreviewController({
    environment,
    // The real accessor the app uses: the host's only way into the guest's loopback.
    http: () => environment.guestHttp(),
    startTimeoutMs: 900_000,
  });

  return {
    environment,
    manager,
    preview,
    runtime,
    detected,
    netlify,
    http() {
      const http = environment.guestHttp();
      if (http === null) {
        throw new Error(
          "The guest has no HTTP transport, so the preview cannot be read back. " +
            "A kernel without `fetch()` has no loopback to serve from.",
        );
      }
      return http;
    },
    async read(path) {
      return new TextDecoder().decode(await environment.readFile(path));
    },
    async cleanup() {
      await preview.stop();
      await environment.shutdown();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The directory listing a Netlify publish check should see, read from the guest. */
async function distEntries(guest: Guest): Promise<string[]> {
  return (await guest.environment.listFiles(`${WORKSPACE}/dist`)).map((entry) => entry.name);
}

/** The hashed asset file names a real vite build wrote, by extension. */
async function assetsByExtension(guest: Guest, extension: string): Promise<string[]> {
  const entries = await guest.environment.listFiles(`${WORKSPACE}/dist/assets`);
  return entries
    .map((entry) => entry.name)
    .filter((name) => name.endsWith(extension))
    .sort();
}

describe.skipIf(!enabled)("§18.3-18.5 in the real guest", () => {
  const state: TurnState = { lastBuildId: null, lastBuildOk: null };
  let guest: Guest;
  let session: AgentSession;
  let provider: ScriptedProvider;
  /** Every tool result the model saw, in order. The recovery assertions read this. */
  const executions: { name: string; ok: boolean; content: string }[] = [];

  const script = [
    // --- §18.3: create ---------------------------------------------------------------
    () => ({
      calls: [
        { name: "scaffold_project", arguments: { framework: "react-ts", name: "ai-assistant-landing" } },
      ],
    }),
    () => ({
      calls: [
        { name: "write_file", arguments: { path: "src/App.tsx", content: LANDING_APP } },
        { name: "write_file", arguments: { path: "src/style.css", content: LANDING_CSS } },
      ],
    }),
    () => ({
      calls: [
        { name: "execute_command", arguments: { command: "npm install --no-audit --no-fund" } },
      ],
    }),
    () => ({ calls: [{ name: "ensure_netlify_config" }] }),
    () => ({ calls: [{ name: "build_project" }] }),
    (s: TurnState) => ({
      calls: [{ name: "publish_preview", arguments: { buildId: s.lastBuildId ?? "" } }],
    }),
    () => ({
      text:
        "Created the landing page: React + TypeScript, installed and built in the guest. " +
        "netlify.toml is generated and validated, and the preview is serving the build.",
    }),

    // --- §18.4: modify ---------------------------------------------------------------
    () => ({ calls: [{ name: "read_file", arguments: { path: "src/App.tsx" } }] }),
    () => ({
      calls: [
        { name: "write_file", arguments: { path: "src/App.tsx", content: MODIFIED_APP } },
        { name: "write_file", arguments: { path: "src/style.css", content: MODIFIED_CSS } },
      ],
    }),
    () => ({ calls: [{ name: "build_project" }] }),
    (s: TurnState) => ({
      calls: [{ name: "publish_preview", arguments: { buildId: s.lastBuildId ?? "" } }],
    }),
    () => ({
      text:
        "Changed the hero to a dark background with an animated gradient. The nav, features, " +
        "pricing and testimonials are untouched, the build succeeded and the preview is updated.",
    }),

    // --- §18.5: break, then recover --------------------------------------------------
    () => ({
      calls: [{ name: "write_file", arguments: { path: "src/App.tsx", content: BROKEN_APP } }],
    }),
    () => ({ calls: [{ name: "build_project" }] }),
    () => ({ calls: [{ name: "read_file", arguments: { path: "src/App.tsx" } }] }),
    () => ({
      calls: [{ name: "write_file", arguments: { path: "src/App.tsx", content: MODIFIED_APP } }],
    }),
    () => ({ calls: [{ name: "build_project" }] }),
    (s: TurnState) => ({
      calls: [{ name: "publish_preview", arguments: { buildId: s.lastBuildId ?? "" } }],
    }),
    () => ({
      text:
        "The build failed on a mismatched JSX closing tag in src/App.tsx; I fixed the tag, " +
        "the build is green again and the preview is serving the new build.",
    }),
  ];

  it(
    "creates, modifies and recovers a project that the guest really builds and serves",
    async () => {
      guest = await bootGuest("agent-workflow-guest");

      provider = new ScriptedProvider(state, script);
      session = createAgentSession({
        provider,
        environment: guest.environment,
        build: guest.manager,
        netlify: guest.netlify,
        preview: guest.preview,
        project: { exists: false },
        onEvent: (event: AgentEvent) => {
          if (event.type !== "tool-end") return;
          executions.push({
            name: event.execution.name,
            ok: event.execution.ok,
            content: event.execution.content,
          });
          if (event.execution.name !== "build_project") return;
          const data = event.execution.data as { buildId?: unknown } | undefined;
          state.lastBuildId = typeof data?.buildId === "string" ? data.buildId : null;
          state.lastBuildOk = event.execution.ok;
        },
      });

      try {
        // =================================================================================
        // §18.3 — create
        // =================================================================================
        const created = await session.send(PROMPT);

        expect(created.stop).toBe("complete");
        expect(
          created.executions.filter((execution) => !execution.ok),
          `failed tools: ${created.executions
            .filter((execution) => !execution.ok)
            .map((execution) => `${execution.name}: ${execution.content.slice(0, 400)}`)
            .join("\n")}`,
        ).toEqual([]);

        // The project exists as source on the guest's disk.
        expect(await guest.read(`${WORKSPACE}/package.json`)).toContain('"build": "vite build"');
        expect(await guest.read(`${WORKSPACE}/src/App.tsx`)).toContain("hero__title");

        // netlify.toml: written at the root by the flow, validated against the real build.
        const tomlBefore = await guest.read(`${WORKSPACE}/netlify.toml`);
        expect(tomlBefore).toContain('publish = "dist"');
        expect(tomlBefore).toContain(`command = "${guest.manager.lastSuccessfulBuild()?.command ?? ""}"`);
        expect(session.evidence().netlify).toEqual({ attempted: true, ok: true, errors: [] });

        // The build: a real vite run whose entry point was read back out of the workspace.
        const first = guest.manager.lastSuccessfulBuild();
        expect(first).not.toBeNull();
        expect(first?.ok).toBe(true);
        expect(first?.entryPoint).toBe(`${WORKSPACE}/dist/index.html`);
        expect(first?.entryBytes ?? 0).toBeGreaterThan(0);
        const firstId = first?.id ?? "";

        const html = await guest.read(`${WORKSPACE}/dist/index.html`);
        expect(html).toContain('<div id="app">');
        // vite fingerprints: a copied file would not have this tag.
        expect(html).toMatch(/<script[^>]+src="\/assets\/index-[A-Za-z0-9_-]+\.js"/);

        // The preview: published, labelled with that build, and the guest answers over HTTP.
        const ready = guest.preview.phase();
        expect(ready.kind).toBe("ready");
        if (ready.kind !== "ready") throw new Error("expected a ready preview");
        expect(ready.buildId).toBe(firstId);
        expect(ready.files).toBeGreaterThan(0);

        const servedHtml = await guest.http()(
          `http://127.0.0.1:${String(DEFAULT_PREVIEW_PORT)}/index.html`,
        );
        expect(servedHtml.status).toBe(200);
        expect(await servedHtml.text()).toContain('<div id="app">');

        const [cssAtFirst] = await assetsByExtension(guest, ".css");
        expect(cssAtFirst).toBeDefined();
        const servedCss = await guest.http()(
          `http://127.0.0.1:${String(DEFAULT_PREVIEW_PORT)}/assets/${cssAtFirst}`,
        );
        expect(servedCss.status).toBe(200);
        expect(await servedCss.text()).toContain(".hero");

        // And the reply is supported by that evidence.
        expect(created.claims.ok).toBe(true);
        expect(created.claims.findings).toEqual([]);

        // =================================================================================
        // §18.4 — modify an existing project
        // =================================================================================
        const modified = await session.send(
          "Change the hero section to use a dark background and add an animated gradient.",
        );

        expect(modified.stop).toBe("complete");
        expect(
          modified.executions.filter((execution) => !execution.ok),
          `failed tools: ${modified.executions
            .filter((execution) => !execution.ok)
            .map((execution) => `${execution.name}: ${execution.content.slice(0, 400)}`)
            .join("\n")}`,
        ).toEqual([]);

        // The requested change is in the source, and the deployment config is untouched.
        expect(await guest.read(`${WORKSPACE}/src/App.tsx`)).toContain('className="hero hero--dark"');
        expect(await guest.read(`${WORKSPACE}/netlify.toml`)).toBe(tomlBefore);

        // Everything the user did not ask about is still in the built bundle.
        const [jsAfter, cssAfter] = await Promise.all([
          assetsByExtension(guest, ".js"),
          assetsByExtension(guest, ".css"),
        ]);
        expect(jsAfter[0]).toBeDefined();
        expect(cssAfter[0]).toBeDefined();
        const bundle = await guest.read(`${WORKSPACE}/dist/assets/${jsAfter[0] ?? ""}`);
        expect(bundle).toContain("Features");
        expect(bundle).toContain("Pricing");
        expect(bundle).toContain("Testimonials");
        expect(bundle).toContain("hero--dark");

        const styles = await guest.read(`${WORKSPACE}/dist/assets/${cssAfter[0] ?? ""}`);
        expect(styles).toContain("@keyframes heroGradient");
        expect(styles).toContain("hero--dark");

        // A new build, and a preview that moved to it.
        const second = guest.manager.lastSuccessfulBuild();
        expect(second).not.toBeNull();
        expect(second?.id).not.toBe(firstId);
        expect(second?.entryPoint).toBe(`${WORKSPACE}/dist/index.html`);

        const readyAfter = guest.preview.phase();
        expect(readyAfter.kind).toBe("ready");
        if (readyAfter.kind !== "ready") throw new Error("expected a ready preview");
        expect(readyAfter.buildId).toBe(second?.id);

        // The updated stylesheet is what the guest's server actually returns.
        const servedUpdatedCss = await guest.http()(
          `http://127.0.0.1:${String(DEFAULT_PREVIEW_PORT)}/assets/${cssAfter[0] ?? ""}`,
        );
        expect(servedUpdatedCss.status).toBe(200);
        expect(await servedUpdatedCss.text()).toContain("@keyframes heroGradient");

        expect(modified.claims.ok).toBe(true);
        expect(modified.claims.findings).toEqual([]);

        // =================================================================================
        // §18.5 — build recovery
        // =================================================================================
        const recovered = await session.send(
          "The build broke after my last change. Find the error, fix the source, and get it green again.",
        );

        expect(recovered.stop).toBe("complete");

        // The failure the model was shown is the compiler's, and it names the file.
        const failedBuild = recovered.executions.find(
          (execution) => execution.name === "build_project" && !execution.ok,
        );
        expect(failedBuild, "the broken build must be reported as a failed tool call").toBeDefined();
        const failureText = failedBuild?.content ?? "";
        expect(failureText).toContain("src/App.tsx");
        expect(failureText).toMatch(/error|Expected|Unexpected|unclosed|Unexpected "/i);

        // A failed build is not a successful build, and the manager kept both.
        const history = guest.manager.history();
        expect(history.some((record) => !record.ok)).toBe(true);
        expect(history.filter((record) => record.ok).length).toBeGreaterThanOrEqual(2);

        // The files it read and the fix it wrote are real, and the break is gone.
        expect(recovered.executions.some((execution) => execution.name === "read_file")).toBe(true);
        const repaired = await guest.read(`${WORKSPACE}/src/App.tsx`);
        expect(repaired).toContain('<header className="hero hero--dark">');
        expect(repaired).toContain("</h1>");

        // And the last build is green, with a preview serving it.
        const third = guest.manager.lastSuccessfulBuild();
        expect(third).not.toBeNull();
        expect(third?.id).not.toBe(second?.id);
        expect(third?.entryPoint).toBe(`${WORKSPACE}/dist/index.html`);

        const readyFinal = guest.preview.phase();
        expect(readyFinal.kind).toBe("ready");
        if (readyFinal.kind !== "ready") throw new Error("expected a ready preview");
        expect(readyFinal.buildId).toBe(third?.id);

        // The sentence the user is left with is supported by that success, not just plausible.
        expect(finalAssistantText(recovered)).toContain("preview");
        expect(recovered.claims.ok).toBe(true);
        expect(recovered.claims.findings).toEqual([]);

        // The prompt the model was given is the one the tools support.
        const system = provider.requests[0]?.messages[0];
        expect(system?.role).toBe("system");
        expect(system?.content).toContain("When creating a new project");
      } finally {
        await guest.cleanup();
      }
    },
    3_600_000,
  );
});

// ---------------------------------------------------------------------------------------
// The same acceptance with a real model, when a key is present. Skipped otherwise, so this
// file still runs on a machine with no provider: the scripted test above is the contract,
// this one is the calibration.
// ---------------------------------------------------------------------------------------

const apiKey = process.env.LARPABLE_E2E_API_KEY ?? "";
const model = process.env.LARPABLE_E2E_MODEL ?? "gpt-4o-mini";

describe.skipIf(!enabled || apiKey.length === 0)("§18.3 with a real model", () => {
  it(
    "creates the landing page through the model's own tool choices",
    async () => {
      const guest = await bootGuest("agent-model-guest");
      const provider = new OpenAICompatibleProvider({
        apiKey,
        model,
        ...(process.env.LARPABLE_E2E_BASE_URL === undefined
          ? {}
          : { baseUrl: process.env.LARPABLE_E2E_BASE_URL }),
        timeoutMs: 180_000,
      });

      const session = createAgentSession({
        provider,
        environment: guest.environment,
        build: guest.manager,
        netlify: guest.netlify,
        preview: guest.preview,
        project: { exists: false },
        maxIterations: 40,
        turnTimeoutMs: 180_000,
        toolTimeoutMs: 900_000,
        secrets: [apiKey],
      });

      try {
        const result = await session.send(PROMPT);

        // The end state is the acceptance, whatever route the model took to it.
        expect(
          guest.manager.lastSuccessfulBuild(),
          `the model never produced a successful build (stopped: ${result.stop}, ` +
            `detail: ${result.reason}). Its last word: ${finalAssistantText(result).slice(0, 800)}`,
        ).not.toBeNull();

        expect(session.evidence().netlify).toEqual({ attempted: true, ok: true, errors: [] });
        expect(await guest.read(`${WORKSPACE}/netlify.toml`)).toContain('publish = "dist"');

        const phase = guest.preview.phase();
        expect(phase.kind, `the preview never became ready: ${JSON.stringify(phase)}`).toBe("ready");

        // A model that oversells a half-finished run fails here, which is the point.
        expect(result.claims.ok, `unsupported claims: ${JSON.stringify(result.claims.findings)}`).toBe(
          true,
        );
      } finally {
        await guest.cleanup();
      }
    },
    3_600_000,
  );
});
