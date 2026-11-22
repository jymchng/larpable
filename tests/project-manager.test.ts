import { describe, expect, it } from "vitest";

import { OutsideWorkspaceError } from "../src/env/environment-errors";
import { FakeEnvironment } from "../src/env/fake-environment";
import { WorkspaceBridge } from "../src/env/fs-bridge";
import { ProjectManager } from "../src/projects/manager";
import { MemoryProjectStore, type ProjectStore } from "../src/projects/store";

const STARTER = {
  "package.json": '{"name":"my-site"}',
  "index.html": "<h1>Hello</h1>",
};

interface Harness {
  environment: FakeEnvironment;
  store: MemoryProjectStore;
  bridge: WorkspaceBridge;
  manager: ProjectManager;
  /** Advance the fixed clock so ordering assertions are meaningful. */
  tick(): number;
}

async function harness(
  options: {
    tree?: Record<string, string>;
    store?: MemoryProjectStore;
    autosaveMs?: number;
    pollMs?: number;
  } = {},
): Promise<Harness> {
  let clock = 1_000;
  const environment = new FakeEnvironment({ tree: options.tree ?? {}, now: () => clock });
  await environment.initialize();
  const bridge = new WorkspaceBridge(environment, { now: () => clock });
  const store = options.store ?? new MemoryProjectStore();

  let sequence = 0;
  const manager = new ProjectManager({
    bridge,
    store,
    starter: STARTER,
    now: () => clock,
    newId: () => `project-${String(++sequence)}`,
    autosaveMs: options.autosaveMs ?? 0,
    pollMs: options.pollMs ?? 0,
  });

  return {
    environment,
    store,
    bridge,
    manager,
    tick: () => ++clock,
  };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe("project lifecycle", () => {
  it("adopts the workspace that the guest booted with as the first project", async () => {
    const { manager, bridge } = await harness({ tree: { "index.html": "<h1>booted</h1>" } });

    const project = await manager.restore();

    expect(project).toMatchObject({ name: "my-site", fileCount: 1, conversation: [] });
    expect(await bridge.readText("index.html")).toBe("<h1>booted</h1>");
    expect(manager.state().projects).toHaveLength(1);
    expect(manager.state().error).toBeNull();
  });

  it("creates a project from the starter and makes it the open one", async () => {
    const { manager, bridge, store } = await harness();

    const project = await manager.create("Landing page");

    expect(project.name).toBe("Landing page");
    expect(await bridge.readText("package.json")).toBe(STARTER["package.json"]);
    expect(manager.activeProject()?.id).toBe(project.id);
    expect(await store.activeId()).toBe(project.id);
    expect((await store.list()).map((entry) => entry.name)).toEqual(["Landing page"]);
  });

  it("rejects an empty, oversized or slash-containing name", async () => {
    const { manager } = await harness();

    await expect(manager.create("   ")).rejects.toThrow(/needs a name/);
    await expect(manager.create("x".repeat(61))).rejects.toThrow(/at most 60/);
    await expect(manager.create("a/b")).rejects.toThrow(/cannot contain a slash/);
  });

  it("switches the workspace when another project is opened", async () => {
    const { manager, bridge } = await harness();

    const first = await manager.create("First", { files: { "index.html": "first" } });
    const second = await manager.create("Second", { files: { "index.html": "second", "about.html": "b" } });
    await manager.open(first.id);

    expect(await bridge.readText("index.html")).toBe("first");
    expect(await bridge.exists("about.html")).toBe(false);

    await manager.open(second.id);
    expect(await bridge.readText("index.html")).toBe("second");
    expect(await bridge.readText("about.html")).toBe("b");
  });

  it("renames without changing identity and deletes cleanly", async () => {
    const { manager, store } = await harness();
    const project = await manager.create("Draft");

    const renamed = await manager.rename(project.id, "  Shipped  ");
    expect(renamed).toMatchObject({ id: project.id, name: "Shipped" });
    expect((await store.list())[0]?.name).toBe("Shipped");

    await manager.remove(project.id);
    expect(await store.list()).toEqual([]);
    expect(manager.activeProject()).toBeNull();
    expect(await store.activeId()).toBeNull();
  });

  it("refuses to open a project that is not stored", async () => {
    const { manager } = await harness();
    await expect(manager.open("nope")).rejects.toThrow(/not saved in this browser/);
  });
});

describe("persistence", () => {
  it("saves host edits and records the file count and timestamps", async () => {
    const { manager, bridge, store, tick } = await harness();
    const project = await manager.create("Site");
    await bridge.write("notes.md", "# notes");
    tick();

    const saved = await manager.save();

    expect(saved).toMatchObject({ id: project.id, fileCount: 3 });
    expect(saved?.updatedAt).toBeGreaterThan(project.updatedAt);
    const record = await store.get(project.id);
    expect(new TextDecoder().decode(record?.files["notes.md"])).toBe("# notes");
  });

  it("saves guest edits automatically once the poll sees them", async () => {
    const { manager, environment, store } = await harness({ autosaveMs: 0, pollMs: 10 });
    const project = await manager.create("Site");
    await manager.start();
    try {
      await environment.writeFile("from-linux.txt", "written in the guest");
      await settle();

      const record = await store.get(project.id);
      expect(new TextDecoder().decode(record?.files["from-linux.txt"])).toBe("written in the guest");
    } finally {
      manager.stop();
    }
  });

  it("reopens the last session in a fresh manager against the same store", async () => {
    const first = await harness();
    const project = await first.manager.create("Session", { files: { "index.html": "persisted" } });

    const second = await harness({ store: first.store });
    const restored = await second.manager.restore();

    expect(restored?.id).toBe(project.id);
    expect(await second.bridge.readText("index.html")).toBe("persisted");
  });

  it("keeps the conversation with the project", async () => {
    const { manager, store } = await harness();
    const project = await manager.create("Chat");

    await manager.appendTurn({ role: "user", content: "build me a page", at: 10 });
    await manager.appendTurn({ role: "assistant", content: "done", at: 20 });

    const record = await store.get(project.id);
    expect(record?.metadata.conversation).toEqual([
      { role: "user", content: "build me a page", at: 10 },
      { role: "assistant", content: "done", at: 20 },
    ]);
    expect(manager.activeProject()?.conversation).toHaveLength(2);
  });

  it("surfaces a save failure instead of claiming success", async () => {
    const store = new MemoryProjectStore();
    const failing: ProjectStore = {
      list: () => store.list(),
      get: (id) => store.get(id),
      put: async () => {
        throw new Error("quota exceeded");
      },
      delete: (id) => store.delete(id),
      activeId: () => store.activeId(),
      setActiveId: (id) => store.setActiveId(id),
    };

    const environment = new FakeEnvironment();
    await environment.initialize();
    const manager = new ProjectManager({
      bridge: new WorkspaceBridge(environment),
      store: failing,
      starter: STARTER,
      autosaveMs: 0,
    });

    await expect(manager.create("Doomed")).rejects.toThrow(/quota exceeded/);
  });
});

describe("workspace boundary", () => {
  it("refuses to create a project whose files escape the workspace", async () => {
    const { manager } = await harness();

    await expect(
      manager.create("Escape", { files: { "../outside.txt": "nope" } }),
    ).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });

  it("refuses to open a stored project that contains an escaping path", async () => {
    const store = new MemoryProjectStore();
    await store.put({
      metadata: {
        id: "poisoned",
        name: "Poisoned",
        template: "vite",
        createdAt: 1,
        updatedAt: 1,
        fileCount: 1,
        conversation: [],
      },
      files: { "../../etc/passwd": new Uint8Array([1]) },
    });

    const environment = new FakeEnvironment();
    await environment.initialize();
    const manager = new ProjectManager({
      bridge: new WorkspaceBridge(environment),
      store,
      starter: STARTER,
      autosaveMs: 0,
    });

    await expect(manager.open("poisoned")).rejects.toBeInstanceOf(OutsideWorkspaceError);
  });
});
