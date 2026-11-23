/**
 * The project tool, and the registry that assembles a tool set (PRD §9.3).
 *
 * `project_status` exists because an agent's most common mistake is acting on a stale
 * belief: it "knows" the project is a Vite app, or "remembers" a successful build from
 * three turns ago. This tool makes it read the four facts that decide what to do next —
 * the guest, the last build, the Netlify file's validity, the preview — from the things
 * that actually own them.
 *
 * The registry is context-dependent on purpose. A build manager, a Netlify step and a
 * preview controller are capabilities, not settings: a session that has none of them must
 * not be offered `build_project`, because a tool that can only answer "I cannot do that"
 * teaches the model to stop trying rather than to work with what it has.
 */

import { clampText, defineTool, success, type AgentTool, type ToolContext } from "./types";
import { BUILD_TOOLS } from "./build";
import { FILESYSTEM_TOOLS } from "./fs";
import { NETLIFY_TOOLS } from "./netlify";
import { PREVIEW_TOOLS } from "./preview";
import { scaffoldProjectTool } from "./scaffold";
import { SHELL_TOOLS } from "./shell";

export const projectStatusTool: AgentTool = defineTool(
  {
    name: "project_status",
    description:
      "Report the project's real state: the Linux guest, the last build, netlify.toml and the " +
      "preview. Use it instead of assuming what a previous turn left behind.",
    readOnly: true,
    parameters: {
      type: "object",
      description: "project_status arguments",
      properties: {},
      required: [],
    },
  },
  async (_args, context) => {
    const snapshot = context.environment.snapshot();
    const lines: string[] = [
      `Project root: ${context.root}`,
      `Linux: ${snapshot.status}${snapshot.distro === null ? "" : ` (${snapshot.distro})`}${
        snapshot.error === null ? "" : ` — ${snapshot.error}`
      }`,
      `Runtime: ${snapshot.runtime ?? "not detected"}`,
    ];

    const build = context.build?.lastSuccessfulBuild() ?? null;
    lines.push(
      build === null
        ? "Last successful build: none"
        : `Last successful build: ${build.id}, ${build.outputDir} (${build.entryPoint ?? "entry point unverified"})`,
    );

    lines.push(
      context.netlify === null
        ? "netlify.toml: not managed in this session"
        : "netlify.toml: call ensure_netlify_config to create or validate it",
    );

    if (context.preview === null) {
      lines.push("Preview: not managed in this session");
    } else {
      const phase = context.preview.phase();
      lines.push(
        phase.kind === "ready"
          ? `Preview: ${phase.url} (build ${phase.buildId})`
          : `Preview: ${phase.kind}`,
      );
    }

    return success(clampText(lines.join("\n")), {
      status: snapshot.status,
      build: build?.id ?? null,
      preview: context.preview?.phase().kind ?? null,
    });
  },
);

/**
 * Tools every session has: they need only the environment and the process registry.
 *
 * `scaffold_project` is here rather than behind a port because the templates are part of
 * the app, not a capability the guest provides: a workspace with a file system can always
 * write them. PRD §10's create procedure names scaffolding as a step, so a session that
 * cannot offer it would be a session the prompt has to warn about.
 */
export const CORE_TOOLS: readonly AgentTool[] = [
  ...FILESYSTEM_TOOLS,
  ...SHELL_TOOLS,
  scaffoldProjectTool,
  projectStatusTool,
];

/**
 * The tools this session can actually run.
 *
 * Order matters only for the prompt: the model reads the definitions in this order, so the
 * reading/building tools come before the ones that publish.
 */
export function toolsFor(context: ToolContext): readonly AgentTool[] {
  const tools: AgentTool[] = [...CORE_TOOLS];
  if (context.build !== null) tools.push(...BUILD_TOOLS);
  if (context.netlify !== null) tools.push(...NETLIFY_TOOLS);
  if (context.preview !== null) tools.push(...PREVIEW_TOOLS);
  return tools;
}

/** Look a tool up by the name a model used. */
export function findTool(tools: readonly AgentTool[], name: string): AgentTool | undefined {
  return tools.find((tool) => tool.definition.name === name);
}
