/**
 * The build manager's judgements, tested without a guest.
 *
 * Every case here is a decision the manager makes over text it read from the project:
 * which command, which output directory, and what a non-zero exit means. They are
 * asserted by their *source* (`scripts.build` vs `framework-default`) as well as their
 * value, because "we looked" and "we assumed" must not read the same in a log.
 */

import { describe, expect, it } from "vitest";

import {
  classifyFailure,
  detectBuildCommand,
  errorLines,
  parsePackageJson,
  resolveOutputDir,
  runScriptCommand,
  type BuildFailureKind,
} from "@/build/plan";

const pkg = (scripts: Record<string, string> | null) =>
  parsePackageJson(JSON.stringify({ name: "x", ...(scripts ? { scripts } : {}) }));

describe("parsePackageJson", () => {
  it("reads scripts from a normal package.json", () => {
    expect(pkg({ build: "vite build" })).toEqual({
      json: { name: "x", scripts: { build: "vite build" } },
      problem: null,
    });
  });

  it("reports broken JSON as a problem instead of throwing", () => {
    const parsed = parsePackageJson("{ nope");
    expect(parsed.json).toBeNull();
    expect(parsed.problem).toMatch(/not valid JSON/);
  });

  it("rejects a JSON array, because it has no scripts", () => {
    expect(parsePackageJson("[]")).toEqual({
      json: null,
      problem: "package.json is not a JSON object",
    });
  });
});

describe("detectBuildCommand", () => {
  it("prefers the project's own build script and says so", () => {
    const { plan, problem } = detectBuildCommand({
      packageJson: pkg({ build: "vite build --mode production" }),
      packageManager: "npm",
    });

    expect(problem).toBeNull();
    expect(plan).toMatchObject({ command: "npm run build", source: "scripts.build" });
    expect(plan?.reason).toContain("vite build --mode production");
  });

  it("uses the package manager the runtime chose", () => {
    const { plan } = detectBuildCommand({
      packageJson: pkg({ build: "vite build" }),
      packageManager: "bun",
    });

    expect(plan?.command).toBe("bun run build");
  });

  it("falls back to the framework default only when there is no script", () => {
    const { plan } = detectBuildCommand({
      packageJson: pkg({ dev: "vite" }),
      packageManager: "npm",
      framework: "react-ts",
    });

    expect(plan).toMatchObject({ command: "vite build", source: "framework-default" });
    expect(plan?.reason).toContain("no `build` script");
  });

  it("treats an empty build script as missing rather than running it", () => {
    const { plan } = detectBuildCommand({
      packageJson: pkg({ build: "   " }),
      packageManager: "npm",
      framework: "vanilla",
    });

    expect(plan?.source).toBe("framework-default");
  });

  it("refuses to invent a build command for an unknown project", () => {
    const { plan, problem } = detectBuildCommand({
      packageJson: pkg({ test: "vitest" }),
      packageManager: "npm",
    });

    expect(plan).toBeNull();
    expect(problem).toMatch(/no `build` script/);
  });

  it("carries a package.json problem through instead of guessing", () => {
    const { plan, problem } = detectBuildCommand({
      packageJson: parsePackageJson("{ oops"),
      packageManager: "npm",
      framework: "react-ts",
    });

    expect(plan).toBeNull();
    expect(problem).toMatch(/not valid JSON/);
  });
});

describe("resolveOutputDir", () => {
  it("believes vite.config's build.outDir over every default", () => {
    const plan = resolveOutputDir({
      viteConfig: 'export default defineConfig({ build: { outDir: "public" } });',
      netlifyToml: '[build]\n  publish = "dist"\n',
    });

    expect(plan).toMatchObject({ dir: "public", source: "vite-config" });
  });

  it("ignores an outDir that only appears inside a comment", () => {
    const plan = resolveOutputDir({
      viteConfig: '// build: { outDir: "nope" }\nexport default {};',
    });

    expect(plan.source).toBe("framework-default");
  });

  it("normalises a `./dir/` spelling to a plain relative directory", () => {
    expect(
      resolveOutputDir({ viteConfig: "build: { outDir: './site/' }" }).dir,
    ).toBe("site");
  });

  it("uses netlify.toml's publish when vite does not say", () => {
    const plan = resolveOutputDir({ netlifyToml: '[build]\n  publish = "build"\n' });

    expect(plan).toMatchObject({ dir: "build", source: "netlify-toml" });
    expect(plan.reason).toContain("netlify.toml");
  });

  it("knows react-scripts writes to build/", () => {
    const plan = resolveOutputDir({
      packageJson: { scripts: { build: "react-scripts build" } },
    });

    expect(plan).toMatchObject({ dir: "build", source: "react-scripts" });
  });

  it("defaults to dist and admits it is a default", () => {
    const plan = resolveOutputDir({ framework: "react-ts", packageJson: { scripts: {} } });

    expect(plan).toMatchObject({ dir: "dist", source: "framework-default" });
    expect(plan.reason).toMatch(/default/);
  });
});

