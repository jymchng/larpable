/**
 * Reading a project for deployment: facts, not assumptions.
 *
 * The cases below are the PRD §8.3 table (Vite React/Vue/Svelte, Create React App, static
 * HTML, Astro) crossed with the package managers §8.2 names (Bun, npm, pnpm) and with the
 * SPA / non-SPA split §8.4 turns into a routing decision. Each case asserts the *reason*
 * as well as the value, because a fact without its evidence is the "hardcoded assumption"
 * §8.3 forbids — and because a wrong-but-plausible reason is the failure mode that would
 * survive every other test in this file.
 */

import { describe, expect, it } from "vitest";

import {
  deployScriptCommand,
  deriveFacts,
  inspectProjectFacts,
  readProjectSnapshot,
  type ProjectSnapshot,
} from "@/netlify/facts";
import { FakeEnvironment } from "@/env/fake-environment";

function snapshot(
  files: Record<string, string | null>,
  extra: { rootEntries?: string[]; publicEntries?: string[]; functionEntries?: string[] } = {},
): ProjectSnapshot {
  return {
    files,
    rootEntries:
      extra.rootEntries ??
      Object.keys(files).filter((path) => files[path] !== null && !path.includes("/")),
    publicEntries: extra.publicEntries ?? [],
    functionEntries: extra.functionEntries ?? [],
  };
}

function pkg(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "site",
    scripts: { build: "vite build" },
    dependencies: { react: "^18.3.1" },
    ...over,
  });
}

const VITE_CONFIG = "export default { plugins: [react()] };";

describe("deployScriptCommand", () => {
  it("follows PRD §8.2's spelling for each manager", () => {
    expect(deployScriptCommand("bun", "build")).toBe("bun run build");
    expect(deployScriptCommand("npm", "build")).toBe("npm run build");
    // §8.2 writes pnpm's as `pnpm build`, not `pnpm run build`.
    expect(deployScriptCommand("pnpm", "build")).toBe("pnpm build");
  });
});

