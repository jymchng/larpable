/**
 * Generating `netlify.toml` from the project's own facts, and keeping it current.
 *
 * PRD §8 makes this mandatory: every project Larpable creates ships a valid
 * `netlify.toml` at its root, and the file has to follow the project when the framework,
 * build command, output directory or routing changes. Three rules shape this module:
 *
 * 1. **Nothing is written from a default.** Every setting comes from `ProjectFacts`,
 *    which recorded the file that justified it. A fact the inspector could not establish
 *    lands in `problems` and blocks generation instead of producing a plausible file.
 * 2. **The file is small on purpose.** PRD §8.6.6 asks to "verify no unnecessary
 *    deployment settings were introduced", so only `[build]`, an optional
 *    `[build.environment]` pin, an optional `[functions]`, and the SPA redirect appear.
 * 3. **A file with hand-written settings is not clobbered.** `syncNetlifyConfig` rewrites
 *    a file only when it contains settings Larpable itself manages; headers, contexts,
 *    plugins and custom redirects mean "preserved", with the reason spelled out.
 */

import type { ExecutionEnvironment } from "../env/execution";
import { joinGuestPath } from "../env/paths";
import type { DeployPackageManager, ProjectFacts } from "./facts";
import { parse as parseToml } from "smol-toml";

/** One `[[redirects]]` entry. `force` is Netlify's "shadow static files too". */
export interface NetlifyRedirect {
  from: string;
  to: string;
  /** 200 is a rewrite; 301/302/303/307/308 are HTTP redirects; 404/410/451 are answers. */
  status: number;
  force?: boolean;
}

/** A parsed or planned `[build]` table. Parsed files may omit anything; plans may not. */
export interface NetlifyBuildSettings {
  command?: string;
  publish?: string;
  base?: string;
  environment?: Record<string, string>;
}

export interface NetlifySettings {
  build?: NetlifyBuildSettings;
  functions?: { directory?: string };
  redirects?: NetlifyRedirect[];
}

/** What the generator produces: concrete settings, not a parsed file. */
export interface NetlifyConfigSettings {
  build: { command?: string; publish: string; environment?: Record<string, string> };
  functions?: { directory: string };
  redirects: NetlifyRedirect[];
}

export interface NetlifyConfigPlan {
  settings: NetlifyConfigSettings;
  /** The file's text, ready to write. */
  toml: string;
  /** One line per decision, for the agent's log: what was chosen and why. */
  decisions: readonly string[];
  /** Non-empty means the settings could not be justified; the file must not be written. */
  problems: readonly string[];
}

/** Netlify's accepted redirect statuses. Anything else is a typo Netlify would reject. */
const REDIRECT_STATUSES = new Set([200, 301, 302, 303, 307, 308, 404, 410, 451]);

export function isRedirectStatus(value: number): boolean {
  return REDIRECT_STATUSES.has(value);
}

/** A TOML basic string. Escaping is not optional: a Windows path would end the string. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The SPA rewrite the generator owns: `/*` → `/index.html`, status 200. */
export function spaRedirect(): NetlifyRedirect {
  return { from: "/*", to: "/index.html", status: 200 };
}

function sameRedirect(a: NetlifyRedirect, b: NetlifyRedirect): boolean {
  return a.from === b.from && a.to === b.to && a.status === b.status && (a.force ?? false) === (b.force ?? false);
}

/**
 * Decide the deployment settings for a project.
 *
 * The plan is deliberate, not diffed: given the same facts it produces the same file,
 * which is what makes "keep it updated when the project changes" testable.
 */
