/**
 * The deployment step as the agent flow calls it.
 *
 * `ensureNetlifyConfig` is the one function a workflow (PRD §10, §18.3) uses, and the point
 * of these tests is that it cannot report success while leaving the project without a
 * validated file: the file is written, then *read back out of the environment* and
 * validated, so a write that silently failed would show up as a failure here rather than
 * as a confident status line in the UI.
 */

import { describe, expect, it } from "vitest";

import { FakeEnvironment } from "@/env/fake-environment";
import { ensureNetlifyConfig } from "@/netlify/flow";

const PACKAGE = JSON.stringify({
  name: "site",
  scripts: { build: "vite build" },
  dependencies: { react: "^18" },
});

const VITE_REACT_TREE = {
  "package.json": PACKAGE,
  "vite.config.ts": "export default {};",
  "index.html": "<div id=app>",
  "src/main.tsx": "export {};",
};

async function environment(tree: Record<string, string>): Promise<FakeEnvironment> {
  const env = new FakeEnvironment({ tree });
  await env.initialize();
  return env;
}

async function read(env: FakeEnvironment, path: string): Promise<string | null> {
  try {
    return new TextDecoder().decode(await env.readFile(path));
  } catch {
    return null;
  }
}

describe("ensureNetlifyConfig", () => {
  it("writes netlify.toml into the project root and validates the file it wrote", async () => {
    const env = await environment(VITE_REACT_TREE);

    const result = await ensureNetlifyConfig(env, { hints: { packageManagerVersion: "1.4.5" } });

    expect(result.ok).toBe(true);
    expect(result.path).toBe("/workspace/netlify.toml");
    expect(result.sync.action).toBe("written");
    expect(result.validation.ok).toBe(true);
    expect(result.validation.issues).toEqual([]);

    const written = await read(env, "/workspace/netlify.toml");
    expect(written).toContain('command = "npm run build"');
    expect(written).toContain('publish = "dist"');
    expect(written).toContain('from = "/*"');
    expect(result.decisions.join("\n")).toContain("Publish directory `dist`");
  });

  it("is idempotent: a second run changes nothing", async () => {
    const env = await environment(VITE_REACT_TREE);
    await ensureNetlifyConfig(env, {});

    const first = await read(env, "/workspace/netlify.toml");
    const second = await ensureNetlifyConfig(env, {});

    expect(second.sync.action).toBe("unchanged");
    expect(await read(env, "/workspace/netlify.toml")).toBe(first);
  });

  it("checks publish against the real build output when a build has run", async () => {
    const env = await environment(VITE_REACT_TREE);

    const result = await ensureNetlifyConfig(env, {
      build: { dir: "dist", entryExists: true, entries: ["index.html", "assets/"] },
    });

    expect(result.ok).toBe(true);
    expect(result.validation.summary).toContain("checked against the last build");
  });

  it("reports a real mismatch between publish and the build output instead of passing", async () => {
    const env = await environment(VITE_REACT_TREE);

    const result = await ensureNetlifyConfig(env, { build: { dir: "build", entryExists: true } });

    expect(result.ok).toBe(false);
    expect(result.validation.issues.map((issue) => issue.code)).toContain("publish-vs-build");
  });

  it("writes into a sub-directory project when the agent says so", async () => {
    const env = await environment({ "apps/site/package.json": PACKAGE, "apps/site/vite.config.ts": "", "apps/site/index.html": "" });

    const result = await ensureNetlifyConfig(env, { root: "/workspace/apps/site" });

    expect(result.ok).toBe(true);
    expect(result.path).toBe("/workspace/apps/site/netlify.toml");
    expect(await read(env, "/workspace/apps/site/netlify.toml")).toContain('publish = "dist"');
  });

  it("refuses to claim success for a project it cannot configure", async () => {
    const env = await environment({ "package.json": JSON.stringify({ name: "x" }) });

    const result = await ensureNetlifyConfig(env, {});

    expect(result.ok).toBe(false);
    expect(result.sync.action).toBe("blocked");
    expect(await read(env, "/workspace/netlify.toml")).toBeNull();
    expect(result.validation.ok).toBe(false);
  });

  it("keeps a hand-written file with headers, and still reports what it lacks", async () => {
    const env = await environment({
      ...VITE_REACT_TREE,
      "netlify.toml": '[build]\n  publish = "dist"\n  command = "npm run build"\n\n[[headers]]\n  for = "/*"\n  [headers.values]\n    X-Frame-Options = "DENY"\n',
    });

    const result = await ensureNetlifyConfig(env, {});

    expect(result.sync.action).toBe("preserved");
    expect(result.sync.reason).toContain("[headers]");
    // Preserving a file is not blessing it: this one has no SPA fallback, so the run has
    // to come back as "not ready" with the specific issue rather than a green tick.
    expect(result.ok).toBe(false);
    expect(result.validation.issues.map((issue) => issue.code)).toContain("missing-spa-redirect");
  });
});
