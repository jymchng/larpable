/**
 * The framework × package-manager cross product, enumerated rather than sampled.
 *
 * Goal #9's acceptance said "templates across bun/npm/pnpm", and the earlier tests
 * satisfied that by exercising each *axis* — every framework, and every manager — without
 * ever crossing them. That leaves the pair where the two decisions interact untested, and
 * that pair is where the bugs live: the build command's spelling depends on the manager
 * (`bun run build` / `npm run build` / `pnpm build`, PRD §8.2), the publish directory
 * depends on the framework (`dist` / `build` / `.`), and only a few combinations need the
 * SPA fallback. A test that picks one framework per manager cannot see a spelling that is
 * wrong for exactly one pairing.
 *
 * So this file writes out all 21 pairs explicitly (the six templates named in the goal
 * plus Vite vanilla, which the facts module also knows) and asserts, per pair: the derived
 * facts, the exact command string, the publish directory, the SPA decision, the rendered
 * TOML, and that `validateNetlifyConfig` accepts the generated file with no issues at all
 * — not merely no errors, because a warning is still a setting Larpable should not have
 * written.
 */

import { describe, expect, it } from "vitest";

import { deriveFacts, deployScriptCommand, type DeployPackageManager, type ProjectSnapshot } from "@/netlify/facts";
import { parseNetlifyToml, planNetlifyConfig } from "@/netlify/generator";
import { validateNetlifyConfig } from "@/netlify/validator";

type Template = "vite-react" | "vite-vue" | "vite-svelte" | "vite-vanilla" | "cra" | "astro" | "static";

/** The lockfile that decides each manager. The facts module reads these, not the hint. */
const LOCKFILES: Record<DeployPackageManager, string> = {
  npm: "package-lock.json",
  bun: "bun.lock",
  pnpm: "pnpm-lock.yaml",
};

function packageJson(scripts: Record<string, string>, dependencies: Record<string, string>): string {
  return JSON.stringify({ name: "matrix", scripts, dependencies });
}

/**
 * A minimal but *recognisable* project per template: the files that decide the facts and
 * nothing else. Each one has to be enough for `detectFramework` to reach its conclusion
 * from the project's own configuration, never from a hint.
 */
const TEMPLATE_FILES: Record<Template, Record<string, string | null>> = {
  "vite-react": {
    "package.json": packageJson({ build: "vite build" }, { react: "^18", vite: "^5" }),
    "vite.config.ts": "export default {};",
    "index.html": '<div id="root"></div>',
  },
  "vite-vue": {
    "package.json": packageJson({ build: "vite build" }, { vue: "^3", vite: "^5" }),
    "vite.config.ts": "export default {};",
    "index.html": '<div id="app"></div>',
  },
  "vite-svelte": {
    "package.json": packageJson({ build: "vite build" }, { svelte: "^5", vite: "^5" }),
    "vite.config.ts": "export default {};",
    "index.html": '<div id="app"></div>',
  },
  "vite-vanilla": {
    "package.json": packageJson({ build: "vite build" }, { vite: "^5" }),
    "vite.config.ts": "export default {};",
    "index.html": "<h1>hello</h1>",
  },
  cra: {
    "package.json": packageJson({ build: "react-scripts build" }, { react: "^18", "react-scripts": "^5" }),
    "public/index.html": '<div id="root"></div>',
  },
  astro: {
    "package.json": packageJson({ build: "astro build" }, { astro: "^4" }),
    "astro.config.mjs": "export default {};",
  },
  static: {
    "index.html": "<h1>just html</h1>",
  },
};

function snapshotOf(template: Template, manager: DeployPackageManager): ProjectSnapshot {
  const files: Record<string, string | null> = { ...TEMPLATE_FILES[template], [LOCKFILES[manager]]: "" };
  return {
    files,
    rootEntries: Object.keys(files).filter((path) => files[path] !== null && !path.includes("/")),
    publicEntries: [],
    functionEntries: [],
  };
}

