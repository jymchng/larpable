/**
 * Checking a `netlify.toml` against the project it claims to deploy.
 *
 * PRD §8.6 lists the checks, and the reason the list exists is in §18.5: "Never claim that
 * the website is deployment-ready if its Netlify configuration has not been validated."
 * So this module answers with *issues*, each naming what is wrong and what to do about it,
 * rather than a boolean. A boolean would let the agent say "valid" and be believed.
 *
 * Two classes of finding:
 *
 * - `error` — Netlify would build or serve the wrong thing (no command, publish that is
 *   not the build output, an SPA fallback that is missing or that shadows a real rule).
 * - `warning` — deployable, but a setting is unnecessary or unpinned (a `BUN_VERSION` on
 *   an npm project, no `BUN_VERSION` on a Bun one, a `base = "."`).
 *
 * Warnings do not fail validation: they are what §8.6.6 ("no unnecessary deployment
 * settings") turns into a specific, fixable sentence rather than a shrug.
 */

import type { ProjectFacts } from "./facts";
import {
  isRedirectStatus,
  parseNetlifyToml,
  type NetlifyRedirect,
  type NetlifySettings,
} from "./generator";

export type NetlifyIssueCode =
  | "missing-file"
  | "not-at-root"
  | "invalid-toml"
  | "missing-command"
  | "command-mismatch"
  | "unnecessary-command"
  | "missing-publish"
  | "publish-mismatch"
  | "publish-vs-build"
  | "missing-entry"
  | "empty-publish"
  | "invalid-redirect-status"
  | "invalid-redirect-target"
  | "missing-spa-redirect"
  | "unneeded-spa-redirect"
  | "shadowed-redirect"
  | "duplicate-spa-redirect"
  | "forced-catch-all"
  | "missing-functions"
  | "unnecessary-functions"
  | "bun-version-unpinned"
  | "unnecessary-bun-version"
  | "unnecessary-base";

export interface NetlifyIssue {
  code: NetlifyIssueCode;
  severity: "error" | "warning";
  /** What is wrong, in the product's voice. */
  message: string;
  /** What to change. */
  hint: string;
}

/** The real build output, when a build has already run. */
export interface NetlifyBuildOutput {
  /** Relative directory the build actually wrote, from `BuildResult.outputDir`. */
  dir: string;
  /** Whether that directory's `index.html` was read back and looked like HTML. */
  entryExists: boolean;
  /** Names in the publish directory, when the caller listed them. */
  entries?: readonly string[];
}

export interface NetlifyValidationInput {
  /** The file's text, or null when there is no `netlify.toml`. */
  toml: string | null;
  /** Workspace-relative path it was read from; `netlify.toml` means the project root. */
  path: string;
  facts: ProjectFacts;
  /** Omitted when no build has run yet: the publish check then says it was skipped. */
  build?: NetlifyBuildOutput | null;
}

export interface NetlifyValidation {
  /** True when nothing is an `error`; warnings are allowed and still reported. */
  ok: boolean;
  issues: NetlifyIssue[];
  settings: NetlifySettings | null;
  /** One sentence: what was verified, or the first thing that failed. */
  summary: string;
}

function issue(code: NetlifyIssueCode, severity: "error" | "warning", message: string, hint: string): NetlifyIssue {
  return { code, severity, message, hint };
}

