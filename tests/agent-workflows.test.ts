/**
 * The autonomous workflows of PRD §18.3-18.5, driven by the deterministic provider.
 *
 * What is real here, and what is not — stated up front, because a workflow test that
 * quietly faked the interesting half would prove nothing:
 *
 * - **Real:** the tool set (`scaffold_project`, `write_file`, `edit_file`,
 *   `install_dependencies` for the install, `ensure_netlify_config`, `build_project`, `publish_preview`),
 *   the `BuildManager` (command detection, log capture, failure classification, the
 *   entry-point check), `ensureNetlifyConfig` (facts, generation, validation of the file on
 *   disk), the preview controller's state machine, the loop's ordering and validation, the
 *   session's prompt and its claims check.
 * - **Scripted:** the model's decisions (a deterministic provider, so the same conversation
 *   runs every time) and the compiler. The guest's `vite` is replaced by a handler that
 *   fails when `src/App.tsx` contains the seeded break token and otherwise writes the
 *   output a real build would — so the *build result follows the source file the agent
 *   edited*, which is the causal link §18.5 is about.
 *
 * The three flows, and what each one is for:
 *
 * 1. **Create (§18.3)** — landing page: scaffold, write, install, generate and validate
 *    `netlify.toml`, build, publish. The acceptance is the state at the end: a validated
 *    config, a `BuildResult` whose entry point was read back out of the guest, and a preview
 *    serving that build id.
 * 2. **Modify (§18.4)** — the hero becomes dark with a gradient, and everything the user did
 *    not ask about is proven still there (nav, features, pricing, testimonials, and the
 *    untouched `netlify.toml`), with a *new* build id and a preview that moved to it.
 * 3. **Recover (§18.5)** — the seeded compile error makes the first build fail; the model
 *    receives the compiler's own line, reads the file, edits it, rebuilds and publishes.
 *
 * A fourth group proves the other half of "failures are reported as failures": the session's
 * claims check must flag a reply that claims a build succeeded when none did, and must not
 * fire on an honest one.
 */

import { describe, expect, it } from "vitest";

import { BuildManager } from "@/build/manager";
import { createPreviewController, type PreviewController } from "@/preview/controller";
import { listPublishFiles } from "@/preview/build-id";
import { ensureNetlifyConfig } from "@/netlify/flow";
import type { NetlifyBuildOutput } from "@/netlify/validator";
import { FakeEnvironment } from "@/env/fake-environment";
import { scaffoldProject } from "@/runtime/scaffold";
import { createAgentSession, finalAssistantText, type AgentSession } from "@/agent/session";
import { describeFindings } from "@/agent/claims";
import type { AgentEvent } from "@/agent/loop";
import type { NetlifyPort, PreviewPort } from "@/agent/tools/types";
import type {
  ConversationMessage,
  GenerateOptions,
  LLMProvider,
  LLMResponse,
  ToolCallRequest,
  ToolDefinition,
} from "@/llm/types";

const WORKSPACE = "/workspace";

/** The build output a real `vite build` for the landing page would write, near enough. */
const CSS = `.nav { display: flex; gap: 1rem; }
.hero { padding: 4rem 1rem; background: #f6f7fb; }
.features, .pricing, .testimonials { padding: 3rem 1rem; }
`;

const APP = `const features = [
  { title: "Reads your repository", body: "It inspects the project before it edits a file." },
  { title: "Builds for real", body: "A build is only green when vite produced an entry point." },
  { title: "Deploys without surprises", body: "netlify.toml is generated and validated, not guessed." },
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
        <p>“It deployed my site while I was still describing it.” — a beta user</p>
      </section>
    </div>
  );
}

export default App;
`;

/** The same project, with the compile error the recovery flow has to survive. */
const BROKEN_APP = APP.replace(
  '<h1 className="hero__title">',
  '<h1 className="hero__title <<<BROKEN>>>">',
);

/** What the "compiler" says when it meets the seeded break. */
const COMPILE_ERROR = `src/App.tsx:22:26: error: Expected identifier but found "<"
22 |         <h1 className="hero__title <<<BROKEN>>>">
   |                          ^
vite v5.4.11 building for production...
✗ Build failed in 412 ms`;

