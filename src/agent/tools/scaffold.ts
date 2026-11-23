/**
 * The scaffold tool: the create procedure's step 3, as something the agent can call.
 *
 * PRD §10's create procedure says "Scaffold the project" and PRD §7.2 says how: from the
 * templates that ship with Larpable, not from `npm create vite`. The reasons are measured,
 * not stylistic — the guest's first `node` call is a download that cost 146.7 s in
 * `docs/feasibility-report.md`, and a generator is a package to fetch *before* the project
 * that needs it exists.
 *
 * Two behaviours worth knowing:
 *
 * - **It refuses to overwrite a project that is already there.** Re-scaffolding is the most
 *   destructive thing an agent can do to a user's site, and the guard is a cheap failure
 *   with a sentence telling the model to read the project first (PRD §10's modify rules).
 *   `overwrite: true` exists for the one legitimate case: the user asked for a fresh start.
 * - **It reports the paths it wrote.** The model needs to know `src/App.tsx` exists before
 *   it tries to edit it, and a test can assert the tree rather than trust a boolean.
 */

import { FRAMEWORKS, scaffoldProject, writeScaffold, type Framework } from "@/runtime/scaffold";
import { clampText, defineTool, failure, success, type AgentTool } from "./types";

function isFramework(value: unknown): value is Framework {
  return typeof value === "string" && (FRAMEWORKS as readonly string[]).includes(value);
}

export const scaffoldProjectTool: AgentTool = defineTool(
  {
    name: "scaffold_project",
    description:
      "Write a starter project into the workspace: React + TypeScript + Vite (the default), " +
      "Vue, Svelte, or plain HTML/CSS/JS. Use it as the first step of a new project instead " +
      "of running a generator. Refuses to overwrite a project that already exists unless " +
      "overwrite is true.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "scaffold_project arguments",
      properties: {
        framework: {
          type: "string",
          description:
            "Template to write. `react-ts` is the default and the only one with TypeScript " +
            "configured.",
          enum: [...FRAMEWORKS],
        },
        name: {
          type: "string",
          description: "Project name: package.json name and page title. Default `my-site`.",
          minLength: 1,
          maxLength: 64,
        },
        overwrite: {
          type: "boolean",
          description:
            "Replace an existing project's files. Only when the user asked for a fresh start.",
        },
      },
      required: [],
    },
  },
  async (args, context) => {
    const raw = args.framework;
    if (raw !== undefined && !isFramework(raw)) {
      return failure(
        `Unknown framework ${JSON.stringify(raw)}. Use one of: ${FRAMEWORKS.join(", ")}.`,
      );
    }
    const framework: Framework = isFramework(raw) ? raw : "react-ts";
    const name = typeof args.name === "string" && args.name.length > 0 ? args.name : undefined;

    // Checked before anything is written: an existing package.json means this is a project,
    // and a scaffold over it would destroy the user's work with no warning.
    if (args.overwrite !== true) {
      try {
        await context.environment.readFile(`${context.root}/package.json`);
        return failure(
          `${context.root}/package.json already exists, so this is an existing project. ` +
            "Read it (`read_file`, `list_files`) and modify it instead of scaffolding over it. " +
            "Pass overwrite=true only if the user asked to start again from a template.",
        );
      } catch {
        // No package.json: nothing to protect. The scaffold proceeds.
      }
    }

    const project = scaffoldProject({
      framework,
      ...(name === undefined ? {} : { name }),
    });

    try {
      const written = await writeScaffold(context.environment, project, { root: context.root });
      const files = written.map((path) =>
        path.startsWith(`${context.root}/`) ? path.slice(context.root.length + 1) : path,
      );
      const body = clampText(
        [
          `Wrote the ${project.framework} template (${String(files.length)} files) into ${context.root}.`,
          `Build command: \`${project.buildCommand}\`. Install: \`${project.installCommand}\`. Output: ${project.outputDir}/.`,
          `Files:\n${files.join("\n")}`,
        ].join("\n\n"),
      );
      return success(body, {
        framework: project.framework,
        name: project.name,
        files,
        buildCommand: project.buildCommand,
        installCommand: project.installCommand,
        outputDir: project.outputDir,
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return failure(`Could not scaffold the project: ${message}`);
    }
  },
);