function normaliseDir(dir: string): string {
  return dir.replace(/^\.\//, "").replace(/\/+$/, "") || ".";
}

function isCatchAll(redirect: NetlifyRedirect): boolean {
  return redirect.from === "/*";
}

/** Validate one `netlify.toml` against the facts and, when available, the build output. */
export function validateNetlifyConfig(input: NetlifyValidationInput): NetlifyValidation {
  const { facts } = input;

  if (input.toml === null) {
    const found = issue(
      "missing-file",
      "error",
      "The project has no `netlify.toml`, so Netlify would fall back to guessed settings.",
      "Generate it from the project's own facts and write it at the project root.",
    );
    return { ok: false, issues: [found], settings: null, summary: "netlify.toml is missing." };
  }

  const parsed = parseNetlifyToml(input.toml);
  if (!parsed.ok) {
    const found = issue(
      "invalid-toml",
      "error",
      `netlify.toml is not valid TOML: ${parsed.error}`,
      "Fix the syntax (the parser names the line); Netlify would reject this file too.",
    );
    return { ok: false, issues: [found], settings: null, summary: `netlify.toml does not parse: ${parsed.error}` };
  }

  const settings = parsed.settings;
  const issues: NetlifyIssue[] = [];

  if (input.path !== "netlify.toml") {
    issues.push(
      issue(
        "not-at-root",
        "error",
        `The configuration is at \`${input.path}\`, not at the project root.`,
        "Netlify only reads `netlify.toml` from the root of the repository it builds.",
      ),
    );
  }

  // --- The build command, against package.json ---------------------------------
  const declared = settings.build?.command?.trim() ?? null;
  if (facts.buildCommand !== null) {
    if (declared === null) {
      issues.push(
        issue(
          "missing-command",
          "error",
          `netlify.toml has no \`build.command\`, but the project builds with \`${facts.buildCommand}\`.`,
          `Add \`command = "${facts.buildCommand}"\` so Netlify runs the same build Larpable verified.`,
        ),
      );
    } else if (declared !== facts.buildCommand) {
      issues.push(
        issue(
          "command-mismatch",
          "error",
          `netlify.toml builds with \`${declared}\`, but package.json and the detected manager need \`${facts.buildCommand}\`.`,
          `Set \`command = "${facts.buildCommand}"\`: ${facts.buildCommandReason}`,
        ),
      );
    }
  } else if (declared !== null) {
    issues.push(
      issue(
        "unnecessary-command",
        "warning",
        `netlify.toml sets \`build.command = "${declared}"\`, but the project has no build script.`,
        "Remove the command; a static site needs nothing built before publishing.",
      ),
    );
  }

  // --- The publish directory, against the project and the real output ----------
  const publish = settings.build?.publish?.trim() ?? null;
  if (publish === null) {
    issues.push(
      issue(
        "missing-publish",
        "error",
        "netlify.toml has no `build.publish`, so Netlify would publish the repository root.",
        `Set \`publish = "${facts.publishDir}"\`: ${facts.publishReason}`,
      ),
    );
  } else {
    if (normaliseDir(publish) !== normaliseDir(facts.publishDir)) {
      issues.push(
        issue(
          "publish-mismatch",
          "error",
          `netlify.toml publishes \`${publish}\`, but the project's own configuration writes \`${facts.publishDir}\`.`,
          `Set \`publish = "${facts.publishDir}"\`: ${facts.publishReason}`,
        ),
      );
    }

    if (input.build) {
      const buildDir = normaliseDir(input.build.dir);
      if (normaliseDir(publish) !== buildDir) {
        issues.push(
          issue(
            "publish-vs-build",
            "error",
            `netlify.toml publishes \`${publish}\`, but the last build wrote \`${buildDir}\`.`,
            "Publish the directory the build actually produced, not the one the framework usually produces.",
          ),
        );
      }
      if (!input.build.entryExists) {
        issues.push(
          issue(
            "missing-entry",
            "error",
            `The build output has no readable \`index.html\` under \`${buildDir}\`.`,
            "Netlify would serve a 404 for `/`; fix the build before deploying.",
          ),
        );
      }
      if (input.build.entries && input.build.entries.length === 0) {
        issues.push(
          issue(
            "empty-publish",
            "error",
            `The publish directory \`${publish}\` is empty.`,
            "Run the build again, or point `publish` at the directory it writes.",
          ),
        );
      }
    }
  }

  // --- Routing -----------------------------------------------------------------
  const redirects = settings.redirects ?? [];
  redirects.forEach((redirect, index) => {
    if (Number.isNaN(redirect.status) || !isRedirectStatus(redirect.status)) {
      issues.push(
        issue(
          "invalid-redirect-status",
          "error",
          `Redirect ${String(index + 1)} (\`${redirect.from}\`) has status ${Number.isNaN(redirect.status) ? "that is not a number" : String(redirect.status)}.`,
          "Use 200 for a rewrite, 301/302/303/307/308 for a redirect, or 404/410/451 for a status page.",
        ),
      );
    }
    if (redirect.from.trim() === "" || redirect.to.trim() === "") {
      issues.push(
        issue(
          "invalid-redirect-target",
          "error",
          `Redirect ${String(index + 1)} has an empty \`from\` or \`to\`.`,
          "Both fields are required and must start with `/`.",
        ),
      );
    }
  });

  const catchAlls = redirects.map((redirect, index) => ({ redirect, index })).filter((entry) => isCatchAll(entry.redirect));
  if (catchAlls.length > 1) {
    issues.push(
      issue(
        "duplicate-spa-redirect",
        "error",
        `There are ${String(catchAlls.length)} \`/*\` redirects; only the first can ever match.`,
        "Keep one SPA fallback and delete the rest.",
      ),
    );
  }

  const catchAll = catchAlls[0];
  if (facts.spa) {
    if (!catchAll) {
      issues.push(
        issue(
          "missing-spa-redirect",
          "error",
          "The app renders a single `index.html`, but netlify.toml has no fallback, so deep links would 404.",
          `Add \`[[redirects]]\` with \`from = "/*"\`, \`to = "/index.html"\`, \`status = 200\`: ${facts.spaReason}`,
        ),
      );
    }
  } else if (catchAll) {
    issues.push(
      issue(
        "unneeded-spa-redirect",
        "warning",
        "netlify.toml sends every unknown path to `/index.html`, but this project is not a single-page app.",
        `Remove the catch-all unless the site really routes on the client: ${facts.spaReason}`,
      ),
    );
  }

  if (catchAll) {
    const { redirect, index } = catchAll;
    if (facts.spa && redirect.to !== "/index.html") {
      issues.push(
        issue(
          "invalid-redirect-target",
          "error",
          `The SPA fallback sends \`/*\` to \`${redirect.to}\`, not to \`/index.html\`.`,
          "Client-side routes are all served by `/index.html`; any other target breaks them.",
        ),
      );
    }
    if (facts.spa && redirect.status !== 200) {
      issues.push(
        issue(
          "invalid-redirect-status",
          "error",
          `The SPA fallback answers with status ${String(redirect.status)}; a browser would be redirected instead of served.`,
          "Use `status = 200` for a rewrite. A 301/302 on `/*` loops.",
        ),
      );
    }
    if (index < redirects.length - 1) {
      const dead = redirects.slice(index + 1).map((entry) => `\`${entry.from}\``);
      issues.push(
        issue(
          "shadowed-redirect",
          "error",
          `The \`/*\` catch-all comes before ${dead.join(", ")}, so those rules can never match.`,
          "Move the catch-all last: Netlify applies redirects in file order, first match wins.",
        ),
      );
    }
    if (redirect.force === true) {
      issues.push(
        issue(
          "forced-catch-all",
          "warning",
          "The SPA fallback has `force = true`, so it shadows real files and assets too.",
          "Leave `force` unset: without it Netlify serves an existing file first.",
        ),
      );
    }
  }

  // --- Functions ---------------------------------------------------------------
  const functionsDirectory = settings.functions?.directory ?? null;
  if (functionsDirectory !== null) {
    if (facts.functionsDir === null) {
      issues.push(
        issue(
          "unnecessary-functions",
          "warning",
          `netlify.toml names a functions directory (\`${functionsDirectory}\`), but the project has none.`,
          "Remove `[functions]`: an empty directory is not a function, and PRD §8.5 says not to generate unnecessary ones.",
        ),
      );
    } else if (normaliseDir(functionsDirectory) !== normaliseDir(facts.functionsDir)) {
      issues.push(
        issue(
          "missing-functions",
          "error",
          `netlify.toml looks for functions in \`${functionsDirectory}\`, but the project's are in \`${facts.functionsDir}\`.`,
          `Set \`directory = "${facts.functionsDir}"\`, or move the handlers.`,
        ),
      );
    }
  }

  // --- Unnecessary settings -----------------------------------------------------
  const bunVersion = settings.build?.environment?.BUN_VERSION ?? null;
  if (facts.packageManager === "bun" && bunVersion === null) {
    issues.push(
      issue(
        "bun-version-unpinned",
        "warning",
        "The project builds with Bun, but netlify.toml does not pin `BUN_VERSION`.",
        "Pin the version the project was tested with; Netlify's image default changes over time (PRD §8.2).",
      ),
    );
  }
  if (facts.packageManager !== "bun" && bunVersion !== null) {
    issues.push(
      issue(
        "unnecessary-bun-version",
        "warning",
        `netlify.toml pins \`BUN_VERSION = "${bunVersion}"\`, but the project builds with ${facts.packageManager}.`,
        "Remove it: the setting has no effect and misleads whoever reads the file next.",
      ),
    );
  }
  const base = settings.build?.base;
  if (base !== undefined && (base.trim() === "." || base.trim() === "")) {
    issues.push(
      issue(
        "unnecessary-base",
        "warning",
        `netlify.toml sets \`build.base = "${base}"\`, which is the default base.`,
        "Remove it; a base directory should only appear when the site is not at the repository root.",
      ),
    );
  }

  const errors = issues.filter((entry) => entry.severity === "error");
  return {
    ok: errors.length === 0,
    issues,
    settings,
    summary: summarise({ facts, settings, issues, errors, checkedBuild: input.build != null }),
  };
}

function summarise(options: {
  facts: ProjectFacts;
  settings: NetlifySettings;
  issues: NetlifyIssue[];
  errors: NetlifyIssue[];
  checkedBuild: boolean;
}): string {
  const { facts, settings, issues, errors, checkedBuild } = options;
  if (errors.length > 0) {
    const first = errors[0];
    const more = errors.length > 1 ? ` (+${String(errors.length - 1)} more)` : "";
    return `netlify.toml is not valid: ${first?.message ?? "unknown error"}${more}`;
  }

  const command = settings.build?.command?.trim();
  const publish = settings.build?.publish?.trim();
  const parts = [`command ${command === undefined ? "(none)" : `\`${command}\``}`, `publish \`${publish ?? "?"}\``];
  if ((settings.redirects ?? []).some(isCatchAll)) parts.push("SPA fallback");
  if (settings.functions?.directory) parts.push(`functions \`${settings.functions.directory}\``);

  const warning = issues.length > 0 ? ` ${String(issues.length)} warning${issues.length === 1 ? "" : "s"} noted.` : "";
  const build = checkedBuild ? " The publish directory was checked against the last build." : "";
  return `netlify.toml is valid for ${facts.framework}: ${parts.join(", ")}.${warning}${build}`;
}
