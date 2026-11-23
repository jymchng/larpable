/**
 * The install tool (PRD §7.2–7.3, §9.3 "Project").
 *
 * This is the one capability that came back after being removed, and the reason it came back
 * is the same reason it went: the agent's most common silent failure is believing a
 * dependency it never installed. Sending `npm install` through `execute_command` works, but
 * nothing checks the outcome — a model that forgets to read the log can go on to "fix" a
 * build that failed because `node_modules/` is empty.
 *
 * So this tool exists to make one claim checkable: **dependencies are installed, or here is
 * the guest's own error.**
 *
 * It installs with Bun, only. `src/build/manager.ts` decides the command (`bun install`, or
 * `bun install --frozen-lockfile` when `bun.lock`/`bun.lockb` exists) so the spelling lives in
 * one place, and the product prefers Bun because it is measured to work in the supported
 * guest (`docs/performance.md`: `bun install`, 67 packages, 41.9 s).
 *
 * Two rules make "Bun only" honest rather than decorative:
 *
 * - When the machine installs with npm — runtime detection fell back because `bun --version`
 *   did not answer on that image — the tool refuses *before* running anything and quotes the
 *   measured reason. It never executes `npm install` and calls it done: a model told "Bun"
 *   must not have to notice a contradiction in the log.
 * - When Bun is configured but the binary is absent, the failure is the guest's own words
 *   (`bun: not found`), because that is what a person would see in the terminal too.
 */

import { clampText, defineTool, failure, success, type AgentTool } from "./types";
import type { InstallResult } from "@/build/manager";

function noBuildManager(): ReturnType<typeof failure> {
  return failure(
    "This run has no build manager, so it cannot install dependencies. That happens in a test or a preview-only session; tell the user installation needs a booted guest instead of claiming it happened.",
  );
}

/** The command's output, or a sentence saying it printed nothing. */
function commandOutput(result: InstallResult): string {
  const combined = [result.log.stdout.trimEnd(), result.log.stderr.trimEnd()]
    .filter((part) => part.length > 0)
    .join("\n");
  return combined.length === 0 ? "(the command printed nothing)" : clampText(combined);
}

/** The measured reason the machine is not installing with Bun. */
function notBunSentence(packageManager: string, runtimeNote: string | null): string {
  const why =
    runtimeNote ??
    "runtime detection chose it for this machine, which means `bun --version` did not answer here.";
  return (
    `Dependencies were not installed: this guest installs with ${packageManager}, and ` +
    `\`install_dependencies\` runs Bun only — it will not substitute another package manager. ` +
    `${why} ` +
    `Report what the guest said rather than claiming the dependencies are installed.`
  );
}

export const installDependenciesTool: AgentTool = defineTool(
  {
    name: "install_dependencies",
    description:
      "Install the project's dependencies in the guest with Bun. Bun only: on a machine where " +
      "Bun cannot run, the tool reports the guest's own error instead of falling back to npm. " +
      "Run it before build_project, and again after changing package.json.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "install_dependencies arguments",
      properties: {},
      required: [],
    },
  },
  async (_args, context) => {
    if (context.build === null) return noBuildManager();
    if (context.signal?.aborted === true) return failure("The run was cancelled before installing.");

    const manager = context.build.packageManager;
    if (manager !== "bun") {
      return failure(notBunSentence(manager, context.build.runtimeNote), {
        packageManager: manager,
        ran: false,
        note: context.build.runtimeNote,
      });
    }

    let result: InstallResult;
    try {
      result = await context.build.install(
        context.signal === undefined
          ? { fallbackToNpm: false }
          : { signal: context.signal, fallbackToNpm: false },
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(`The install could not run: ${message}`, { packageManager: manager, ran: false });
    }

    const head = result.ok
      ? `\`${result.command}\` succeeded (${String(result.log.durationMs)} ms). ` +
        `${result.lockfile === null ? "No lockfile was found, so the install was not frozen." : `Installed reproducibly from ${result.lockfile}.`}`
      : `\`${result.command}\` failed (${String(result.log.durationMs)} ms, exit ${
          result.log.exitCode === null ? "unknown" : String(result.log.exitCode)
        }).`;

    const body = [
      head,
      `Package manager: ${result.packageManager}.`,
      commandOutput(result),
      result.failure === null
        ? ""
        : `What to do next: ${result.failure.hint}`,
      result.note === null ? "" : result.note,
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    const data = {
      ok: result.ok,
      command: result.command,
      packageManager: result.packageManager,
      lockfile: result.lockfile,
      exitCode: result.log.exitCode,
      durationMs: result.log.durationMs,
      ran: true,
    };

    if (result.ok) return success(body, data);

    const hint =
      result.failure === null
        ? ""
        : ` The guest's own message is above; fix the cause in the project and run this tool again.`;
    return failure(`${body}${hint}`, data);
  },
);

export const INSTALL_TOOLS: readonly AgentTool[] = [installDependenciesTool];
