/**
 * Scaffolding is a pure function over strings, and a separate observable write step.
 *
 * The templates are the first thing a user ever sees, and the first thing every later
 * stage trusts: the build command, the output directory and the `netlify.toml` are all
 * derived from what `scaffoldProject()` produced. So these tests assert the facts the
 * rest of the system reads — a `build` script that exists, an entry HTML that points at
 * a file that was actually written, a lockfile-free `npm install` — rather than
 * snapshotting the templates, which would make improving them a chore.
 */

import { describe, expect, it } from "vitest";

import { FakeEnvironment } from "@/env/fake-environment";
import { parsePackageJson, detectBuildCommand, resolveOutputDir } from "@/build/plan";
import {
  FRAMEWORKS,
  scaffoldProject,
  writeScaffold,
  type Framework,
} from "@/runtime/scaffold";

/** Every file the entry HTML names must be one of the files the scaffold writes. */
function entryPointsAtRealFile(files: Readonly<Record<string, string>>): boolean {
  const html = files["index.html"] as string;
  const src = /<script[^>]+src="([^"]+)"/.exec(html)?.[1];
  if (!src) return false;
  const relative = src.replace(/^\//, "");
  return Object.hasOwn(files, relative);
}

describe("the default template (React + TypeScript + Vite)", () => {
  it("is what an agent gets when it names no framework", () => {
    expect(scaffoldProject().framework).toBe("react-ts");
    expect(scaffoldProject().name).toBe("my-site");
  });

  it("ships a package.json the build manager can act on", () => {
    const project = scaffoldProject({ name: "landing" });
    const parsed = parsePackageJson(project.packageJson);

    expect(parsed.problem).toBeNull();
    expect(parsed.json?.scripts?.build).toBe("vite build");
    expect(parsed.json?.devDependencies).toHaveProperty("vite");
    expect(parsed.json?.dependencies).toHaveProperty("react");

    const command = detectBuildCommand({
      packageJson: parsed,
      packageManager: "npm",
      framework: project.framework,
    });
    expect(command.problem).toBeNull();
    expect(command.plan?.command).toBe("npm run build");
  });

  it("writes TypeScript with strict mode on, so a type error is a build error", () => {
    const tsconfig = JSON.parse(scaffoldProject().files["tsconfig.json"] as string) as {
      compilerOptions: { strict: boolean; jsx: string };
    };

    expect(tsconfig.compilerOptions.strict).toBe(true);
    expect(tsconfig.compilerOptions.jsx).toBe("react-jsx");
  });

  it("points index.html at a file it also writes", () => {
    expect(entryPointsAtRealFile(scaffoldProject().files)).toBe(true);
  });

  it("declares the output directory the build manager will look in", () => {
    const project = scaffoldProject();

    expect(project.outputDir).toBe("dist");
    expect(
      resolveOutputDir({
        framework: project.framework,
        packageJson: parsePackageJson(project.packageJson).json,
      }).dir,
    ).toBe(project.outputDir);
  });

  it("installs and builds with the commands the runtime chose", () => {
    expect(scaffoldProject().buildCommand).toBe("npm run build");
    expect(scaffoldProject().installCommand).toBe("npm install --no-audit --no-fund");
    expect(scaffoldProject({ packageManager: "bun" }).buildCommand).toBe("bun run build");
    expect(scaffoldProject({ packageManager: "bun" }).installCommand).toBe("bun install");
  });
});

describe("every template", () => {
  const filesByFramework = FRAMEWORKS.map((framework) => ({
    framework,
    files: scaffoldProject({ framework }).files,
  }));

  for (const { framework, files } of filesByFramework) {
    it(`${framework}: writes an entry HTML, a package.json with a build script, and an asset it references`, () => {
      const parsed = parsePackageJson(files["package.json"] as string);

      expect(Object.keys(files)).toContain("index.html");
      expect(parsed.problem).toBeNull();
      expect(parsed.json?.scripts?.build).toBe("vite build");
      expect(entryPointsAtRealFile(files)).toBe(true);
    });

    it(`${framework}: builds into dist with vite`, () => {
      const project = scaffoldProject({ framework });

      expect(project.outputDir).toBe("dist");
      expect(project.files["README.md"]).toContain("npm run build");
    });
  }

  it("names the framework whose toolchain a file implies", () => {
    const suspects: Record<Exclude<Framework, "vanilla">, string> = {
      "react-ts": "@vitejs/plugin-react",
      vue: "@vitejs/plugin-vue",
      svelte: "@sveltejs/vite-plugin-svelte",
    };

    for (const [framework, plugin] of Object.entries(suspects)) {
      expect(scaffoldProject({ framework: framework as Framework }).packageJson).toContain(plugin);
    }
    // Vanilla has no framework dependency at all — asserting that keeps a copy-paste
    // from quietly turning the smallest template into a React app.
    const vanilla = parsePackageJson(scaffoldProject({ framework: "vanilla" }).packageJson);
    expect(vanilla.json?.dependencies).toBeUndefined();
    expect(vanilla.json?.devDependencies).toEqual({ vite: expect.any(String) });
  });
});

describe("names", () => {
  it("makes a name safe for package.json and for a directory", () => {
    expect(scaffoldProject({ name: "My Cool Site!" }).name).toBe("my-cool-site");
    expect(scaffoldProject({ name: "  ../etc/passwd  " }).name).toBe("etc-passwd");
    expect(scaffoldProject({ name: "!!!" }).name).toBe("my-site");
  });

  it("never produces a name that is a path rather than a name", () => {
    // `.` and `..` are the two strings that would make a project directory point
    // somewhere other than itself, so neither may survive sanitisation.
    expect(scaffoldProject({ name: ".." }).name).toBe("my-site");
    expect(scaffoldProject({ name: "." }).name).toBe("my-site");
    expect(scaffoldProject({ name: ".env" }).name).toBe("env");
    expect(scaffoldProject({ name: "../.." }).name).toBe("my-site");
  });

  it("uses the name in the page title, so the scaffold is not anonymous", () => {
    const files = scaffoldProject({ name: "bakery" }).files;

    expect(files["index.html"]).toContain("<title>bakery</title>");
    expect(files["src/App.tsx"]).toContain("bakery");
  });
});

describe("writing the scaffold into the workspace", () => {
  it("writes every file, creates the directories, and reports the paths in order", async () => {
    const environment = new FakeEnvironment();
    await environment.initialize();
    const project = scaffoldProject({ framework: "react-ts", name: "written" });

    const written = await writeScaffold(environment, project);

    expect(written).toEqual(Object.keys(project.files).sort().map((path) => `/workspace/${path}`));
    expect(written).toContain("/workspace/src/App.tsx");

    // The content really landed: read it back through the same environment the build
    // manager will read it from, rather than trusting the write call's return value.
    const app = new TextDecoder().decode(await environment.readFile("/workspace/src/App.tsx"));
    expect(app).toContain("written");
    const pkg = new TextDecoder().decode(await environment.readFile("/workspace/package.json"));
    expect(pkg).toBe(project.packageJson);

    const entries = (await environment.listFiles("/workspace")).map((entry) => entry.name).sort();
    expect(entries).toContain("index.html");
    expect(entries).toContain("src");
  });

  it("honours an explicit root, because a project does not have to be the whole workspace", async () => {
    const environment = new FakeEnvironment();
    await environment.initialize();

    const written = await writeScaffold(environment, scaffoldProject(), { root: "/workspace/site" });

    expect(written.every((path) => path.startsWith("/workspace/site/"))).toBe(true);
    expect(await environment.listFiles("/workspace/site")).not.toHaveLength(0);
  });
});