describe("deriveFacts: the PRD §8.3 framework table", () => {
  it("Vite + React, with Bun's lockfile: dist, SPA fallback, `bun run build`", () => {
    const facts = deriveFacts(
      snapshot({ "package.json": pkg(), "vite.config.ts": VITE_CONFIG, "index.html": "<div id=app>", "bun.lock": "" }),
    );

    expect(facts.framework).toBe("vite-react");
    expect(facts.frameworkReason).toContain("vite.config.ts");
    expect(facts.packageManager).toBe("bun");
    expect(facts.packageManagerReason).toContain("bun.lock");
    expect(facts.buildCommand).toBe("bun run build");
    expect(facts.publishDir).toBe("dist");
    expect(facts.spa).toBe(true);
    expect(facts.spaReason).toContain("index.html");
    expect(facts.problems).toEqual([]);
  });

  it("Vite + Vue with npm: `npm run build`, dist, SPA fallback", () => {
    const facts = deriveFacts(
      snapshot({
        "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { vue: "^3.5.0" } }),
        "vite.config.js": "export default {}",
        "index.html": "<div id=app>",
        "package-lock.json": "{}",
      }),
    );

    expect(facts.framework).toBe("vite-vue");
    expect(facts.packageManager).toBe("npm");
    expect(facts.buildCommand).toBe("npm run build");
    expect(facts.publishDir).toBe("dist");
    expect(facts.spa).toBe(true);
  });

  it("Vite + Svelte with pnpm: `pnpm build`, dist", () => {
    const facts = deriveFacts(
      snapshot({
        "package.json": JSON.stringify({ scripts: { build: "vite build" }, devDependencies: { svelte: "^5.0.0" } }),
        "vite.config.ts": VITE_CONFIG,
        "index.html": "<div id=app>",
        "pnpm-lock.yaml": "lockfileVersion: 9",
      }),
    );

    expect(facts.framework).toBe("vite-svelte");
    expect(facts.packageManager).toBe("pnpm");
    expect(facts.buildCommand).toBe("pnpm build");
    expect(facts.publishDir).toBe("dist");
  });

  it("Create React App publishes build/, not dist/, and still needs the fallback", () => {
    const facts = deriveFacts(
      snapshot({
        "package.json": JSON.stringify({
          scripts: { build: "react-scripts build" },
          dependencies: { "react-scripts": "5.0.1", react: "^18.2.0" },
        }),
        "public/index.html": "<div id=root>",
        "package-lock.json": "{}",
      }),
    );

    expect(facts.framework).toBe("cra");
    expect(facts.publishDir).toBe("build");
    expect(facts.publishReason).toContain("react-scripts");
    expect(facts.spa).toBe(true);
    expect(facts.buildCommand).toBe("npm run build");
  });

  it("Astro publishes dist/ but gets no fallback: it writes one file per route", () => {
    const facts = deriveFacts(
      snapshot({
        "package.json": JSON.stringify({ scripts: { build: "astro build" }, dependencies: { astro: "^5.0.0" } }),
        "astro.config.mjs": "export default defineConfig({});",
        "bun.lock": "",
      }),
    );

    expect(facts.framework).toBe("astro");
    expect(facts.publishDir).toBe("dist");
    expect(facts.spa).toBe(false);
    expect(facts.spaReason).toContain("per route");
    expect(facts.buildCommand).toBe("bun run build");
  });

  it("Astro honours outDir from its own config", () => {
    const facts = deriveFacts(
      snapshot({
        "package.json": JSON.stringify({ scripts: { build: "astro build" }, dependencies: { astro: "^5.0.0" } }),
        "astro.config.mjs": "export default { outDir: './output/' };",
      }),
    );

    expect(facts.publishDir).toBe("output");
    expect(facts.publishReason).toContain("outDir");
  });

  it("a static site publishes `.` and needs no build command", () => {
    const facts = deriveFacts(
      snapshot({ "index.html": "<h1>hi</h1>", "about.html": "<h1>about</h1>", "style.css": "h1{}" }),
    );

    expect(facts.framework).toBe("static");
    expect(facts.publishDir).toBe(".");
    expect(facts.buildCommand).toBeNull();
    expect(facts.buildCommandReason).toContain("no build");
    expect(facts.spa).toBe(false);
    // No package.json is *not* a problem for a static site; it is an observation.
    expect(facts.problems).toEqual([]);
    expect(facts.notes.join(" ")).toContain("package.json was not found");
  });
});

describe("deriveFacts: SPA vs multi-page", () => {
  it("a Vite project with two HTML entry points is multi-page, so no fallback", () => {
    const facts = deriveFacts(
      snapshot({
        "package.json": pkg(),
        "vite.config.ts": VITE_CONFIG,
        "index.html": "<div id=app>",
        "admin.html": "<div id=admin>",
        "bun.lock": "",
      }),
    );

    expect(facts.spa).toBe(false);
    expect(facts.spaReason).toContain("multi-page");
  });

  it("names the client router when one is installed", () => {
    const facts = deriveFacts(
      snapshot({
        "package.json": pkg({ dependencies: { react: "^18.3.1", "react-router-dom": "^6.0.0" } }),
        "vite.config.ts": VITE_CONFIG,
        "index.html": "<div id=app>",
        "bun.lock": "",
      }),
    );

    expect(facts.spa).toBe(true);
    expect(facts.spaReason).toContain("react-router-dom");
  });
});

