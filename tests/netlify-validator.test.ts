/**
 * Validating `netlify.toml` against the project it claims to deploy.
 *
 * PRD §18.5 forbids claiming a site is deployment-ready before this passes, so the tests
 * are written the way an adversarial reviewer would write them: every check gets a case
 * that *must* fail, and asserts the issue code and the sentence the agent would show. A
 * validator that returned `ok: true` for a file with the wrong publish directory would be
 * worse than none at all, because the agent would repeat it to the user as fact.
 */

import { describe, expect, it } from "vitest";

import { deriveFacts, type ProjectFacts, type ProjectSnapshot } from "@/netlify/facts";
import { planNetlifyConfig, renderNetlifyToml } from "@/netlify/generator";
import { validateNetlifyConfig, type NetlifyIssueCode } from "@/netlify/validator";

function snapshot(files: Record<string, string | null>, functionEntries: string[] = []): ProjectSnapshot {
  return {
    files,
    rootEntries: Object.keys(files).filter((path) => files[path] !== null && !path.includes("/")),
    publicEntries: [],
    functionEntries,
  };
}

const REACT_BUN = snapshot({
  "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "^18" } }),
  "vite.config.ts": "export default {};",
  "index.html": "<div id=app>",
  "bun.lock": "",
});

function factsOf(snap: ProjectSnapshot = REACT_BUN, hints = {}): ProjectFacts {
  return deriveFacts(snap, hints);
}

/** The generated file for these facts: the baseline a positive case validates. */
function generated(facts: ProjectFacts): string {
  return planNetlifyConfig(facts).toml;
}

function codes(issues: readonly { code: NetlifyIssueCode }[]): NetlifyIssueCode[] {
  return issues.map((issue) => issue.code);
}

describe("validateNetlifyConfig: the generated file passes its own validator", () => {
  it("accepts the file Larpable generates for Vite + React on Bun, build output included", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });

    const validation = validateNetlifyConfig({
      toml: generated(facts),
      path: "netlify.toml",
      facts,
      build: { dir: "dist", entryExists: true, entries: ["index.html", "assets/"] },
    });

    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
    expect(validation.summary).toContain("valid");
    expect(validation.summary).toContain("checked against the last build");
  });

  it.each([
    [
      "Vite + Vue on npm",
      snapshot({
        "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { vue: "^3" } }),
        "vite.config.ts": "export default {};",
        "index.html": "",
        "package-lock.json": "{}",
      }),
    ],
    [
      "Vite + Svelte on pnpm",
      snapshot({
        "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { svelte: "^5" } }),
        "vite.config.ts": "export default {};",
        "index.html": "",
        "pnpm-lock.yaml": "",
      }),
    ],
    [
      "Create React App on npm",
      snapshot({
        "package.json": JSON.stringify({
          scripts: { build: "react-scripts build" },
          dependencies: { "react-scripts": "5.0.1" },
        }),
        "public/index.html": "",
        "package-lock.json": "{}",
      }),
    ],
    [
      "Astro on Bun",
      snapshot({
        "package.json": JSON.stringify({ scripts: { build: "astro build" }, dependencies: { astro: "^5" } }),
        "astro.config.mjs": "export default {};",
        "bun.lock": "",
      }),
    ],
    ["static HTML", snapshot({ "index.html": "", "about.html": "" })],
  ])("accepts its own output for %s", (_name, snap) => {
    const facts = factsOf(snap, { packageManagerVersion: "1.4.5" });
    const validation = validateNetlifyConfig({ toml: generated(facts), path: "netlify.toml", facts });

    expect(facts.problems).toEqual([]);
    expect(codes(validation.issues)).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});

