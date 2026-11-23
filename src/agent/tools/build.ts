/**
 * The build tool (PRD §9.3, "Project"; §7 for what it calls).
 *
 * `build_project` is thin on purpose. `BuildManager` already decides the build command, the
 * output directory and whether the entry point exists; a tool that repeated any of that logic
 * would be a second source of truth about how the project is built, and the agent would
 * believe whichever one it read last.
 *
 * It adds what a model needs and a manager does not: a short, honest sentence, the failing
 * lines, and a hint — and an `ok: false` when the build failed, so the loop feeds the error
 * back instead of the model announcing success.
 *
 * `install_dependencies` sits beside it, and the history is worth stating because the tool was
 * once removed on purpose. Installing was left to `execute_command` so the model would learn
 * that installation is a command in the guest rather than a feature of this app — but a model
 * that sends `npm install` through a shell and never reads the log can go on to "fix" a build
 * that failed because `node_modules/` was empty, and nothing in the loop catches it. So the
 * tool is back for one reason: it makes a single claim checkable — *installed, or here is the
 * guest's own error*.
 *
 * It is **Bun only** (`install.ts`), and deliberately not the same object the pane uses:
 * `BuildManager` may re-run an install with npm when `bun` itself is missing, because the
 * pane's "Install & build" is a click that should still work on such an image; the tool passes
 * `fallbackToNpm: false` and refuses outright on a machine whose runtime detection chose npm,
 * so a model told "Bun" never reads a log that quietly says npm.
 */

import { clampText, defineTool, failure, success, type AgentTool, type ToolContext } from "./types";
import { installDependenciesTool } from "./install";
import type { BuildFailure } from "@/build/plan";
import type { BuildResult } from "@/build/manager";

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