export function planNetlifyConfig(facts: ProjectFacts): NetlifyConfigPlan {
  const problems = [...facts.problems];
  const decisions: string[] = [];

  const build: NetlifyConfigSettings["build"] = { publish: facts.publishDir };
  if (facts.buildCommand !== null) {
    build.command = facts.buildCommand;
    decisions.push(`Build command \`${facts.buildCommand}\` — ${facts.buildCommandReason}`);
  } else {
    decisions.push(`No build command — ${facts.buildCommandReason}`);
  }
  decisions.push(`Publish directory \`${facts.publishDir}\` — ${facts.publishReason}`);

  // PRD §8.2: do not assume Bun is on the build image. Pin what the project was tested
  // against so a Netlify image update cannot silently change the toolchain under it.
  if (facts.packageManager === "bun" && facts.runtimeVersion !== null) {
    build.environment = { BUN_VERSION: facts.runtimeVersion };
    decisions.push(
      `Pin \`BUN_VERSION = ${tomlString(facts.runtimeVersion)}\` — the guest ran Bun ${facts.runtimeVersion}, and Netlify's image default is not this project's choice.`,
    );
  }

  const redirects: NetlifyRedirect[] = [];
  if (facts.spa) {
    redirects.push(spaRedirect());
    decisions.push(`SPA fallback \`/*\` → \`/index.html\` (200) — ${facts.spaReason}`);
  } else {
    decisions.push(`No SPA fallback — ${facts.spaReason}`);
  }

  const settings: NetlifyConfigSettings = { build, redirects };
  if (facts.functionsDir !== null) {
    settings.functions = { directory: facts.functionsDir };
    decisions.push(`Functions directory \`${facts.functionsDir}\` — ${facts.functionsReason ?? "the directory exists."}`);
  }

  if (facts.lockfile === null && facts.packageManager !== "bun") {
    decisions.push("No lockfile — Netlify will resolve dependencies from package.json, so the build is not reproducible.");
  }

  return {
    settings,
    toml: renderNetlifyToml(settings, facts),
    decisions,
    problems,
  };
}

