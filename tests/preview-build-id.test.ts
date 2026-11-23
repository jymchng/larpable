/**
 * The build id is the preview's anti-staleness primitive, so these tests are about the two
 * failures it must not have: the same id for two different builds (a stale tab renders old
 * bytes under a fresh label), and a new id for the same build (the iframe reloads for
 * nothing, and a deep link the user is reading disappears).
 */

import { describe, expect, it } from "vitest";

import { deriveBuildId, listPublishFiles } from "../src/preview/build-id";
import { FakeEnvironment } from "../src/env/fake-environment";

const build = [
  { path: "/index.html", size: 412 },
  { path: "/assets/index-abc123.js", size: 91_204 },
  { path: "/assets/index-def456.css", size: 3_010 },
];

describe("deriveBuildId", () => {
  it("names a build with a short, URL-safe id", () => {
    const id = deriveBuildId(build);

    expect(id).toMatch(/^b-[0-9a-z]{7}$/);
    // It is a path segment, so it must not need escaping.
    expect(encodeURIComponent(id ?? "")).toBe(id);
  });

  it("is stable for the same listing regardless of the order the guest returns it in", () => {
    const forwards = deriveBuildId(build);
    const backwards = deriveBuildId([...build].reverse());

    expect(forwards).toBe(backwards);
  });

  it("changes when a file's size changes, and when a path changes", () => {
    const changedSize = deriveBuildId(
      build.map((file) =>
        file.path === "/index.html" ? { ...file, size: file.size + 1 } : file,
      ),
    );
    const renamed = deriveBuildId(
      build.map((file) =>
        file.path === "/assets/index-abc123.js"
          ? { ...file, path: "/assets/index-xyz789.js" }
          : file,
      ),
    );

    expect(changedSize).not.toBe(deriveBuildId(build));
    expect(renamed).not.toBe(deriveBuildId(build));
  });

  it("changes when a file is added or removed, which is what a rebuild usually does", () => {
    const added = deriveBuildId([...build, { path: "/favicon.svg", size: 220 }]);

    expect(added).not.toBe(deriveBuildId(build));
    expect(deriveBuildId(build.slice(0, 2))).not.toBe(deriveBuildId(build));
  });

  it("has no id for an empty publish directory", () => {
    expect(deriveBuildId([])).toBeNull();
  });
});

describe("listPublishFiles", () => {
  function environmentWithDist(): FakeEnvironment {
    const environment = new FakeEnvironment({
      workspacePath: "/workspace",
      tree: {
        "dist/index.html": "<!doctype html><div id=\"root\"></div>",
        "dist/assets/index-abc123.js": "console.log('answer = 42');",
        "dist/docs/index.html": "<!doctype html><h1>Docs</h1>",
        "package.json": "{}",
      },
    });
    return environment;
  }

  it("walks the publish directory recursively and keeps the build's own paths", async () => {
    const environment = environmentWithDist();
    await environment.initialize();

    const files = await listPublishFiles(environment);
    const paths = files.map((file) => file.path).sort();

    expect(paths).toEqual([
      "/assets/index-abc123.js",
      "/docs/index.html",
      "/index.html",
    ]);
    // A size per file, because the id would be blind to a same-length rebuild without one.
    expect(files.every((file) => file.size > 0)).toBe(true);
  });

  it("says nothing outside the publish directory belongs to the build", async () => {
    const environment = environmentWithDist();
    await environment.initialize();

    const paths = (await listPublishFiles(environment)).map((file) => file.path);

    expect(paths).not.toContain("/package.json");
    expect(paths.every((path) => !path.includes("package.json"))).toBe(true);
  });

  it("returns an empty listing when there is no build yet", async () => {
    const environment = new FakeEnvironment({ workspacePath: "/workspace", tree: {} });
    await environment.initialize();

    await expect(listPublishFiles(environment)).resolves.toEqual([]);
  });

  it("honours a different publish directory", async () => {
    const environment = new FakeEnvironment({
      workspacePath: "/workspace",
      tree: { "build/index.html": "<!doctype html>", "dist/index.html": "<!doctype html>" },
    });
    await environment.initialize();

    await expect(listPublishFiles(environment, "build")).resolves.toEqual([
      { path: "/index.html", size: "<!doctype html>".length },
    ]);
  });
});