describe("deriveFacts: package managers and lockfiles", () => {
  it("prefers Bun's lockfile when both Bun and npm lockfiles exist", () => {
    const facts = deriveFacts(
      snapshot({ "package.json": pkg(), "vite.config.ts": VITE_CONFIG, "index.html": "", "bun.lock": "", "package-lock.json": "{}" }),
    );
    expect(facts.packageManager).toBe("bun");
    expect(facts.lockfile).toBe("bun.lock");
  });

  it("takes the manager the runtime detected when no lockfile exists, and says the build is not reproducible", () => {
    const facts = deriveFacts(
      snapshot({ "package.json": pkg(), "vite.config.ts": VITE_CONFIG, "index.html": "" }),
      { packageManager: "bun", packageManagerVersion: "1.4.5" },
    );

    expect(facts.packageManager).toBe("bun");
    expect(facts.lockfile).toBeNull();
    expect(facts.runtimeVersion).toBe("1.4.5");
    expect(facts.notes.join(" ")).toContain("No lockfile");
  });

  it("does not silently deploy with Yarn: it says the lockfile is not one it configures", () => {
    const facts = deriveFacts(
      snapshot({ "package.json": pkg(), "vite.config.ts": VITE_CONFIG, "index.html": "", "yarn.lock": "" }),
    );

    expect(facts.packageManager).toBe("npm");
    expect(facts.notes.join(" ")).toContain("yarn.lock");
  });
});

describe("deriveFacts: functions and unknowns", () => {
  it("configures a functions directory only when one holds files", () => {
    const withFunctions = deriveFacts(
      snapshot(
        { "package.json": pkg(), "vite.config.ts": VITE_CONFIG, "index.html": "", "bun.lock": "" },
        { functionEntries: ["hello.mts"] },
      ),
    );
    expect(withFunctions.functionsDir).toBe("netlify/functions");
    expect(withFunctions.functionsReason).toContain("1 file");

    const without = deriveFacts(snapshot({ "package.json": pkg(), "vite.config.ts": VITE_CONFIG, "index.html": "" }));
    expect(without.functionsDir).toBeNull();
  });

  it("refuses to invent a configuration for a project it cannot identify", () => {
    const facts = deriveFacts(snapshot({ "package.json": pkg({ dependencies: {} }) }));
    expect(facts.framework).toBe("unknown");
    expect(facts.problems.join(" ")).toContain("framework could not be identified");
  });

  it("uses the scaffold hint only when no configuration proves a framework", () => {
    const facts = deriveFacts(snapshot({ "package.json": pkg() }), { framework: "react-ts" });
    expect(facts.framework).toBe("vite-react");
    expect(facts.notes.join(" ")).toContain("react-ts template");
  });
});

describe("readProjectSnapshot / inspectProjectFacts", () => {
  it("reads the project out of the environment instead of assuming a default tree", async () => {
    const environment = new FakeEnvironment({
      tree: {
        "package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "^18" } }),
        "vite.config.ts": VITE_CONFIG,
        "index.html": "<div id=app>",
        "pnpm-lock.yaml": "lockfileVersion: 9",
        "netlify/functions/hello.mts": "export default () => new Response('ok');",
      },
    });
    await environment.initialize();

    const facts = await inspectProjectFacts(environment);

    expect(facts.framework).toBe("vite-react");
    expect(facts.packageManager).toBe("pnpm");
    expect(facts.functionsDir).toBe("netlify/functions");
    expect(facts.publishDir).toBe("dist");

    const snapshotRead = await readProjectSnapshot(environment);
    expect(snapshotRead.files["vite.config.ts"]).toContain("react");
    expect(snapshotRead.files["bun.lock"]).toBeNull();
    expect(snapshotRead.rootEntries).toContain("package.json");
    expect(snapshotRead.publicEntries).toEqual([]);
  });

  it("reads a project that is not the workspace root", async () => {
    const environment = new FakeEnvironment({
      tree: {
        "apps/site/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { vue: "^3" } }),
        "apps/site/vite.config.ts": VITE_CONFIG,
        "apps/site/index.html": "<div id=app>",
      },
      workspacePath: "/workspace",
    });
    await environment.initialize();

    const facts = await inspectProjectFacts(environment, { root: "/workspace/apps/site" });
    expect(facts.framework).toBe("vite-vue");
  });
});
