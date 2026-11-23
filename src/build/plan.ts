/**
 * The decisions a build makes *before* and *after* running anything, kept pure.
 *
 * A build manager that mixes "which command should run" with "run the command" is hard
 * to test and easy to lie in: a test that only asserts exit 0 says nothing about
 * whether the right command ran, and a failure message invented by the manager is not
 * evidence. So the three judgements live here as functions over text that the manager
 * reads from the guest:
 *
 * - `detectBuildCommand` — the command to run, from `package.json` `scripts.build` or a
 *   documented framework default, and *which* of the two it came from.
 * - `resolveOutputDir` — where the build actually writes, from the project's own config
 *   (Vite `build.outDir`, then Netlify `publish`), never assumed.
 * - `classifyFailure` — what a non-zero exit means, quoting the guest's output.
 *
 * PRD §7.4 says "do not assume every framework uses the same build configuration"; the
 * precedence order here is the implementation of that sentence.
 */

import type { PackageManager } from "../runtime/detect";
import type { Framework } from "../runtime/scaffold";

export interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface ParsedPackageJson {
  json: PackageJson | null;
  /** Why it could not be parsed, or null. */
  problem: string | null;
}

/** Parse `package.json` without throwing: a broken file is a build failure to report. */
export function parsePackageJson(text: string): ParsedPackageJson {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { json: null, problem: "package.json is not a JSON object" };
    }
    return { json: parsed as PackageJson, problem: null };
  } catch (error) {
    return {
      json: null,
      problem: `package.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type BuildCommandSource = "scripts.build" | "framework-default" | "framework-typecheck";

export interface BuildCommandPlan {
  command: string;
  source: BuildCommandSource;
  /** One sentence for the log: why this command and not another. */
  reason: string;
}

/** `npm run build`, or `bun run build`, according to the detected package manager. */
export function runScriptCommand(packageManager: PackageManager, script: string): string {
  return `${packageManager} run ${script}`;
}

/** Default build command per framework, used only when `scripts.build` is absent. */
const FRAMEWORK_BUILD: Partial<Record<Framework, { script: string; source: BuildCommandSource }>> = {
  // Every template this app scaffolds ships `build: vite build`, so hitting a default
  // means the project was hand-edited; the reason says which assumption was used.
  "react-ts": { script: "vite build", source: "framework-default" },
  vue: { script: "vite build", source: "framework-default" },
  svelte: { script: "vite build", source: "framework-default" },
  vanilla: { script: "vite build", source: "framework-default" },
};

/**
 * The build command, and where it came from.
 *
 * `scripts.build` always wins: it is the project's own statement of intent, and PRD §8
 * requires the generated `netlify.toml` to agree with it. A framework default is a
 * documented fallback, not a guess — and when neither exists the answer is `null` with
 * a problem, because inventing `vite build` for a project without Vite is a false pass.
 */
export function detectBuildCommand(options: {
  packageJson: ParsedPackageJson;
  packageManager: PackageManager;
  framework?: Framework;
}): { plan: BuildCommandPlan | null; problem: string | null } {
  const { packageJson, packageManager, framework } = options;
  if (packageJson.json === null) {
    return { plan: null, problem: packageJson.problem ?? "package.json could not be read" };
  }

  const script = packageJson.json.scripts?.build?.trim();
  if (script && script.length > 0) {
    return {
      plan: {
        command: runScriptCommand(packageManager, "build"),
        source: "scripts.build",
        reason: `package.json defines \`build\`: \`${script}\`.`,
      },
      problem: null,
    };
  }

  const fallback = framework ? FRAMEWORK_BUILD[framework] : undefined;
  if (!fallback) {
    return {
      plan: null,
      problem:
        "package.json has no `build` script and no framework default applies, so there is " +
        "no build to run. Add a `build` script rather than guessing one.",
    };
  }

  return {
    plan: {
      command: fallback.script,
      source: fallback.source,
      reason: `package.json has no \`build\` script; using the ${framework} default \`${fallback.script}\`.`,
    },
    problem: null,
  };
}

export type OutputDirSource = "vite-config" | "netlify-toml" | "react-scripts" | "framework-default";

export interface OutputDirPlan {
  /** Relative to the project root, no trailing slash. */
  dir: string;
  source: OutputDirSource;
  reason: string;
}

/** Strip comments well enough to read a config value, not to be a TOML/JS parser. */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Resolve the directory a build writes to.
 *
 * Precedence, and why:
 *
 * 1. Vite's `build.outDir` in `vite.config.*` — the project explicitly said so.
 * 2. `publish` in `netlify.toml` — the deploy configuration already names the directory
 *    that must contain `index.html`.
 * 3. `react-scripts` — CRA's fixed `build/`.
 * 4. The framework default (`dist`), which is also the PRD's default.
 *
 * The returned `source` is part of the result because "we looked" and "we assumed" must
 * not read the same in a build log or in `netlify.toml` validation later.
 */