/** Render settings as the file Netlify reads. Deterministic, so a diff means a change. */
export function renderNetlifyToml(settings: NetlifyConfigSettings, facts?: ProjectFacts): string {
  const lines: string[] = [];
  lines.push("# netlify.toml — generated by Larpable from this project's own configuration.");
  lines.push("#");
  if (facts) {
    lines.push(`# Framework: ${facts.framework} (${facts.frameworkReason})`);
    lines.push(`# Package manager: ${facts.packageManager} (${facts.packageManagerReason})`);
    lines.push("#");
  }
  lines.push("# Edit the project, not this file: regenerate it and validate it again, so the");
  lines.push("# configuration keeps matching what the project actually builds.");
  lines.push("");

  lines.push("[build]");
  if (settings.build.command !== undefined) {
    lines.push(`  command = ${tomlString(settings.build.command)}`);
  }
  lines.push(`  publish = ${tomlString(settings.build.publish)}`);
  lines.push("");

  if (settings.build.environment && Object.keys(settings.build.environment).length > 0) {
    lines.push("[build.environment]");
    for (const key of Object.keys(settings.build.environment).sort()) {
      lines.push(`  ${key} = ${tomlString(settings.build.environment[key] ?? "")}`);
    }
    lines.push("");
  }

  if (settings.functions) {
    lines.push("[functions]");
    lines.push(`  directory = ${tomlString(settings.functions.directory)}`);
    lines.push("");
  }

  for (const redirect of settings.redirects) {
    lines.push("[[redirects]]");
    lines.push(`  from = ${tomlString(redirect.from)}`);
    lines.push(`  to = ${tomlString(redirect.to)}`);
    lines.push(`  status = ${String(redirect.status)}`);
    if (redirect.force !== undefined) lines.push(`  force = ${String(redirect.force)}`);
    lines.push("");
  }

  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

// ---------------------------------------------------------------------------
// Reading a file back
// ---------------------------------------------------------------------------

export type ParsedNetlifyToml =
  | { ok: true; settings: NetlifySettings; raw: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Parse a `netlify.toml`.
 *
 * Parsing is delegated to a real TOML parser rather than a regex: "the file is valid
 * TOML" is one of PRD §8.6's checks, and a pattern match cannot honestly claim it. The
 * normalisation that follows keeps whatever shape the file had — including entries that
 * are invalid for Netlify — so the validator, not the parser, decides what is wrong.
 */
export function parseNetlifyToml(text: string): ParsedNetlifyToml {
  let raw: unknown;
  try {
    // Parsing is delegated to `smol-toml`: spec-compliant and dependency-free, where a
    // hand-written parser would only be valid for the subset this generator emits — and
    // validating a user's file is exactly the case where that is not good enough.
    raw = parseToml(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "the file is not a TOML table" };
  }

  const table = raw as Record<string, unknown>;
  const settings: NetlifySettings = {};

  const build = table.build;
  if (typeof build === "object" && build !== null && !Array.isArray(build)) {
    const source = build as Record<string, unknown>;
    settings.build = {};
    if (typeof source.command === "string") settings.build.command = source.command;
    if (typeof source.publish === "string") settings.build.publish = source.publish;
    if (typeof source.base === "string") settings.build.base = source.base;
    const environment = source.environment;
    if (typeof environment === "object" && environment !== null && !Array.isArray(environment)) {
      settings.build.environment = {};
      for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
        settings.build.environment[key] = String(value);
      }
    }
  }

  const functions = table.functions;
  if (typeof functions === "object" && functions !== null && !Array.isArray(functions)) {
    const directory = (functions as Record<string, unknown>).directory;
    settings.functions = typeof directory === "string" ? { directory } : {};
  }

  if (Array.isArray(table.redirects)) {
    settings.redirects = table.redirects.map((entry) => {
      const source = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      const redirect: NetlifyRedirect = {
        from: typeof source.from === "string" ? source.from : "",
        to: typeof source.to === "string" ? source.to : "",
        // NaN marks "not a number": the validator reports it instead of pretending 200.
        status: typeof source.status === "number" ? source.status : Number.NaN,
      };
      if (typeof source.force === "boolean") redirect.force = source.force;
      return redirect;
    });
  }

  return { ok: true, settings, raw: table };
}

// ---------------------------------------------------------------------------
// Writing, and keeping the file current
// ---------------------------------------------------------------------------

/** Compare two settings objects by meaning, so formatting alone is never a change. */
export function settingsEquivalent(
  parsed: NetlifySettings,
  planned: NetlifyConfigSettings,
): boolean {
  if ((parsed.build?.command ?? undefined) !== (planned.build.command ?? undefined)) return false;
  if (normalisePublish(parsed.build?.publish) !== normalisePublish(planned.build.publish)) return false;

  const parsedEnvironment = parsed.build?.environment ?? {};
  const plannedEnvironment = planned.build.environment ?? {};
  const parsedKeys = Object.keys(parsedEnvironment).sort();
  const plannedKeys = Object.keys(plannedEnvironment).sort();
  if (parsedKeys.length !== plannedKeys.length) return false;
  for (const [index, key] of parsedKeys.entries()) {
    if (key !== plannedKeys[index]) return false;
    if (parsedEnvironment[key] !== plannedEnvironment[key]) return false;
  }

  if ((parsed.functions?.directory ?? undefined) !== (planned.functions?.directory ?? undefined)) return false;

  const parsedRedirects = parsed.redirects ?? [];
  if (parsedRedirects.length !== planned.redirects.length) return false;
  for (const [index, redirect] of planned.redirects.entries()) {
    const other = parsedRedirects[index];
    if (!other || !sameRedirect(other, redirect)) return false;
  }

  return true;
}

function normalisePublish(publish: string | undefined): string | undefined {
  if (publish === undefined) return undefined;
  return publish.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

/**
 * Settings in an existing file that Larpable does not manage.
 *
 * The list is what stops a synchronisation from deleting work: `[[headers]]`, a
 * `[context.deploy-preview]` block, a plugin, or an application redirect all mean the file
 * belongs to the project as much as to Larpable, so the honest action is to leave it alone
 * and say why.
 */
export function unmanagedSettings(raw: Record<string, unknown>): string[] {
  const unmanaged: string[] = [];
  const known = new Set(["build", "redirects", "functions"]);

  for (const key of Object.keys(raw)) {
    if (!known.has(key)) unmanaged.push(`[${key}]`);
  }

  if (typeof raw.build === "object" && raw.build !== null) {
    for (const key of Object.keys(raw.build as Record<string, unknown>)) {
      if (!["command", "publish", "environment"].includes(key)) unmanaged.push(`[build].${key}`);
    }
    const environment = (raw.build as Record<string, unknown>).environment;
    if (typeof environment === "object" && environment !== null) {
      for (const key of Object.keys(environment as Record<string, unknown>)) {
        if (!["BUN_VERSION", "NODE_VERSION"].includes(key)) unmanaged.push(`[build.environment].${key}`);
      }
    }
  }

  if (typeof raw.functions === "object" && raw.functions !== null) {
    for (const key of Object.keys(raw.functions as Record<string, unknown>)) {
      if (key !== "directory") unmanaged.push(`[functions].${key}`);
    }
  }

  if (Array.isArray(raw.redirects)) {
    for (const entry of raw.redirects) {
      const source = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
      const keys = Object.keys(source).sort().join(",");
      const ours = source.from === "/*" && source.to === "/index.html" && source.status === 200 && keys === "from,status,to";
      if (!ours) unmanaged.push(`[[redirects]] ${String(source.from ?? "?")} → ${String(source.to ?? "?")}`);
    }
  }

  return unmanaged;
}

export const NETLIFY_CONFIG_FILE = "netlify.toml";

export interface WriteNetlifyConfigResult {
  /** Guest-absolute path of the file written. */
  path: string;
  /** Path relative to the project root, always `netlify.toml`. */
  relativePath: string;
  bytes: number;
}

/** Write a plan into the project root. The only place this module touches the guest. */
export async function writeNetlifyConfig(
  environment: ExecutionEnvironment,
  plan: NetlifyConfigPlan,
  options: { root?: string } = {},
): Promise<WriteNetlifyConfigResult> {
  if (plan.problems.length > 0) {
    throw new Error(`refusing to write netlify.toml: ${plan.problems.join(" ")}`);
  }
  const path = joinGuestPath(options.root ?? environment.workspacePath, NETLIFY_CONFIG_FILE);
  await environment.writeFile(path, plan.toml);
  return { path, relativePath: NETLIFY_CONFIG_FILE, bytes: new TextEncoder().encode(plan.toml).byteLength };
}

export type NetlifySyncAction = "written" | "unchanged" | "preserved" | "blocked";

export interface NetlifySyncOutcome {
  action: NetlifySyncAction;
  /** Guest-absolute path of `netlify.toml`. */
  path: string;
  plan: NetlifyConfigPlan;
  /** One sentence describing what happened to the file. */
  reason: string;
  /** The file's text before the sync, or null when there was none. */
  before: string | null;
}

/**
 * Bring `netlify.toml` in line with the project.
 *
 * Four outcomes, and each one is a fact the caller can show:
 *
 * - `written`   — no file, or a file with only managed settings, and the plan differs.
 * - `unchanged` — the settings already match, so the bytes are left alone (formatting,
 *                 comments and key order in a hand-edited file survive).
 * - `preserved` — the file holds settings Larpable does not own; nothing is written.
 * - `blocked`   — the project cannot justify a configuration; nothing is written.
 */
export async function syncNetlifyConfig(
  environment: ExecutionEnvironment,
  facts: ProjectFacts,
  options: { root?: string } = {},
): Promise<NetlifySyncOutcome> {
  const root = options.root ?? environment.workspacePath;
  const path = joinGuestPath(root, NETLIFY_CONFIG_FILE);
  const plan = planNetlifyConfig(facts);

  let before: string | null = null;
  try {
    before = new TextDecoder().decode(await environment.readFile(path));
  } catch {
    before = null;
  }

  if (plan.problems.length > 0) {
    return {
      action: "blocked",
      path,
      plan,
      reason: `Nothing was written: ${plan.problems.join(" ")}`,
      before,
    };
  }

  if (before !== null) {
    const parsed = parseNetlifyToml(before);
    if (!parsed.ok) {
      // A file that does not parse is regenerated: it cannot be preserved faithfully, and
      // leaving broken TOML in the project would fail the deploy at Netlify instead.
      await writeNetlifyConfig(environment, plan, { root });
      return {
        action: "written",
        path,
        plan,
        reason: `Rewrote netlify.toml because the existing file is not valid TOML (${parsed.error}).`,
        before,
      };
    }

    const unmanaged = unmanagedSettings(parsed.raw);
    if (unmanaged.length > 0) {
      return {
        action: "preserved",
        path,
        plan,
        reason: `Left the existing netlify.toml alone: it contains settings Larpable does not manage (${unmanaged.join(", ")}).`,
        before,
      };
    }

    if (settingsEquivalent(parsed.settings, plan.settings)) {
      return {
        action: "unchanged",
        path,
        plan,
        reason: "netlify.toml already matches the project; nothing was rewritten.",
        before,
      };
    }
  }

  await writeNetlifyConfig(environment, plan, { root });
  return {
    action: "written",
    path,
    plan,
    reason: before === null ? "Wrote netlify.toml; there was none." : "Updated netlify.toml to match the project.",
    before,
  };
}

/** The package manager a plan would tell Netlify to run, for logs and status lines. */
export function describeNetlifyPlan(plan: NetlifyConfigPlan, facts: ProjectFacts): string {
  return `Netlify: ${facts.framework} · ${packageManagerLabel(facts.packageManager)} · publish ${plan.settings.build.publish}${plan.settings.redirects.length > 0 ? " · SPA fallback" : ""}`;
}

function packageManagerLabel(manager: DeployPackageManager): string {
  return manager === "bun" ? "Bun" : manager === "pnpm" ? "pnpm" : "npm";
}