/** A stable fingerprint of a source file, so two builds of different sources differ. */
function hashOf(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------------------
// A deterministic provider whose turns can read what the previous tool call returned.
//
// `MockProvider` takes a fixed script, which cannot express "publish the build you just
// made" — and passing the real build id is exactly what PRD §10 step 11 asks the agent to
// do. This provider keeps that ability and stays fully deterministic.
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
  readonly requests: { messages: readonly ConversationMessage[]; tools: readonly ToolDefinition[] }[] = [];

  readonly #state: TurnState;
  readonly #script: readonly ((state: TurnState) => ScriptedTurn)[];

  constructor(state: TurnState, script: readonly ((state: TurnState) => ScriptedTurn)[]) {
    this.#state = state;
    this.#script = script;
  }

  async generate(
    messages: readonly ConversationMessage[],
    tools: readonly ToolDefinition[],
    _options?: GenerateOptions,
  ): Promise<LLMResponse> {
    const turn = this.requests.length;
    this.requests.push({ messages: [...messages], tools: [...tools] });

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
// The harness: one environment, one build manager, one Netlify step, one preview, one session.
// ---------------------------------------------------------------------------------------

type Seed = "empty" | "project" | "broken";

interface HarnessOptions {
  seed: Seed;
  /** Scripted decisions. Each turn sees the build id the last `build_project` returned. */
  script: readonly ((state: TurnState) => ScriptedTurn)[];
}

interface Harness {
  environment: FakeEnvironment;
  manager: BuildManager;
  preview: PreviewController;
  /** Build ids the fake preview session was asked to publish, in order. */
  publishes: string[];
  provider: ScriptedProvider;
  session: AgentSession;
  state: TurnState;
  read(path: string): Promise<string>;
}

async function harness(options: HarnessOptions): Promise<Harness> {
  const project = scaffoldProject({ framework: "react-ts", name: "ai-assistant-landing" });
  const tree: Record<string, string> =
    options.seed === "empty"
      ? {}
      : {
          ...project.files,
          "src/App.tsx": options.seed === "broken" ? BROKEN_APP : APP,
          "src/style.css": CSS,
        };

  const environment = new FakeEnvironment({ tree });
  await environment.initialize();

  // The install, as the guest's Bun answers it. A real `bun install` is tens of seconds and
  // needs the network (`docs/performance.md`: 41.9 s for 67 packages); what this test needs
  // from it is the exit status and the log line the agent reads.
  environment.script("bun install", () => ({
    stdout: "Resolved, downloaded and extracted [84]\nSaved lockfile\n",
    durationMs: 5_000,
  }));

  /**
   * The compiler. A build fails when `src/App.tsx` still contains the seeded break, and
   * otherwise writes the entry point and hashed assets vite would write. Reading the source
   * is what makes the recovery flow causal: the agent's edit is the only thing that changes
   * the verdict.
   */
  environment.script("bun run build", async () => {
    const source = decode(await environment.readFile(`${WORKSPACE}/src/App.tsx`));
    if (source.includes("<<<BROKEN>>>")) {
      return { exitCode: 2, stdout: "", stderr: COMPILE_ERROR, durationMs: 412 };
    }

    const hash = hashOf(source);
    await environment.writeFile(
      `${WORKSPACE}/dist/index.html`,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Larpable</title>` +
        `<script type="module" crossorigin src="/assets/index-${hash}.js"></script>` +
        `<link rel="stylesheet" crossorigin href="/assets/index-${hash}.css"></head>` +
        `<body><div id="app"></div></body></html>`,
    );
    await environment.writeFile(`${WORKSPACE}/dist/assets/index-${hash}.js`, "console.log('app');\n");
    await environment.writeFile(
      `${WORKSPACE}/dist/assets/index-${hash}.css`,
      ".hero--dark{background:#0b0b12;color:#f7f7ff}\n",
    );

    return {
      stdout:
        "vite v5.4.11 building for production...\n✓ 34 modules transformed.\n" +
        `dist/index.html 0.46 kB\ndist/assets/index-${hash}.css 1.21 kB\ndist/assets/index-${hash}.js 42.10 kB\n` +
        "✓ built in 812ms\n",
      durationMs: 812,
    };
  });

  let clock = 1_000;
  const manager = new BuildManager({
    environment,
    framework: "react-ts",
    // The app's own manager prefers Bun (`src/ui/use-build.ts`), so the flow is driven the
    // way the product drives it rather than through a manager the product no longer uses.
    packageManager: "bun",
    now: () => (clock += 10),
    nextId: (sequence) => `build-${String(sequence)}`,
  });

  const buildOutput = (): NetlifyBuildOutput | null => {
    const last = manager.lastSuccessfulBuild();
    if (last === null) return null;
    return { dir: last.outputDir, entryExists: last.entryPoint !== null, entries: ["index.html", "assets"] };
  };

  const netlify: NetlifyPort = {
    ensure: (ensureOptions) =>
      ensureNetlifyConfig(environment, {
        ...(ensureOptions?.root === undefined ? {} : { root: ensureOptions.root }),
        hints: { framework: "react-ts", packageManager: "bun", packageManagerVersion: "1.4.5" },
        build: buildOutput(),
      }),
  };

  const publishes: string[] = [];
  let published: string | null = null;
  const guestHttp = async (): Promise<Response> => new Response("", { status: 200 });

  const preview = createPreviewController({
    environment,
    http: () => guestHttp,
    // The session's own state machine is real; only the guest's server is replaced, because
    // the guest's server is what `tests/preview-guest-server.test.ts` and the gated guest run
    // cover. This fake publishes what `listPublishFiles` finds, like the real one.
    startSession: async () => ({
      port: 8123,
      root: `${WORKSPACE}/dist`,
      get url() {
        return published === null ? null : `/__preview__/${published}/`;
      },
      get buildId() {
        return published;
      },
      async publish(buildId: string) {
        published = buildId;
        publishes.push(buildId);
        const files = await listPublishFiles(environment, "dist");
        return { kind: "published" as const, buildId, files: files.length, waited: false };
      },
      async serve() {
        return null;
      },
      async stop() {
        published = null;
      },
    }),
  });

  // The session seeds the first build/preview before the conversation starts, for the flows
  // that modify an existing project.
  if (options.seed === "project") {
    await ensureNetlifyConfig(environment, {
      hints: { framework: "react-ts", packageManager: "bun", packageManagerVersion: "1.4.5" },
    });
    const first = await manager.build();
    expect(first.ok, `the seeded project must build: ${first.failure?.summary ?? ""}`).toBe(true);
    await preview.refresh(first.id);
  }

  const state: TurnState = { lastBuildId: null, lastBuildOk: null };
  const provider = new ScriptedProvider(state, options.script);

  const session = createAgentSession({
    provider,
    environment,
    build: manager,
    netlify,
    preview,
    project: options.seed === "empty" ? { exists: false } : { exists: true, framework: "react-ts", packageManager: "bun" },
    onEvent: (event: AgentEvent) => {
      if (event.type !== "tool-end" || event.execution.name !== "build_project") return;
      const data = event.execution.data as { buildId?: unknown } | undefined;
      state.lastBuildId = typeof data?.buildId === "string" ? data.buildId : null;
      state.lastBuildOk = event.execution.ok;
    },
  });

  return {
    environment,
    manager,
    preview: preview as PreviewController,
    publishes,
    provider,
    session,
    state,
    async read(path: string) {
      return decode(await environment.readFile(path));
    },
  };
}

const CREATE_PROMPT =
  "Create a modern landing page for an AI coding assistant. Use React, TypeScript and Tailwind CSS. " +
  "Include a hero section, feature cards, pricing, testimonials and responsive navigation.";

describe("§18.3 create: a landing page from nothing to a published build", () => {
  it("ends with a validated netlify.toml, a successful build and a preview of that build", async () => {
    const h = await harness({
      seed: "empty",
      script: [
        // 1-3: the scaffold and the source files.
        () => ({ calls: [{ name: "scaffold_project", arguments: { framework: "react-ts", name: "ai-assistant-landing" } }] }),
        () => ({
          calls: [
            { name: "write_file", arguments: { path: "src/App.tsx", content: APP } },
            { name: "write_file", arguments: { path: "src/style.css", content: CSS } },
          ],
        }),
        // 4-6: install, configure, build. The install goes through `install_dependencies`,
        // which is Bun-only and reports the guest's own failure instead of substituting npm.
        () => ({ calls: [{ name: "install_dependencies" }] }),
        () => ({ calls: [{ name: "ensure_netlify_config" }] }),
        () => ({ calls: [{ name: "build_project" }] }),
        // 7: publish the build the tool just reported.
        (state) => ({ calls: [{ name: "publish_preview", arguments: { buildId: state.lastBuildId ?? "" } }] }),
        () => ({
          text:
            "Created the landing page: React + TypeScript + Vite, installed and built in the guest. " +
            "netlify.toml is validated and the preview is serving the build.",
        }),
      ],
    });

    const result = await h.session.send(CREATE_PROMPT);

    expect(result.stop).toBe("complete");
    expect(result.executions.every((execution) => execution.ok)).toBe(true);

    // The project exists as source, written through the tools rather than invented.
    expect(await h.read(`${WORKSPACE}/src/App.tsx`)).toContain('className="hero"');
    expect(await h.read(`${WORKSPACE}/package.json`)).toContain('"build": "vite build"');

    // netlify.toml: written at the root, derived from the project, and validated.
    const toml = await h.read(`${WORKSPACE}/netlify.toml`);
    expect(toml).toContain('command = "bun run build"');
    expect(toml).toContain('publish = "dist"');
    expect(h.session.evidence().netlify).toEqual({ attempted: true, ok: true, errors: [] });

    // The build: a real record with an entry point read back out of the workspace.
    const build = h.manager.lastSuccessfulBuild();
    expect(build).not.toBeNull();
    expect(build?.id).toBe("build-1");
    expect(build?.entryPoint).toBe(`${WORKSPACE}/dist/index.html`);
    expect(await h.read(`${WORKSPACE}/dist/index.html`)).toContain('id="app"');

    // The preview: ready, labelled with the build that produced it, from the files on disk.
    const phase = h.preview.phase();
    expect(phase.kind).toBe("ready");
    if (phase.kind !== "ready") throw new Error("expected a ready preview");
    expect(phase.buildId).toBe(build?.id);
    expect(phase.url).toBe("/__preview__/build-1/");
    expect(phase.files).toBeGreaterThan(0);
    expect(h.publishes).toEqual(["build-1"]);

    // And the reply is supported by that evidence.
    expect(result.claims.ok).toBe(true);
    expect(result.claims.findings).toEqual([]);
  });

  it("gives the model the §10 create procedure, not just a tool list", async () => {
    const h = await harness({
      seed: "empty",
      script: [() => ({ text: "Which framework would you like?" })],
    });

    await h.session.send(CREATE_PROMPT);

    const system = h.provider.requests[0]?.messages[0];
    expect(system?.role).toBe("system");
    const prompt = system?.content ?? "";
    expect(prompt).toContain("When creating a new project");
    expect(prompt).toContain("`scaffold_project`");
    expect(prompt).toContain("`netlify.toml` is mandatory");
    expect(prompt).toContain("Never claim that a build succeeded without a successful `build_project` result");
    expect(prompt).toContain("no project yet");

    // Every tool the prompt lists is one the loop was actually given.
    const offered = (h.provider.requests[0]?.tools ?? []).map((tool) => tool.name);
    expect(offered).toContain("scaffold_project");
    expect(offered).toContain("build_project");
    expect(offered).toContain("ensure_netlify_config");
    expect(offered).toContain("publish_preview");
  });

  it("refuses to scaffold over a project that already exists", async () => {
    const h = await harness({
      seed: "project",
      script: [
        () => ({ calls: [{ name: "scaffold_project", arguments: { framework: "react-ts" } }] }),
        () => ({ text: "There is already a project here, so I read it instead of replacing it." }),
      ],
    });

    const result = await h.session.send("Start a new React project here.");

    const attempted = result.executions[0];
    expect(attempted?.name).toBe("scaffold_project");
    expect(attempted?.ok).toBe(false);
    expect(attempted?.content).toContain("already exists");
    expect(attempted?.content).toContain("modify it instead of scaffolding over it");

    // The existing source survived: that is the point of the guard.
    expect(await h.read(`${WORKSPACE}/src/App.tsx`)).toBe(APP);
  });
});

describe("§18.4 modify: a dark hero, everything else untouched", () => {
  it("rebuilds, republishes under a new id, and preserves the rest of the page", async () => {
    const h = await harness({
      seed: "project",
      script: [
        // Inspect first, as the modify procedure requires.
        () => ({ calls: [{ name: "read_file", arguments: { path: "src/App.tsx" } }] }),
        () => ({
          calls: [
            {
              name: "edit_file",
              arguments: {
                path: "src/App.tsx",
                find: '<header className="hero">',
                replace: '<header className="hero hero--dark">',
              },
            },
            {
              name: "edit_file",
              arguments: {
                path: "src/style.css",
                find: ".hero { padding: 4rem 1rem; background: #f6f7fb; }",
                replace:
                  ".hero { padding: 4rem 1rem; background: #f6f7fb; }\n" +
                  ".hero--dark { background: linear-gradient(135deg, #05060a, #1b1140); color: #f7f7ff; }",
              },
            },
          ],
        }),
        () => ({ calls: [{ name: "build_project" }] }),
        (state) => ({ calls: [{ name: "publish_preview", arguments: { buildId: state.lastBuildId ?? "" } }] }),
        () => ({ text: "Made the hero dark with an animated gradient. The build succeeded and the preview is updated." }),
      ],
    });

    const before = h.manager.lastSuccessfulBuild();
    expect(before?.id).toBe("build-1");

    const netlifyBefore = await h.read(`${WORKSPACE}/netlify.toml`);
    const appBefore = await h.read(`${WORKSPACE}/src/App.tsx`);

    const result = await h.session.send("Change the hero section to use a dark background and add an animated gradient.");

    expect(result.stop).toBe("complete");
    expect(result.executions.every((execution) => execution.ok)).toBe(true);

    // The change landed…
    const appAfter = await h.read(`${WORKSPACE}/src/App.tsx`);
    expect(appAfter).toContain('className="hero hero--dark"');
    expect(await h.read(`${WORKSPACE}/src/style.css`)).toContain("linear-gradient(135deg, #05060a, #1b1140)");

    // …and nothing else did: the nav, the three sections and their copy are byte-identical.
    for (const marker of ['id="features"', 'id="pricing"', 'id="testimonials"', 'className="nav"', "Free while it is in beta."]) {
      expect(appAfter).toContain(marker);
    }
    expect(appAfter.replace('<header className="hero hero--dark">', '<header className="hero">')).toBe(appBefore);

    // The deployment configuration did not change, because the settings did not.
    expect(await h.read(`${WORKSPACE}/netlify.toml`)).toBe(netlifyBefore);

    // A new build, and the preview moved to it rather than staying on the old one.
    const after = h.manager.lastSuccessfulBuild();
    expect(after?.id).toBe("build-2");
    expect(after?.id).not.toBe(before?.id);
    expect(h.manager.history()).toHaveLength(2);

    const phase = h.preview.phase();
    expect(phase.kind).toBe("ready");
    if (phase.kind !== "ready") throw new Error("expected a ready preview");
    expect(phase.buildId).toBe("build-2");
    expect(h.publishes).toEqual(["build-1", "build-2"]);

    expect(result.claims.ok).toBe(true);
  });
});

describe("§18.5 recovery: the log reaches the agent, the fix reaches the build", () => {
  it("fails, reads the compiler, fixes the source, rebuilds and publishes the new build", async () => {
    const h = await harness({
      seed: "broken",
      script: [
        // 1: build first — the agent does not know the file is broken until it tries.
        () => ({ calls: [{ name: "build_project" }] }),
        // 2: the failure is now in the conversation; read the file it names.
        () => ({ calls: [{ name: "read_file", arguments: { path: "src/App.tsx" } }] }),
        // 3: the smallest correct edit.
        () => ({
          calls: [
            { name: "edit_file", arguments: { path: "src/App.tsx", find: " <<<BROKEN>>>", replace: "" } },
          ],
        }),
        // 4: build again.
        () => ({ calls: [{ name: "build_project" }] }),
        (state) => ({ calls: [{ name: "publish_preview", arguments: { buildId: state.lastBuildId ?? "" } }] }),
        () => ({
          text:
            "The build failed on a stray token in src/App.tsx. I removed it, rebuilt successfully, " +
            "and the preview is serving the new build.",
        }),
      ],
    });

    const result = await h.session.send("Build the site and get it previewing.");

    expect(result.stop).toBe("complete");

    // 1. The first build really failed, and the tool said so in the compiler's words.
    const failed = result.executions[0];
    expect(failed?.name).toBe("build_project");
    expect(failed?.ok).toBe(false);
    expect(failed?.content).toContain("Build failed:");
    expect(failed?.content).toContain('Expected identifier but found "<"');
    expect(failed?.content).toContain("src/App.tsx:22:26");

    // 2. That failure was handed to the model, as an error message it had to deal with.
    const secondRequest = h.provider.requests[1]?.messages ?? [];
    const toolMessage = secondRequest.find(
      (message) => message.role === "tool" && message.name === "build_project",
    );
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.role === "tool" ? toolMessage.isError : false).toBe(true);
    expect(JSON.stringify(secondRequest)).toContain("Expected identifier but found");

    // 3. The fix is in the file, and the second build is a different verdict.
    expect(await h.read(`${WORKSPACE}/src/App.tsx`)).not.toContain("<<<BROKEN>>>");
    const history = h.manager.history();
    expect(history).toHaveLength(2);
    expect(history[0]?.ok).toBe(false);
    expect(history[1]?.ok).toBe(true);
    expect(history[1]?.failure).toBeNull();

    // 4. The preview shows the repaired build, and the failed one was never published.
    const phase = h.preview.phase();
    expect(phase.kind).toBe("ready");
    if (phase.kind !== "ready") throw new Error("expected a ready preview");
    expect(phase.buildId).toBe(history[1]?.id);
    expect(h.publishes).toEqual([history[1]?.id]);

    // 5. The claim is now true, and the session says so.
    expect(result.claims.ok).toBe(true);
  });

  it("reports a build that fails again as still failing, rather than looping silently", async () => {
    const h = await harness({
      seed: "broken",
      script: [
        () => ({ calls: [{ name: "build_project" }] }),
        // A "fix" that does not fix anything: the marker is still in the file.
        () => ({
          calls: [
            { name: "edit_file", arguments: { path: "src/App.tsx", find: '<h1 className="hero__title', replace: '<h1 className="hero__title' } },
          ],
        }),
        () => ({ calls: [{ name: "build_project" }] }),
        () => ({ text: "The build still fails on src/App.tsx:22:26. I have not been able to fix it yet." }),
      ],
    });

    const result = await h.session.send("Build it.");

    expect(result.executions.filter((execution) => execution.name === "build_project").map((e) => e.ok)).toEqual([
      false,
      false,
    ]);
    expect(h.manager.history()).toHaveLength(2);
    expect(h.manager.lastSuccessfulBuild()).toBeNull();
    expect(h.preview.phase().kind).not.toBe("ready");

    // The reply admits the failure, so the claims check has nothing to flag.
    expect(result.claims.ok).toBe(true);
  });
});

describe("failures are reported as failures", () => {
  it("flags a claim that a build succeeded when none was attempted", async () => {
    const h = await harness({
      seed: "empty",
      script: [() => ({ text: "Done! The build succeeded and the site is deployment-ready." })],
    });

    const result = await h.session.send("Build it.");

    expect(result.claims.ok).toBe(false);
    const codes = result.claims.findings.map((finding) => finding.code);
    expect(codes).toContain("build-not-verified");
    expect(codes).toContain("netlify-not-validated");

    const buildFinding = result.claims.findings.find((finding) => finding.code === "build-not-verified");
    expect(buildFinding?.sentence).toContain("The build succeeded");
    expect(buildFinding?.evidence).toContain("no build was attempted");
    expect(buildFinding?.correction).toContain("build_project");

    // The findings are printable, which is what a UI or an E2E report uses.
    expect(describeFindings(result.claims).join("\n")).toContain("build-not-verified");
  });

  it("flags a claim that a build succeeded when the build failed", async () => {
    const h = await harness({
      seed: "broken",
      script: [
        () => ({ calls: [{ name: "build_project" }] }),
        () => ({ text: "All set — the build succeeded and the preview is live." }),
      ],
    });

    const result = await h.session.send("Build and preview it.");

    expect(result.claims.ok).toBe(false);
    const failed = result.claims.findings.find((finding) => finding.code === "build-failed");
    expect(failed).toBeDefined();
    expect(failed?.evidence).toContain("the last build failed");
    expect(failed?.evidence).toContain("Expected identifier");

    // …and the preview claim is flagged too: nothing was published.
    expect(result.claims.findings.map((finding) => finding.code)).toContain("preview-not-published");
  });

  it("does not fire on an honest negative", async () => {
    const h = await harness({
      seed: "broken",
      script: [
        () => ({ calls: [{ name: "build_project" }] }),
        () => ({ text: "The build did not succeed: src/App.tsx has a stray token at line 22." }),
      ],
    });

    const result = await h.session.send("Build it.");

    expect(result.claims.ok).toBe(true);
    expect(result.claims.findings).toEqual([]);
    // The claim check reads the reply, not the running commentary.
    expect(finalAssistantText({ ...result })).toContain("did not succeed");
  });
});
