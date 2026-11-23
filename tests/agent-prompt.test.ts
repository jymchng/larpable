/**
 * The system prompt (PRD §10).
 *
 * A prompt is easy to test badly — "does the string contain the word build" — and the
 * failures that matter here are structural, so that is what is asserted:
 *
 * - the §10 procedures exist, in order, and each step names the **tool** that performs it,
 *   because a step the model cannot execute is a step it will describe instead of doing;
 * - the mandatory Netlify rules and the two truthfulness prohibitions are present verbatim
 *   in substance, and the truthfulness section is *last* (models weight the end of a long
 *   prompt, and this is the failure that costs the most trust);
 * - the tool list is generated from the definitions handed in, so the prompt cannot offer a
 *   tool the session does not have — the drift `src/agent/prompt.ts` exists to prevent;
 * - a missing capability changes the instructions, not just the list: no build manager must
 *   produce a sentence telling the model not to claim a build.
 */

import { describe, expect, it } from "vitest";

import {
  BUN_RULES,
  CREATE_PROCEDURE,
  MODIFY_PROCEDURE,
  NETLIFY_RULES,
  TRUTHFULNESS_RULES,
  WORKING_RULES,
  buildSystemPrompt,
  systemMessage,
  type PromptCapabilities,
} from "../src/agent/prompt";
import type { ToolDefinition } from "../src/llm/types";

const EVERYTHING: PromptCapabilities = { build: true, netlify: true, preview: true };

function tool(name: string, description = `${name} does a thing`): ToolDefinition {
  return {
    name,
    description,
    readOnly: true,
    parameters: { type: "object", description: `${name} arguments`, properties: {}, required: [] },
  };
}

const TOOLS: readonly ToolDefinition[] = [
  tool("read_file"),
  tool("write_file"),
  tool("execute_command"),
  tool("build_project"),
  tool("ensure_netlify_config"),
  tool("publish_preview"),
];

function prompt(over: { capabilities?: PromptCapabilities; tools?: readonly ToolDefinition[] } = {}): string {
  return buildSystemPrompt({
    root: "/workspace",
    tools: over.tools ?? TOOLS,
    capabilities: over.capabilities ?? EVERYTHING,
  });
}

describe("the procedures are PRD §10's, in order, with tool names", () => {
  it("has the twelve create steps, each naming the tool that performs it", () => {
    expect(CREATE_PROCEDURE).toHaveLength(12);

    const steps = CREATE_PROCEDURE.join("\n");
    expect(steps).toContain("scaffold_project"); // 3: scaffold
    expect(steps).toContain("write_file"); // 4: source files
    expect(steps).toContain("install_dependencies"); // 5: install, with the guest's Bun
    expect(steps).toContain("ensure_netlify_config"); // 6/7: generate and validate
    expect(steps).toContain("build_project"); // 8: build
    expect(steps).toContain("publish_preview"); // 11: preview
    expect(steps).toContain("preview_status"); // 12: confirm rendering
  });

  it("keeps the numbered order of the PRD (scaffold before install before build before preview)", () => {
    const at = (text: string): number => CREATE_PROCEDURE.findIndex((step) => step.includes(text));
    expect(at("scaffold_project")).toBeLessThan(at("Install dependencies"));
    expect(at("Install dependencies")).toBeLessThan(at("ensure_netlify_config"));
    expect(at("ensure_netlify_config")).toBeLessThan(at("build_project"));
    expect(at("build_project")).toBeLessThan(at("publish_preview"));
  });

  it("has the seven modify steps, led by inspection and ending at the preview", () => {
    expect(MODIFY_PROCEDURE).toHaveLength(7);

    const steps = MODIFY_PROCEDURE.join("\n");
    expect(MODIFY_PROCEDURE[0]).toContain("list_files");
    expect(MODIFY_PROCEDURE[0]).toContain("read_file");
    expect(steps).toContain("Preserve existing functionality");
    expect(steps).toContain("edit_file");
    expect(steps).toContain("ensure_netlify_config");
    expect(MODIFY_PROCEDURE[6]).toContain("publish_preview");
  });
});

describe("the rules that make the agent trustworthy", () => {
  it("states that netlify.toml is mandatory and generated, never hand-written", () => {
    const rules = NETLIFY_RULES.join("\n");
    expect(rules).toContain("`netlify.toml` is mandatory");
    expect(rules).toContain("Never write `netlify.toml` by hand");
    expect(rules).toContain("ready to deploy");
  });

  it("carries PRD §10's two prohibitions, in substance and in wording", () => {
    const rules = TRUTHFULNESS_RULES.join("\n");
    expect(rules).toMatch(/Never claim that a build succeeded without a successful `build_project` result/);
    expect(rules).toMatch(/Never claim that the website is deployment-ready/);
    expect(rules).toMatch(/Never claim the preview is showing the site unless `publish_preview` returned `ready`/);
  });

  it("puts the truthfulness section last, where it is read", () => {
    const text = prompt();
    const truthfulness = text.lastIndexOf("# Never claim what you cannot show");
    expect(truthfulness).toBeGreaterThan(0);
    expect(text.lastIndexOf("# ")).toBe(truthfulness);
  });

  it("tells the model to prefer a tool over a shell command", () => {
    expect(WORKING_RULES.join("\n")).toContain("Prefer the specific tool to a shell command");
  });
});