/** Every pair, written out. A missing or duplicated pair fails the coverage test below. */
const CASES: readonly {
  template: Template;
  manager: DeployPackageManager;
  command: string | null;
  publish: string;
  spa: boolean;
}[] = [
  // Vite + React: one HTML shell, publishes dist/, fallback needed.
  { template: "vite-react", manager: "npm", command: "npm run build", publish: "dist", spa: true },
  { template: "vite-react", manager: "bun", command: "bun run build", publish: "dist", spa: true },
  { template: "vite-react", manager: "pnpm", command: "pnpm build", publish: "dist", spa: true },
  // Vite + Vue: same shape.
  { template: "vite-vue", manager: "npm", command: "npm run build", publish: "dist", spa: true },
  { template: "vite-vue", manager: "bun", command: "bun run build", publish: "dist", spa: true },
  { template: "vite-vue", manager: "pnpm", command: "pnpm build", publish: "dist", spa: true },
  // Vite + Svelte: same shape.
  { template: "vite-svelte", manager: "npm", command: "npm run build", publish: "dist", spa: true },
  { template: "vite-svelte", manager: "bun", command: "bun run build", publish: "dist", spa: true },
  { template: "vite-svelte", manager: "pnpm", command: "pnpm build", publish: "dist", spa: true },
  // Vite without a UI framework: still a single index.html in dist/.
  { template: "vite-vanilla", manager: "npm", command: "npm run build", publish: "dist", spa: true },
  { template: "vite-vanilla", manager: "bun", command: "bun run build", publish: "dist", spa: true },
  { template: "vite-vanilla", manager: "pnpm", command: "pnpm build", publish: "dist", spa: true },
  // Create React App: writes build/, and always one shell.
  { template: "cra", manager: "npm", command: "npm run build", publish: "build", spa: true },
  { template: "cra", manager: "bun", command: "bun run build", publish: "build", spa: true },
  { template: "cra", manager: "pnpm", command: "pnpm build", publish: "build", spa: true },
  // Astro: one HTML file per route, so a catch-all would shadow them.
  { template: "astro", manager: "npm", command: "npm run build", publish: "dist", spa: false },
  { template: "astro", manager: "bun", command: "bun run build", publish: "dist", spa: false },
  { template: "astro", manager: "pnpm", command: "pnpm build", publish: "dist", spa: false },
  // A hand-written static site: nothing to build, published from the root.
  { template: "static", manager: "npm", command: null, publish: ".", spa: false },
  { template: "static", manager: "bun", command: null, publish: ".", spa: false },
  { template: "static", manager: "pnpm", command: null, publish: ".", spa: false },
];

const ALL_TEMPLATES: readonly Template[] = [
  "vite-react",
  "vite-vue",
  "vite-svelte",
  "vite-vanilla",
  "cra",
  "astro",
  "static",
];
const ALL_MANAGERS: readonly DeployPackageManager[] = ["npm", "bun", "pnpm"];

describe("framework × package-manager matrix: the pairs are enumerated, not sampled", () => {
  it("covers every template with every manager, once each", () => {
    expect(CASES).toHaveLength(ALL_TEMPLATES.length * ALL_MANAGERS.length);
    const seen = new Set(CASES.map((entry) => `${entry.template}/${entry.manager}`));
    expect(seen.size).toBe(CASES.length);
    for (const template of ALL_TEMPLATES) {
      for (const manager of ALL_MANAGERS) {
        expect(seen.has(`${template}/${manager}`), `${template}/${manager} is missing`).toBe(true);
      }
    }
  });

  it("spells the command the way the PRD does: bun/npm take `run`, pnpm does not", () => {
    expect(deployScriptCommand("bun", "build")).toBe("bun run build");
    expect(deployScriptCommand("npm", "build")).toBe("npm run build");
    expect(deployScriptCommand("pnpm", "build")).toBe("pnpm build");
    // A drift catch: the pnpm form must not silently become `pnpm run build`.
    expect(deployScriptCommand("pnpm", "build")).not.toContain("run");
  });
});

