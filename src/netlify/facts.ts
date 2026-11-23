/**
 * What the project actually is, before a single deployment setting is written.
 *
 * PRD §8.3 is blunt about the risk: "These are defaults, not hardcoded assumptions. The
 * agent must inspect the actual project configuration before generating deployment
 * settings." So deployment configuration gets its own inspection pass here, reading the
 * files that actually decide the answer and recording *why* each fact was concluded.
 *
 * The module is split in two on purpose:
 *
 * - `readProjectSnapshot(environment)` does the I/O — the only part that needs a guest.
 * - `deriveFacts(snapshot, hints)` is pure, so the whole framework × package-manager ×
 *   routing matrix can be asserted in milliseconds without booting Linux.
 *
 * `ProjectFacts` never guesses silently: every field that matters carries the sentence
 * that justifies it, and anything unprovable lands in `notes` or `problems` rather than
 * being smoothed over.
 */

import { parsePackageJson, resolveOutputDir, type PackageJson } from "../build/plan";
import type { ExecutionEnvironment } from "../env/execution";
import { joinGuestPath } from "../env/paths";
import type { PackageManager } from "../runtime/detect";
import type { Framework as ScaffoldFramework } from "../runtime/scaffold";

/**
 * The project shapes Larpable generates deployment settings for.
 *
 * `vite-vanilla` is Vite without a UI framework (the scaffold's "vanilla" template):
 * it still has a build step and a `dist/`, which `static` does not.
 */
export type ProjectFramework =
  | "vite-react"
  | "vite-vue"
  | "vite-svelte"
  | "vite-vanilla"
  | "cra"
  | "astro"
  | "static"
  | "unknown";

/** npm, Bun and pnpm: the three Netlify's build image can run out of the box. */
export type DeployPackageManager = "npm" | "bun" | "pnpm";

export interface ProjectSnapshot {
  /** Workspace-relative file paths that were read; `null` means "not present". */
  files: Readonly<Record<string, string | null>>;
  /** Names in the project root. */
  rootEntries: readonly string[];
  /** Names inside `public/`, empty when there is no `public/`. */
  publicEntries: readonly string[];
  /** Names inside `netlify/functions`, empty when there is no such directory. */
  functionEntries: readonly string[];
}

export interface FactsHints {
  /** What the guest runtime manager detected, when it has already run. */
  packageManager?: PackageManager;
  /** The version that manager reported, e.g. `1.4.5`, for Netlify's `BUN_VERSION`. */
  packageManagerVersion?: string | null;
  /** The framework chosen at scaffold time, used only when no config proves one. */
  framework?: ScaffoldFramework;
}

export interface ProjectFacts {
  framework: ProjectFramework;
  /** One sentence: what in the project proved the framework. */
  frameworkReason: string;
  packageManager: DeployPackageManager;
  packageManagerReason: string;
  /** The project's own `scripts.build` text, or null. */
  buildScript: string | null;
  /** The command Netlify should run, or null when nothing needs building. */
  buildCommand: string | null;
  buildCommandReason: string;
  /** Publish directory, relative to the project root, no trailing slash. */
  publishDir: string;
  publishReason: string;
  /** True when the app needs the `/*` → `/index.html` fallback. */
  spa: boolean;
  spaReason: string;
  /** `netlify/functions` when the project has one, else null. */
  functionsDir: string | null;
  functionsReason: string | null;
  /** Version to pin for the runtime in Netlify's build image, when measured. */
  runtimeVersion: string | null;
  /** The lockfile that decided the package manager, when one did. */
  lockfile: string | null;
  /** Observations worth showing that do not block generation. */
  notes: readonly string[];
  /** Facts that make generation impossible. */
  problems: readonly string[];
}

/** The files worth reading. Reading *everything* would make inspection a directory walk. */
const CONFIG_FILES = [
  "package.json",
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.js",
  "index.html",
  "public/index.html",
  "netlify.toml",
] as const;

