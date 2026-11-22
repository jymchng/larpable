import { describe, expect, it } from "vitest";

import { OutsideWorkspaceError } from "../src/env/environment-errors";
import { FakeEnvironment } from "../src/env/fake-environment";
import { WorkspaceBridge } from "../src/env/fs-bridge";

async function readyEnvironment(tree: Record<string, string> = {}): Promise<FakeEnvironment> {
  const environment = new FakeEnvironment({ tree, now: () => 1_000 });
  await environment.initialize();
  return environment;
}

function bridgeFor(environment: FakeEnvironment, options = {}): WorkspaceBridge {
  return new WorkspaceBridge(environment, { now: () => 1_000, ...options });
}

describe("WorkspaceBridge path boundary", () => {
  it("resolves workspace-relative and guest-absolute paths to the same file", async () => {
    const bridge = bridgeFor(await readyEnvironment());

    await bridge.write("src/app.ts", "one");
    await bridge.write("/workspace/src/app.ts", "two");

    expect(await bridge.readText("src/app.ts")).toBe("two");
    expect(await bridge.readText("/workspace/src/app.ts")).toBe("two");
    expect(bridge.guestPathOf("src/app.ts")).toBe("/workspace/src/app.ts");
  });

  it.each([
    ["..", "the workspace root itself"],
    ["../etc/passwd", "a parent escape"],
    ["/etc/passwd", "an absolute path elsewhere"],
    ["/workspace/../etc/shadow", "a climb out of the workspace"],
    ["src/../../outside.txt", "a nested escape"],
    ["/workspaceX/file.txt", "a sibling with the same prefix"],
  ])("rejects %s (%s)", async (path) => {
    const bridge = bridgeFor(await readyEnvironment());

    expect(() => bridge.resolve(path)).toThrow(OutsideWorkspaceError);
    await expect(bridge.write(path, "nope")).rejects.toBeInstanceOf(OutsideWorkspaceError);
    await expect(bridge.read(path)).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("rejects a path containing a NUL byte", async () => {
    const bridge = bridgeFor(await readyEnvironment());
    expect(() => bridge.resolve("src/app\0.ts")).toThrow(OutsideWorkspaceError);
  });
});

describe("WorkspaceBridge file operations", () => {
  it("round-trips bytes and text, creating parent directories", async () => {
    const bridge = bridgeFor(await readyEnvironment());

    await bridge.write("src/deep/file.txt", "hello");
    const bytes = new Uint8Array([0, 1, 2, 255]);
    await bridge.write("assets/icon.bin", bytes);

    expect(await bridge.readText("src/deep/file.txt")).toBe("hello");
    expect([...(await bridge.read("assets/icon.bin"))]).toEqual([0, 1, 2, 255]);
    expect(await bridge.exists("src/deep/file.txt")).toBe(true);
    expect(await bridge.exists("src/deep/missing.txt")).toBe(false);
  });

  it("walks and snapshots the tree, skipping ignored directories", async () => {
    const bridge = bridgeFor(await readyEnvironment());
    await bridge.write("index.html", "<html></html>");
    await bridge.write("src/main.ts", "export {};");
    await bridge.write("node_modules/react/index.js", "module.exports = {};");

    const paths = (await bridge.walk()).map((entry) => entry.path);
    expect(paths).toContain("index.html");
    expect(paths).toContain("src/main.ts");
    expect(paths).not.toContain("node_modules/react/index.js");

    const tree = await bridge.tree();
    expect(Object.keys(tree).sort()).toEqual(["index.html", "src/main.ts"]);
    expect(new TextDecoder().decode(tree["src/main.ts"])).toBe("export {};");
  });

  it("refuses to walk an unbounded tree instead of hanging", async () => {
    const bridge = bridgeFor(await readyEnvironment(), { maxEntries: 2 });
    await bridge.write("a.txt", "a");
    await bridge.write("b.txt", "b");
    await bridge.write("c.txt", "c");

    await expect(bridge.walk()).rejects.toThrow(/more than 2 entries/);
  });

  it("clears the workspace, deepest first, and keeps it usable", async () => {
    const bridge = bridgeFor(await readyEnvironment());
    await bridge.write("index.html", "x");
    await bridge.write("node_modules/pkg/index.js", "y");
    await bridge.write("src/main.ts", "z");

    await bridge.clear();

    expect(await bridge.walk("", { ignore: false })).toEqual([]);
    await bridge.write("index.html", "again");
    expect(await bridge.readText("index.html")).toBe("again");
  });
});

describe("WorkspaceBridge change notifications", () => {
  it("reports host writes and removals as host changes", async () => {
    const bridge = bridgeFor(await readyEnvironment());
    const seen: string[] = [];
    bridge.onChange((change) => seen.push(`${change.origin}:${change.kind}:${change.path}`));

    await bridge.write("index.html", "x");
    await bridge.remove("index.html");

    expect(seen).toEqual(["host:write:index.html", "host:delete:index.html"]);
  });

  it("stops notifying after unsubscribe", async () => {
    const bridge = bridgeFor(await readyEnvironment());
    let count = 0;
    const off = bridge.onChange(() => (count += 1));

    await bridge.write("a.txt", "1");
    off();
    await bridge.write("b.txt", "2");

    expect(count).toBe(1);
  });

  it("detects a guest write exactly once", async () => {
    const environment = await readyEnvironment();
    const bridge = bridgeFor(environment);
    const changes: string[] = [];
    bridge.onChange((change) => changes.push(`${change.origin}:${change.kind}:${change.path}`));

    // Linux writing to the shared mount never goes through the bridge.
    await environment.writeFile("src/edited-in-linux.ts", "export const a = 1;");

    const first = await bridge.scan();
    expect(first).toEqual([
      { kind: "write", path: "src/edited-in-linux.ts", origin: "guest", at: 1_000 },
    ]);
    expect(changes).toEqual(["guest:write:src/edited-in-linux.ts"]);

    await expect(bridge.scan()).resolves.toEqual([]);
  });

  it("detects a same-length guest edit, which a size-only diff would miss", async () => {
    const environment = await readyEnvironment({ "src/app.ts": "export const a = 1;" });
    const bridge = bridgeFor(environment);
    await bridge.scan();

    await environment.writeFile("src/app.ts", "export const a = 2;");

    await expect(bridge.scan()).resolves.toMatchObject([
      { kind: "write", path: "src/app.ts", origin: "guest" },
    ]);
  });

  it("detects a guest deletion", async () => {
    const environment = await readyEnvironment({ "notes.txt": "temporary" });
    const bridge = bridgeFor(environment);
    await bridge.scan();

    await environment.removeFile("notes.txt");

    await expect(bridge.scan()).resolves.toMatchObject([
      { kind: "delete", path: "notes.txt", origin: "guest" },
    ]);
  });

  it("does not report host writes as guest edits", async () => {
    const bridge = bridgeFor(await readyEnvironment());
    await bridge.write("index.html", "x");

    await expect(bridge.scan()).resolves.toEqual([]);
  });

  it("ignores node_modules, dist and the probe directory during a scan", async () => {
    const environment = await readyEnvironment();
    const bridge = bridgeFor(environment);
    await bridge.scan();

    await environment.writeFile("node_modules/react/index.js", "x");
    await environment.writeFile("dist/index.html", "x");
    await environment.writeFile(".larpable/probe.txt", "x");

    await expect(bridge.scan()).resolves.toEqual([]);
  });
});
