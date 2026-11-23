/**
 * Netlify configuration tool (PRD §9.3, "Project"; §8 for the substance).
 *
 * PRD §8 makes `netlify.toml` mandatory, and §18.3-18.5 make "the agent wrote one" part of
 * a successful create flow. So the tool does not write the file itself: it calls
 * `ensureNetlifyConfig`, which inspects the project, plans the file, syncs it and validates
 * what is now on disk. Failing validation is a tool *failure*, not a warning, because a
 * deployment with a wrong publish directory is a broken deployment that looks fine locally.
 */

import { clampText, defineTool, failure, success, type AgentTool } from "./types";

export const ensureNetlifyConfigTool: AgentTool = defineTool(
  {
    name: "ensure_netlify_config",
    description:
      "Create or update netlify.toml from what the project actually is, then validate it " +
      "against package.json and the real build output. Required before reporting a site as " +
      "ready to deploy.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "ensure_netlify_config arguments",
      properties: {},
      required: [],
    },
  },
  async (_args, context) => {
    if (context.netlify === null) {
      return failure(
        "This run has no Netlify configuration step, so netlify.toml was not created. Do not claim it exists.",
      );
    }
    if (context.signal?.aborted === true) return failure("The run was cancelled before writing netlify.toml.");

    let result;
    try {
      result = await context.netlify.ensure({ root: context.root });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(`netlify.toml could not be written: ${message}`);
    }

    const parts: string[] = [
      `${result.ok ? "netlify.toml is valid" : "netlify.toml needs attention"} at ${result.path}.`,
      result.sync.reason,
    ];
    if (result.decisions.length > 0) parts.push(`Settings chosen:\n${result.decisions.join("\n")}`);

    const problems = result.validation.issues.filter((issue) => issue.severity === "error");
    const warnings = result.validation.issues.filter((issue) => issue.severity === "warning");
    if (problems.length > 0) {
      parts.push(
        `Errors:\n${problems.map((issue) => `- ${issue.message} (${issue.hint})`).join("\n")}`,
      );
    }
    if (warnings.length > 0) {
      parts.push(`Warnings:\n${warnings.map((issue) => `- ${issue.message}`).join("\n")}`);
    }
    parts.push(result.validation.summary);

    const body = clampText(parts.filter((part) => part.length > 0).join("\n\n"));
    const data = {
      path: result.path,
      ok: result.ok,
      action: result.sync.action,
      issues: result.validation.issues.length,
    };
    return result.ok ? success(body, data) : failure(body, data);
  },
);

export const NETLIFY_TOOLS: readonly AgentTool[] = [ensureNetlifyConfigTool];