describe("validateNetlifyConfig: file-level failures", () => {
  it("reports a missing file instead of pretending a default would work", () => {
    const validation = validateNetlifyConfig({ toml: null, path: "netlify.toml", facts: factsOf() });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toEqual(["missing-file"]);
    expect(validation.summary).toContain("missing");
  });

  it("reports invalid TOML with the parser's own message", () => {
    const validation = validateNetlifyConfig({ toml: "[build\n", path: "netlify.toml", facts: factsOf() });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toEqual(["invalid-toml"]);
  });

  it("reports a configuration that is not at the project root", () => {
    const facts = factsOf();
    const validation = validateNetlifyConfig({
      toml: generated(facts),
      path: "apps/site/netlify.toml",
      facts,
    });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("not-at-root");
  });
});

describe("validateNetlifyConfig: the build command", () => {
  it("fails when the command does not match package.json and the detected manager", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace('command = "bun run build"', 'command = "npm run build"');

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    const issue = validation.issues.find((entry) => entry.code === "command-mismatch");
    expect(issue?.message).toContain("npm run build");
    expect(issue?.message).toContain("bun run build");
    expect(issue?.hint).toContain("package.json defines");
  });

  it("fails when there is no command at all for a project that builds", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = '[build]\n  publish = "dist"\n\n[[redirects]]\n  from = "/*"\n  to = "/index.html"\n  status = 200\n';

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("missing-command");
  });

  it("warns about a command on a project that has nothing to build", () => {
    const facts = factsOf(snapshot({ "index.html": "", "about.html": "" }));
    const toml = renderNetlifyToml({ build: { command: "npm run build", publish: "." }, redirects: [] });

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(true);
    expect(codes(validation.issues)).toEqual(["unnecessary-command"]);
    expect(validation.issues[0]?.severity).toBe("warning");
  });
});

describe("validateNetlifyConfig: the publish directory", () => {
  it("fails when there is no publish directory", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = '[build]\n  command = "bun run build"\n';

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("missing-publish");
  });

  it("fails when publish disagrees with the project's own configuration", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace('publish = "dist"', 'publish = "build"');

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("publish-mismatch");
  });

  it("fails when publish disagrees with what the build actually wrote", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });

    const validation = validateNetlifyConfig({
      toml: generated(facts),
      path: "netlify.toml",
      facts,
      build: { dir: "build", entryExists: true },
    });

    expect(validation.ok).toBe(false);
    const issue = validation.issues.find((entry) => entry.code === "publish-vs-build");
    expect(issue?.message).toContain("build");
    expect(issue?.hint).toContain("actually produced");
  });

  it("fails when the build left no readable index.html", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });

    const validation = validateNetlifyConfig({
      toml: generated(facts),
      path: "netlify.toml",
      facts,
      build: { dir: "dist", entryExists: false },
    });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("missing-entry");
  });

  it("fails when the publish directory is empty", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });

    const validation = validateNetlifyConfig({
      toml: generated(facts),
      path: "netlify.toml",
      facts,
      build: { dir: "dist", entryExists: true, entries: [] },
    });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("empty-publish");
  });
});