describe("Bun, and installing it when the guest has none", () => {
  it("tells the model to use Bun for every dependency job, and names the commands", () => {
    const rules = BUN_RULES.join("\n");
    expect(rules).toContain("`bun install`");
    expect(rules).toContain("`bun run <script>`");
    expect(rules).toContain("`bun add <package>`");
    expect(rules).toContain("`bunx <tool>`");
    expect(rules).toContain("Do not use `npm`, `npx`, `yarn` or `pnpm` in its place");
  });

  it("says to install Bun when `bun --version` fails, and to verify it worked", () => {
    const rules = BUN_RULES.join("\n");
    expect(rules).toContain("bun.sh/install");
    expect(rules).toContain("~/.bun/bin/bun --version");
    // The setup command is a suggestion; the guest's own `bun --version` is the evidence.
    expect(rules).toContain("Then retry the install");
  });

  it("forbids substituting npm, so the tool's own refusal is not a surprise", () => {
    const rules = BUN_RULES.join("\n");
    expect(rules).toContain('Never "make it work" by installing with npm');
    expect(rules).toContain("Bun-only");
  });

  it("is in the system message, before the tool list it constrains", () => {
    const text = prompt();
    for (const rule of BUN_RULES) expect(text).toContain(rule);
    expect(text.indexOf("# Bun is the package manager")).toBeGreaterThan(0);
    expect(text.indexOf("# Bun is the package manager")).toBeLessThan(
      text.indexOf("# What you can do in this session"),
    );
  });

  it("puts installing Bun in the create procedure's own install step", () => {
    expect(CREATE_PROCEDURE[4]).toContain("install Bun");
    expect(CREATE_PROCEDURE[4]).toContain("`install_dependencies`");
  });
});

describe("the prompt is built from the session, not from a wish", () => {
  it("lists exactly the tools it was given, and no others", () => {
    const text = prompt({ tools: [tool("frobnicate", "Frobnicates the site.")] });

    expect(text).toContain("`frobnicate` — Frobnicates the site.");
    // The create procedure names build_project in prose, but the *tool list* must not offer
    // a tool the session does not have. Count the list entries, not the mentions.
    const listed = text
      .split("\n")
      .filter((line) => /^- `[a-z_]+` — /.test(line))
      .map((line) => line.slice(3, line.indexOf("` — ")));
    expect(listed).toEqual(["frobnicate"]);
  });

  it("says what is missing instead of letting the model promise it", () => {
    const none: PromptCapabilities = { build: false, netlify: false, preview: false };
    const text = prompt({ capabilities: none });

    expect(text).toContain("no build manager");
    expect(text).toContain("never claim a build");
    expect(text).toContain("no Netlify configuration step");
    expect(text).toContain("Never describe a project as deployment-ready");
    expect(text).toContain("no preview controller");
    expect(text).not.toContain("This session can scaffold, install, build, configure Netlify");
  });

  it("says so when the session has everything", () => {
    const text = prompt();
    expect(text).toContain("This session can scaffold, install, build, configure Netlify and publish a preview");
    expect(text).not.toContain("There is **no");
  });

  it("names the project root the session actually has", () => {
    const text = buildSystemPrompt({ root: "/workspace/sites/my-site", tools: TOOLS, capabilities: EVERYTHING });
    expect(text).toContain("`/workspace/sites/my-site`");
    expect(text).not.toContain("root is `/workspace`");
  });

  it("tells the model which procedure applies, from the project state", () => {
    const existing = buildSystemPrompt({
      root: "/workspace",
      tools: TOOLS,
      capabilities: EVERYTHING,
      project: { exists: true, framework: "react-ts", packageManager: "npm" },
    });
    expect(existing).toContain("modify procedure");
    expect(existing).toContain("`react-ts`");
    expect(existing).toContain("`npm`");

    const empty = buildSystemPrompt({
      root: "/workspace",
      tools: TOOLS,
      capabilities: EVERYTHING,
      project: { exists: false },
    });
    expect(empty).toContain("no project yet");
    expect(empty).toContain("create procedure");
  });

  it("appends caller instructions without disturbing the rest", () => {
    const text = buildSystemPrompt({
      root: "/workspace",
      tools: TOOLS,
      capabilities: EVERYTHING,
      instructions: "The user prefers Tailwind CSS.",
    });
    expect(text).toContain("# Additional instructions");
    expect(text).toContain("The user prefers Tailwind CSS.");
  });

  it("is deterministic: same options, same bytes", () => {
    expect(prompt()).toBe(prompt());
  });

  it("arrives as a system message", () => {
    const message = systemMessage({ root: "/workspace", tools: TOOLS, capabilities: EVERYTHING });
    expect(message.role).toBe("system");
    expect(message.content).toBe(prompt());
  });
});
