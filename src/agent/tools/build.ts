/**
 * Build tools (PRD §9.3, "Project"; §7 for what they call).
 *
 * These are thin on purpose. `BuildManager` already decides the install command, the build
 * command, the output directory and whether the entry point exists; a tool that repeated
 * any of that logic would be a second source of truth about how the project is built, and
 * the agent would believe whichever one it read last.
 *
 * What the tools add is what a model needs and a manager does not: a short, honest
 * sentence, the failing lines, and a hint — and a `ok: false` when the build failed, so
 * the loop feeds the error back instead of the model announcing success.
 */

import { clampText, defineTool, failure, success, type AgentTool, type ToolContext } from "./types";
import type { BuildFailure } from "@/build/plan";
import type { BuildResult, InstallResult } from "@/build/manager";

function noBuildManager(what: string): ReturnType<typeof failure> {
  return failure(
    `This run has no build manager, so it cannot ${what}. That happens in a test or a preview-only session; ask the user to start a build instead of claiming one happened.`,
  );
}

function failureText(label: string, failure_: BuildFailure | null): string {
  if (failure_ === null) return "";
  return [
    `${label} failed: ${failure_.summary}`,
    failure_.detail.length > 0 ? `Details:\n${failure_.detail}` : "",
    `What to do next: ${failure_.hint}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n\n");
}

function commandOutput(stdout: string, stderr: string): string {
  const combined = [stdout.trimEnd(), stderr.trimEnd()].filter((part) => part.length > 0).join("\n");
  return combined.length === 0 ? "(the command printed nothing)" : clampText(combined);
}

export const installDependenciesTool: AgentTool = defineTool(
  {
    name: "install_dependencies",
    description:
      "Install the project's dependencies in the Linux guest. Use it after changing " +
      "package.json, before building. Returns the exit status and the end of the output.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "install_dependencies arguments",
      properties: {},
      required: [],
    },
  },
  async (_args, context) => {
    if (context.build === null) return noBuildManager("install dependencies");
    if (context.signal?.aborted === true) return failure("The run was cancelled before installing.");

    let result: InstallResult;
    try {
      result = await context.build.install(
        context.signal === undefined ? {} : { signal: context.signal },
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(`The install could not run: ${message}`);
    }

    const head = `\`${result.command}\` ${result.ok ? "succeeded" : "failed"} (${String(result.log.durationMs)} ms).`;
    const body = [
      head,
      result.lockfile === null ? "" : `Lockfile: ${result.lockfile}`,
      commandOutput(result.log.stdout, result.log.stderr),
      failureText("Install", result.failure),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const data = {
      ok: result.ok,
      exitCode: result.log.exitCode,
      packageManager: result.packageManager,
      lockfile: result.lockfile,
      durationMs: result.log.durationMs,
    };
    return result.ok ? success(body, data) : failure(body, data);
  },
);

export const buildProjectTool: AgentTool = defineTool(
  {
    name: "build_project",
    description:
      "Run the project's production build and report whether it produced a usable entry " +
      "point. A failure returns the compiler's own error lines. Never report a site as " +
      "built without this tool succeeding.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "build_project arguments",
      properties: {},
      required: [],
    },
  },
  async (_args, context) => {
    if (context.build === null) return noBuildManager("build the project");
    if (context.signal?.aborted === true) return failure("The run was cancelled before building.");

    let result: BuildResult;
    try {
      result = await context.build.build(
        context.signal === undefined ? {} : { signal: context.signal },
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(`The build could not run: ${message}`);
    }

    const head = result.ok
      ? `\`${result.command}\` succeeded (${String(result.durationMs)} ms). Output directory: ${result.outputDir}. Entry point: ${result.entryPoint ?? "(not verified)"}.`
      : `\`${result.command}\` failed (${String(result.durationMs)} ms).`;

    const body = [
      head,
      result.reason,
      result.log === null ? "" : commandOutput(result.log.stdout, result.log.stderr),
      failureText("Build", result.failure),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const data = {
      buildId: result.id,
      ok: result.ok,
      command: result.command,
      outputDir: result.outputDir,
      entryPoint: result.entryPoint,
      durationMs: result.durationMs,
    };
    return result.ok ? success(body, data) : failure(body, data);
  },
);

export const BUILD_TOOLS: readonly AgentTool[] = [installDependenciesTool, buildProjectTool];