describe("validateNetlifyConfig: routing", () => {
  it("fails when a single-page app has no fallback", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = '[build]\n  command = "bun run build"\n  publish = "dist"\n';

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    const issue = validation.issues.find((entry) => entry.code === "missing-spa-redirect");
    expect(issue?.hint).toContain("/*");
    expect(issue?.hint).toContain("/index.html");
  });

  it("fails when the catch-all shadows a more specific rule", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = [
      "[build]",
      '  command = "bun run build"',
      '  publish = "dist"',
      "",
      "[[redirects]]",
      '  from = "/*"',
      '  to = "/index.html"',
      "  status = 200",
      "",
      "[[redirects]]",
      '  from = "/api/*"',
      '  to = "/.netlify/functions/:splat"',
      "  status = 200",
      "",
    ].join("\n");

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    const issue = validation.issues.find((entry) => entry.code === "shadowed-redirect");
    expect(issue?.message).toContain("/api/*");
    expect(issue?.hint).toContain("first match wins");
  });

  it("fails when there are two catch-alls", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const redirect = '\n[[redirects]]\n  from = "/*"\n  to = "/index.html"\n  status = 200\n';
    const toml = `[build]\n  command = "bun run build"\n  publish = "dist"\n${redirect}${redirect}`;

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("duplicate-spa-redirect");
  });

  it("fails on a status Netlify would reject", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace("status = 200", "status = 999");

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("invalid-redirect-status");
  });

  it("fails when the SPA fallback points somewhere other than /index.html", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace('to = "/index.html"', 'to = "/404.html"');

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("invalid-redirect-target");
  });

  it("warns about a catch-all on a project that is not a single-page app", () => {
    const facts = factsOf(snapshot({ "index.html": "", "about.html": "" }));
    const toml = renderNetlifyToml({
      build: { publish: "." },
      redirects: [{ from: "/*", to: "/index.html", status: 200 }],
    });

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(true);
    expect(codes(validation.issues)).toContain("unneeded-spa-redirect");
  });

  it("warns when the fallback is forced, because it would shadow assets", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace("  status = 200", "  status = 200\n  force = true");

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(true);
    expect(codes(validation.issues)).toContain("forced-catch-all");
    expect(validation.issues[0]?.severity).toBe("warning");
  });
});

describe("validateNetlifyConfig: functions and unnecessary settings", () => {
  it("warns about a functions directory the project does not have", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace(
      "[[redirects]]",
      '[functions]\n  directory = "netlify/functions"\n\n[[redirects]]',
    );

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(true);
    expect(codes(validation.issues)).toContain("unnecessary-functions");
  });

  it("fails when the configured functions directory is not where they are", () => {
    const facts = factsOf({ ...REACT_BUN, functionEntries: ["hello.mts"] }, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace(
      'directory = "netlify/functions"',
      'directory = "functions"',
    );

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(false);
    expect(codes(validation.issues)).toContain("missing-functions");
  });

  it("warns when Bun is not pinned, because Netlify's image default changes", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace(/\[build\.environment\]\n {2}BUN_VERSION = "1\.4\.5"\n\n/, "");

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(true);
    expect(codes(validation.issues)).toContain("bun-version-unpinned");
  });

  it("warns about a BUN_VERSION on a project that does not use Bun", () => {
    const facts = factsOf(
      snapshot({
        "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { vue: "^3" } }),
        "vite.config.ts": "export default {};",
        "index.html": "",
        "pnpm-lock.yaml": "",
      }),
    );
    const toml = renderNetlifyToml({
      build: { command: "pnpm build", publish: "dist", environment: { BUN_VERSION: "1.4.5" } },
      redirects: [{ from: "/*", to: "/index.html", status: 200 }],
    });

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(true);
    expect(codes(validation.issues)).toContain("unnecessary-bun-version");
  });

  it("warns about a base directory that is the repository root", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const toml = generated(facts).replace('  publish = "dist"', '  publish = "dist"\n  base = "."');

    const validation = validateNetlifyConfig({ toml, path: "netlify.toml", facts });

    expect(validation.ok).toBe(true);
    expect(codes(validation.issues)).toContain("unnecessary-base");
  });
});

describe("validateNetlifyConfig: the summary says what was checked", () => {
  it("names the command, the publish directory and the fallback", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const validation = validateNetlifyConfig({ toml: generated(facts), path: "netlify.toml", facts });

    expect(validation.summary).toContain("bun run build");
    expect(validation.summary).toContain("dist");
    expect(validation.summary).toContain("SPA fallback");
  });

  it("does not claim a build check that never ran", () => {
    const facts = factsOf(REACT_BUN, { packageManagerVersion: "1.4.5" });
    const validation = validateNetlifyConfig({ toml: generated(facts), path: "netlify.toml", facts });

    expect(validation.summary).not.toContain("checked against the last build");
  });
});