export function resolveOutputDir(options: {
  framework?: Framework;
  viteConfig?: string | null;
  netlifyToml?: string | null;
  packageJson?: PackageJson | null;
}): OutputDirPlan {
  const vite = options.viteConfig ? /outDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(stripJsComments(options.viteConfig)) : null;
  if (vite?.[1]) {
    return {
      dir: normaliseDir(vite[1]),
      source: "vite-config",
      reason: `vite.config sets build.outDir to \`${vite[1]}\`.`,
    };
  }

  const publish = options.netlifyToml ? /^\s*publish\s*=\s*["']([^"']+)["']/m.exec(options.netlifyToml) : null;
  if (publish?.[1]) {
    return {
      dir: normaliseDir(publish[1]),
      source: "netlify-toml",
      reason: `netlify.toml publishes \`${publish[1]}\`.`,
    };
  }

  const scripts = options.packageJson?.scripts ?? {};
  const cra = Object.values(scripts).some((script) => script.includes("react-scripts"));
  if (cra) {
    return {
      dir: "build",
      source: "react-scripts",
      reason: "The project builds with react-scripts, which writes to `build/`.",
    };
  }

  return {
    dir: "dist",
    source: "framework-default",
    reason: `No output directory is configured; using the default \`dist/\`.`,
  };
}

function normaliseDir(dir: string): string {
  return dir.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

export type BuildFailureKind =
  | "missing-script"
  | "missing-dependency"
  | "compile"
  | "network"
  | "permission"
  | "out-of-memory"
  | "missing-entry"
  | "timeout"
  | "unknown";

export interface BuildFailure {
  kind: BuildFailureKind;
  /** One sentence, in the product's voice, naming what happened. */
  summary: string;
  /** The guest's own error lines, cleaned of ANSI codes. */
  detail: string;
  /** What a person (or the agent) can do next. */
  hint: string;
}

const ANSI = /\u001b\[[0-9;]*m/g;

/** The lines that look like errors, in order, without duplicates. */
export function errorLines(output: string, limit = 6): string[] {
  const lines = output
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) =>
      /error|ERR!|failed|cannot|can't|unexpected|not found|ENOENT|EACCES|EAI_AGAIN|ENOTFOUND|exited|Rollup|SyntaxError|TS\d{4}|out of memory|ENOMEM|OOMKilled|bad_alloc/i.test(
        line,
      ),
    );
  return [...new Set(lines)].slice(-limit);
}

/**
 * Classify a non-zero build/install exit.
 *
 * The patterns are ordered by specificity: a missing module is not a network problem
 * even though both mention a registry, and a TypeScript error is never "unknown" — the
 * agent needs the difference to fix the right thing.
 */
export function classifyFailure(options: {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}): BuildFailure {
  const output = `${options.stderr}\n${options.stdout}`.replace(ANSI, "");
  const detail = errorLines(output).join("\n");
  const status = options.exitCode === null ? "was killed by a signal" : `exited ${String(options.exitCode)}`;

  if (/Missing script:/i.test(output)) {
    return {
      kind: "missing-script",
      summary: `\`${options.command}\` ${status}: the script it names does not exist in package.json.`,
      detail,
      hint: "Add the script to package.json (a `build` script is required) or run the command the project actually defines.",
    };
  }

  if (/out of memory|OOMKilled|ENOMEM|cannot allocate memory|memory exhausted|heap out of memory|bad_alloc/i.test(output)) {
    return {
      kind: "out-of-memory",
      summary: `\`${options.command}\` ${status}: the guest ran out of memory.`,
      detail,
      hint:
        "The guest's memory is fixed when it boots: `VITE_LINUX_MEMORY_MIB` (1024 MiB by default, at most 4096). " +
        "Raise it and rebuild, or make the step hold less in memory at once.",
    };
  }

  if (/EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|registry\.npmjs\.org\/.*(?:403|404)|network/i.test(output)) {
    return {
      kind: "network",
      summary: `\`${options.command}\` ${status}: the guest could not reach the package registry.`,
      detail,
      hint: "The guest's network is a Wisp proxy that accepts only known origins; point it at your own with VITE_WISP_SERVERS or ?wisp=.",
    };
  }

  if (/EACCES|EPERM|Read-only file system|permission denied/i.test(output)) {
    return {
      kind: "permission",
      summary: `\`${options.command}\` ${status}: the guest refused a write.`,
      detail,
      hint: "Check that the data disk is attached and has free space; a read-only root means the overlay never mounted.",
    };
  }

  if (/Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|command not found|: not found/i.test(output)) {
    return {
      kind: "missing-dependency",
      summary: `\`${options.command}\` ${status}: a program or module it needs is not installed.`,
      detail,
      hint: "Run the install step first (`npm install`), and check the dependency is listed in package.json.",
    };
  }

  if (/error TS\d+|Rollup failed|Transform failed|SyntaxError|Unexpected token|Could not resolve|\[vite\]|Build failed/i.test(output)) {
    return {
      kind: "compile",
      summary: `\`${options.command}\` ${status}: the source did not compile.`,
      detail,
      hint: "Fix the reported file and line, then build again; the preview is not updated by a failed build.",
    };
  }

  return {
    kind: "unknown",
    summary: `\`${options.command}\` ${status} and printed no recognised error.`,
    detail: detail || output.trim().split("\n").slice(-4).join("\n"),
    hint: "Read the captured output above; nothing here was invented to fill the gap.",
  };
}