describe("classifyFailure", () => {
  const classify = (stderr: string, extra: { exitCode?: number | null; stdout?: string } = {}) =>
    classifyFailure({
      command: "npm run build",
      exitCode: extra.exitCode === undefined ? 1 : extra.exitCode,
      stdout: extra.stdout ?? "",
      stderr,
    });

  const kinds: Array<[string, BuildFailureKind, string]> = [
    ["missing script", "missing-script", 'npm ERR! Missing script: "build"'],
    ["an exhausted guest", "out-of-memory", "FATAL ERROR: Reached heap limit: JavaScript heap out of memory"],
    ["network", "network", "npm ERR! code EAI_AGAIN"],
    ["permission", "permission", "npm ERR! code EACCES, mkdir '/root/.npm'"],
    ["missing dependency", "missing-dependency", "Error: Cannot find module 'vite'"],
    ["compile", "compile", "src/App.tsx(3,7): error TS2322: Type 'x' is not assignable"],
  ];

  for (const [label, kind, stderr] of kinds) {
    it(`names ${label} as ${kind}`, () => {
      expect(classify(stderr).kind).toBe(kind);
    });
  }

  it("reports the network failure when a broken install also mentions TypeScript", () => {
    const failure = classify(
      "npm ERR! code ENOTFOUND\nsrc/main.tsx(1,1): error TS1005: ';' expected",
    );

    expect(failure.kind).toBe("network");
    expect(failure.summary).toContain("registry");
  });

  it("quotes the guest's own error lines as detail", () => {
    const failure = classify("vite v5.4.11 building\nRollup failed to resolve import \"react\"\n");

    expect(failure.kind).toBe("compile");
    expect(failure.detail).toContain("Rollup failed to resolve import");
  });

  it("strips ANSI colours so the detail is readable", () => {
    const failure = classify("\u001b[31merror TS2322\u001b[0m: bad type\n");

    expect(failure.detail).not.toContain("\u001b[");
    expect(failure.detail).toContain("error TS2322");
  });

  it("says it recognised nothing instead of inventing a cause", () => {
    const failure = classify("something odd happened\n", { exitCode: null });

    expect(failure.kind).toBe("unknown");
    expect(failure.summary).toContain("killed by a signal");
    expect(failure.hint).toMatch(/nothing here was invented/);
    expect(failure.detail).toBe("something odd happened");
  });

  it("names the memory budget it can be raised with when the guest runs out", () => {
    const failure = classify("napi: ENOMEM: Cannot allocate memory\n");

    expect(failure.kind).toBe("out-of-memory");
    expect(failure.summary).toContain("ran out of memory");
    // The hint has to be actionable: the limit is a boot option, so name it and its ceiling.
    expect(failure.hint).toContain("VITE_LINUX_MEMORY_MIB");
    expect(failure.hint).toContain("1024 MiB");
    expect(failure.hint).toContain("4096");
  });

  it("does not call a bare SIGKILL an out-of-memory failure", () => {
    // A timeout, a cancel and a user's `kill -9` all end this way. Guessing "memory" from
    // the word "Killed" alone would blame the wrong thing with full confidence.
    const failure = classify("Killed\n", { exitCode: null });

    expect(failure.kind).toBe("unknown");
  });
});

describe("errorLines", () => {
  it("keeps error-shaped lines, dedupes them and honours the limit", () => {
    const output = [
      "npm WARN deprecated thing",
      "error one",
      "error one",
      "failed to load",
      "error three",
    ].join("\n");

    expect(errorLines(output)).toEqual(["error one", "failed to load", "error three"]);
    expect(errorLines(output, 2)).toEqual(["failed to load", "error three"]);
    expect(errorLines("all good\n")).toEqual([]);
  });
});

describe("runScriptCommand", () => {
  it("uses the detected package manager", () => {
    expect(runScriptCommand("npm", "build")).toBe("npm run build");
    expect(runScriptCommand("bun", "build")).toBe("bun run build");
  });
});