describe.each(CASES)("$template on $manager", ({ template, manager, command, publish, spa }) => {
  const hints = manager === "bun" ? { packageManagerVersion: "1.4.5" } : {};
  const facts = deriveFacts(snapshotOf(template, manager), hints);
  const plan = planNetlifyConfig(facts);

  it("derives framework, manager, publish directory and routing from the project", () => {
    expect(facts.problems).toEqual([]);
    expect(facts.framework).toBe(template);
    expect(facts.packageManager).toBe(manager);
    expect(facts.lockfile).toBe(LOCKFILES[manager]);
    expect(facts.publishDir).toBe(publish);
    expect(facts.spa).toBe(spa);
  });

  it("plans exactly this command spelling", () => {
    expect(facts.buildCommand).toBe(command);
    expect(plan.problems).toEqual([]);
    expect(plan.settings.build.command ?? null).toBe(command);
    if (command !== null) {
      expect(plan.toml).toContain(`  command = "${command}"`);
    } else {
      // A static site gets no `command` key at all, rather than an empty one.
      expect(plan.toml).not.toContain("command =");
    }
  });

  it("writes the publish directory and only the fallback the project needs", () => {
    expect(plan.settings.build.publish).toBe(publish);
    expect(plan.toml).toContain(`  publish = "${publish}"`);
    expect(plan.settings.redirects).toHaveLength(spa ? 1 : 0);
    if (spa) expect(plan.settings.redirects[0]).toMatchObject({ from: "/*", to: "/index.html", status: 200 });
  });

  it("pins BUN_VERSION for Bun and for nobody else", () => {
    const pinned = plan.settings.build.environment?.BUN_VERSION;
    if (manager === "bun") expect(pinned).toBe("1.4.5");
    else expect(pinned).toBeUndefined();
  });

  it("round-trips through the TOML parser with the same settings", () => {
    const parsed = parseNetlifyToml(plan.toml);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.settings.build?.command).toBe(command ?? undefined);
    expect(parsed.settings.build?.publish).toBe(publish);
    expect(parsed.settings.redirects?.length ?? 0).toBe(spa ? 1 : 0);
  });

  it("passes its own validator with no issues at all, build output included", () => {
    const validation = validateNetlifyConfig({
      toml: plan.toml,
      path: "netlify.toml",
      facts,
      build: { dir: publish, entryExists: true, entries: ["index.html"] },
    });
    expect(validation.issues).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});

describe("the matrix is what catches a drift", () => {
  it("rejects the pnpm command written in the npm spelling", () => {
    const facts = deriveFacts(snapshotOf("vite-react", "pnpm"));
    const plan = planNetlifyConfig(facts);
    const wrong = plan.toml.replace('command = "pnpm build"', 'command = "pnpm run build"');

    const validation = validateNetlifyConfig({ toml: wrong, path: "netlify.toml", facts });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((entry) => entry.code)).toContain("command-mismatch");
  });

  it("rejects CRA's `build/` publish pointed at `dist/`", () => {
    const facts = deriveFacts(snapshotOf("cra", "npm"));
    const plan = planNetlifyConfig(facts);
    const wrong = plan.toml.replace('publish = "build"', 'publish = "dist"');

    const validation = validateNetlifyConfig({ toml: wrong, path: "netlify.toml", facts });
    expect(validation.ok).toBe(false);
    expect(validation.issues.map((entry) => entry.code)).toContain("publish-mismatch");
  });

  it("flags a catch-all added to Astro, which renders a page per route", () => {
    const facts = deriveFacts(snapshotOf("astro", "bun"), { packageManagerVersion: "1.4.5" });
    const plan = planNetlifyConfig(facts);
    expect(plan.settings.redirects).toEqual([]);

    const withFallback = `${plan.toml}\n[[redirects]]\n  from = "/*"\n  to = "/index.html"\n  status = 200\n`;
    const validation = validateNetlifyConfig({ toml: withFallback, path: "netlify.toml", facts });
    expect(validation.issues.map((entry) => entry.code)).toContain("unneeded-spa-redirect");
  });
});