/** Lockfiles in precedence order: the first one present decides the manager. */
const LOCKFILE_MANAGERS: readonly { file: string; manager: DeployPackageManager }[] = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
];

/** Client-side routers, per framework. Their presence corroborates an SPA, nothing more. */
const ROUTER_PACKAGES: readonly string[] = [
  "react-router",
  "react-router-dom",
  "@tanstack/react-router",
  "wouter",
  "vue-router",
  "svelte-routing",
  "@reach/router",
];

const VITE_CONFIG_FILES = ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"];
const ASTRO_CONFIG_FILES = ["astro.config.mjs", "astro.config.ts", "astro.config.js"];

function readFileText(snapshot: ProjectSnapshot, path: string): string | null {
  return snapshot.files[path] ?? null;
}

function firstPresent(snapshot: ProjectSnapshot, paths: readonly string[]): string | null {
  for (const path of paths) {
    if (readFileText(snapshot, path) !== null) return path;
  }
  return null;
}

function hasDependency(dependencies: Record<string, string> | undefined, name: string): boolean {
  return dependencies !== undefined && Object.prototype.hasOwnProperty.call(dependencies, name);
}

function dependenciesOf(pkg: PackageJson | null): Record<string, string> {
  return { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
}

/**
 * The command Netlify runs for a script, per package manager.
 *
 * PRD §8.2 spells pnpm's out as `pnpm build`, not `pnpm run build`; npm and Bun get the
 * `run` form because that is what their own docs and the build manager use. Following
 * the PRD matters here: this string is compared against `package.json` by the validator,
 * so the two spellings must not drift apart.
 */
export function deployScriptCommand(manager: DeployPackageManager, script: string): string {
  return manager === "pnpm" ? `pnpm ${script}` : `${manager} run ${script}`;
}

/** The scaffold's template name, when a hint supplies one. */
function scaffoldFrameworkToProject(framework: ScaffoldFramework | undefined): ProjectFramework | null {
  switch (framework) {
    case "react-ts":
      return "vite-react";
    case "vue":
      return "vite-vue";
    case "svelte":
      return "vite-svelte";
    case "vanilla":
      return "vite-vanilla";
    default:
      return null;
  }
}

function detectFramework(snapshot: ProjectSnapshot, pkg: PackageJson | null): {
  framework: ProjectFramework;
  reason: string;
} {
  const deps = dependenciesOf(pkg);
  const scripts = Object.values(pkg?.scripts ?? {});

  const astroConfig = firstPresent(snapshot, ASTRO_CONFIG_FILES);
  if (astroConfig ?? hasDependency(deps, "astro")) {
    return {
      framework: "astro",
      reason: astroConfig
        ? `\`${astroConfig}\` is an Astro config file.`
        : "`package.json` depends on `astro`.",
    };
  }

  if (hasDependency(deps, "react-scripts") || scripts.some((script) => script.includes("react-scripts"))) {
    return {
      framework: "cra",
      reason: hasDependency(deps, "react-scripts")
        ? "`package.json` depends on `react-scripts` (Create React App)."
        : "a package.json script runs `react-scripts`.",
    };
  }

  const viteConfig = firstPresent(snapshot, VITE_CONFIG_FILES);
  if (viteConfig ?? hasDependency(deps, "vite")) {
    const because = viteConfig ? `\`${viteConfig}\`` : "`package.json` depends on `vite`";
    if (hasDependency(deps, "vue")) return { framework: "vite-vue", reason: `${because} and on \`vue\`.` };
    if (hasDependency(deps, "svelte")) {
      return { framework: "vite-svelte", reason: `${because} and on \`svelte\`.` };
    }
    if (hasDependency(deps, "react")) return { framework: "vite-react", reason: `${because} and on \`react\`.` };
    return { framework: "vite-vanilla", reason: `${because}, with no UI framework dependency.` };
  }

  // No bundler at all: a hand-written site that Netlify can publish as-is.
  if (readFileText(snapshot, "index.html") !== null || snapshot.rootEntries.some((name) => name.endsWith(".html"))) {
    return { framework: "static", reason: "There is no bundler; the HTML files are the site." };
  }

  return {
    framework: "unknown",
    reason: "No Astro, Vite, react-scripts or static HTML was found in the project root.",
  };
}

function detectPackageManager(
  snapshot: ProjectSnapshot,
  hints: FactsHints,
): { manager: DeployPackageManager; reason: string; lockfile: string | null; notes: string[] } {
  for (const entry of LOCKFILE_MANAGERS) {
    if (readFileText(snapshot, entry.file) !== null) {
      return {
        manager: entry.manager,
        reason: `\`${entry.file}\` is the project's lockfile.`,
        lockfile: entry.file,
        notes: [],
      };
    }
  }

  if (readFileText(snapshot, "yarn.lock") !== null) {
    return {
      manager: "npm",
      reason: "`yarn.lock` is present but Yarn is not a manager Larpable configures, so npm runs the build.",
      lockfile: "yarn.lock",
      notes: [
        "`yarn.lock` is present. Netlify would use Yarn, but Larpable generates npm/Bun/pnpm " +
          "commands; regenerate the lockfile with one of those, or set `build.command` by hand.",
      ],
    };
  }

  if (hints.packageManager === "bun") {
    return {
      manager: "bun",
      reason: "The guest runtime selected Bun and the project has no lockfile yet.",
      lockfile: null,
      notes: ["No lockfile: Netlify will install from `package.json`, which is not reproducible."],
    };
  }

  return {
    manager: "npm",
    reason: hints.packageManager
      ? `The guest runtime selected ${hints.packageManager}; npm is the manager that ships with every Netlify image.`
      : "No lockfile and no runtime hint; npm is the manager that ships with every Netlify image.",
    lockfile: null,
    notes: ["No lockfile: Netlify will install from `package.json`, which is not reproducible."],
  };
}

/**
 * Does this project need the `/*` → `/index.html` rewrite?
 *
 * PRD §8.4: generate it for client-side routing, and "do not automatically add this
 * redirect to applications that do not need SPA routing". The dividing line used here is
 * whether the build emits one HTML shell or one file per route:
 *
 * - Astro renders a real page per route, so a catch-all would shadow them.
 * - A static site is its own pages for the same reason.
 * - CRA always renders one `index.html`.
 * - Vite builds one `index.html` unless the config declares several inputs.
 *
 * Unknown projects get no rewrite: adding one would be the "hardcoded assumption" §8.3
 * forbids, and a missing rewrite is visible in validation while a wrong one is silent.
 */
function detectSpaRouting(options: {
  framework: ProjectFramework;
  snapshot: ProjectSnapshot;
  deps: Record<string, string>;
}): { spa: boolean; reason: string } {
  const { framework, snapshot, deps } = options;
  const htmlEntries = snapshot.rootEntries.filter((name) => name.endsWith(".html"));
  const hasRootIndex = readFileText(snapshot, "index.html") !== null;
  const routers = ROUTER_PACKAGES.filter((name) => hasDependency(deps, name));

  switch (framework) {
    case "astro":
      return {
        spa: false,
        reason: "Astro renders one HTML file per route; a catch-all would shadow them.",
      };
    case "static":
      return {
        spa: false,
        reason: `A static site publishes its own HTML pages (${htmlEntries.length || 1} found); no fallback is needed.`,
      };
    case "cra":
      return { spa: true, reason: "Create React App renders a single `index.html`." };
    case "vite-react":
    case "vite-vue":
    case "vite-svelte":
    case "vite-vanilla": {
      if (!hasRootIndex) {
        return {
          spa: false,
          reason: "There is no `index.html` at the project root, so there is nothing for a catch-all to serve.",
        };
      }
      if (htmlEntries.length > 1) {
        return {
          spa: false,
          reason: `The project root holds ${htmlEntries.length} HTML entry points, so it is multi-page rather than a single-page app.`,
        };
      }
      const routerNote = routers.length > 0 ? ` (client router: ${routers.join(", ")})` : "";
      return {
        spa: true,
        reason: `The build emits one \`index.html\` shell${routerNote}; deep links need the fallback.`,
      };
    }
    default:
      return {
        spa: false,
        reason: "The framework could not be identified, so no rewrite was invented for it.",
      };
  }
}

function detectPublishDir(options: {
  framework: ProjectFramework;
  snapshot: ProjectSnapshot;
  pkg: PackageJson | null;
}): { dir: string; reason: string } {
  const { framework, snapshot, pkg } = options;

  if (framework === "static") {
    return { dir: ".", reason: "A static site is published from the project root; there is no build output." };
  }

  if (framework === "astro") {
    const astroConfig = firstPresent(snapshot, ASTRO_CONFIG_FILES);
    const text = astroConfig ? readFileText(snapshot, astroConfig) : null;
    const outDir = text ? /outDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(text) : null;
    if (astroConfig && outDir?.[1]) {
      return { dir: normaliseDir(outDir[1]), reason: `\`${astroConfig}\` sets \`outDir\` to \`${outDir[1]}\`.` };
    }
    return { dir: "dist", reason: "Astro writes its build to `dist/` by default." };
  }

  const viteConfig = firstPresent(snapshot, VITE_CONFIG_FILES);
  const output = resolveOutputDir({
    viteConfig: viteConfig ? readFileText(snapshot, viteConfig) : null,
    // The existing netlify.toml is deliberately *not* consulted: it is the file being
    // validated or rewritten, and using it as its own evidence would make every publish
    // directory look correct.
    netlifyToml: null,
    packageJson: pkg,
  });
  return { dir: output.dir, reason: output.reason };
}

function normaliseDir(dir: string): string {
  return dir.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

/** Turn a snapshot into the facts deployment configuration is generated from. */
export function deriveFacts(snapshot: ProjectSnapshot, hints: FactsHints = {}): ProjectFacts {
  const notes: string[] = [];
  const problems: string[] = [];

  const packageText = readFileText(snapshot, "package.json");
  const parsed = packageText === null ? { json: null, problem: "package.json was not found in the project root." } : parsePackageJson(packageText);
  const pkg = parsed.json;

  const detected = detectFramework(snapshot, pkg);
  let framework = detected.framework;
  let frameworkReason = detected.reason;

  // A static site is complete without a package.json, so a missing one is an observation
  // there. Anywhere else it is the file the build command comes from, and a *broken* one
  // is a problem everywhere: a parse failure is not the same thing as an absence.
  if (parsed.problem) {
    if (packageText === null && framework === "static") notes.push(parsed.problem);
    else problems.push(parsed.problem);
  }

  if (framework === "unknown") {
    const hinted = scaffoldFrameworkToProject(hints.framework);
    if (hinted) {
      framework = hinted;
      frameworkReason = `No configuration proved a framework; using the ${hints.framework} template the project was scaffolded from.`;
      notes.push(frameworkReason);
    } else {
      problems.push(
        "The framework could not be identified from the project root, so no build command or " +
          "publish directory can be justified. Add the framework's config file or set the " +
          "deployment settings by hand.",
      );
    }
  }

  const manager = detectPackageManager(snapshot, hints);
  notes.push(...manager.notes);

  const deps = dependenciesOf(pkg);
  const buildScript = pkg?.scripts?.build?.trim() ?? null;
  let buildCommand: string | null = null;
  let buildCommandReason: string;
  if (buildScript && buildScript.length > 0) {
    buildCommand = deployScriptCommand(manager.manager, "build");
    buildCommandReason = `package.json defines \`build\`: \`${buildScript}\`, run with ${manager.manager}.`;
  } else if (framework === "static") {
    buildCommandReason = "The site needs no build, so Netlify gets no build command.";
  } else {
    problems.push(
      "package.json has no `build` script. Netlify would have nothing to run, so add the " +
        "script rather than having Larpable guess one.",
    );
    buildCommandReason = "No build script exists in package.json.";
  }

  const publish = detectPublishDir({ framework, snapshot, pkg });
  const spa = detectSpaRouting({ framework, snapshot, deps });

  const functionsDir = snapshot.functionEntries.length > 0 ? "netlify/functions" : null;
  const functionsReason = functionsDir
    ? `\`netlify/functions\` holds ${snapshot.functionEntries.length} file(s).`
    : null;

  if (framework === "unknown" && snapshot.rootEntries.length === 0) {
    notes.push("The project root is empty.");
  }
  // An SPA needs an entry document to fall back to. CRA keeps it in `public/index.html`
  // (Vite copies it from the project root), so both locations count; anywhere else the
  // fallback would point at a file that does not exist.
  const hasHtmlEntry =
    readFileText(snapshot, "index.html") !== null || readFileText(snapshot, "public/index.html") !== null;
  if (framework !== "static" && spa.spa && !hasHtmlEntry) {
    problems.push(
      "An SPA fallback was justified but neither `index.html` nor `public/index.html` exists, so it would point at nothing.",
    );
  }

  const runtimeVersion = hints.packageManagerVersion ?? null;
  if (manager.manager === "bun" && runtimeVersion === null) {
    notes.push("Bun was selected but its version was not measured, so it is not pinned in `netlify.toml`.");
  }

  return {
    framework,
    frameworkReason,
    packageManager: manager.manager,
    packageManagerReason: manager.reason,
    buildScript,
    buildCommand,
    buildCommandReason,
    publishDir: publish.dir,
    publishReason: publish.reason,
    spa: spa.spa,
    spaReason: spa.reason,
    functionsDir,
    functionsReason,
    runtimeVersion,
    lockfile: manager.lockfile,
    notes,
    problems,
  };
}

/**
 * Read the project out of the guest.
 *
 * A missing file is a fact, not an error: `readFile` rejects for "not found" and for real
 * failures alike, so the snapshot records `null` and the derived facts decide whether the
 * absence matters. Anything outside the project root would throw in `resolveWorkspacePath`
 * before it reached here.
 */
export async function readProjectSnapshot(
  environment: ExecutionEnvironment,
  options: { root?: string } = {},
): Promise<ProjectSnapshot> {
  const root = options.root ?? environment.workspacePath;
  const decoder = new TextDecoder();

  const read = async (relative: string): Promise<string | null> => {
    try {
      return decoder.decode(await environment.readFile(joinGuestPath(root, relative)));
    } catch {
      return null;
    }
  };

  const list = async (relative: string): Promise<string[]> => {
    try {
      const entries = await environment.listFiles(relative === "" ? root : joinGuestPath(root, relative));
      return entries.map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name)).sort();
    } catch {
      return [];
    }
  };

  const names: string[] = [...CONFIG_FILES, "yarn.lock", "npm-shrinkwrap.json"];
  for (const lockfile of LOCKFILE_MANAGERS) names.push(lockfile.file);

  const files: Record<string, string | null> = {};
  for (const name of names) files[name] = await read(name);

  return {
    files,
    rootEntries: await list(""),
    publicEntries: await list("public"),
    functionEntries: await list("netlify/functions"),
  };
}

/** Read the project and derive its facts in one call: what the agent flow uses. */
export async function inspectProjectFacts(
  environment: ExecutionEnvironment,
  options: { root?: string } & FactsHints = {},
): Promise<ProjectFacts> {
  const { root, ...hints } = options;
  const snapshot = await readProjectSnapshot(environment, root === undefined ? {} : { root });
  return deriveFacts(snapshot, hints);
}
