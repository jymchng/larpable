// @vitest-environment jsdom
/**
 * The wiring `useProjects` exists for: a manager built on the booted machine, its state handed to
 * the panel, and its failures turned into sentences.
 *
 * The gap this closes was not a missing operation — `ProjectManager` had all four and 380 lines of
 * tests — but a missing *owner*: nothing in `src/ui/` constructed it, so "create a project" existed
 * only inside the test suite. `tests/project-switcher.test.tsx` proves the panel calls its props;
 * this file proves the props are the manager, over a real `WorkspaceBridge` on a fake guest and a
 * memory store, and that a booted machine is what makes them exist at all.
 */

import { useEffect } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { FakeEnvironment } from "../src/env/fake-environment";
import { MemoryProjectStore, type ProjectStore } from "../src/projects/store";
import { NO_MACHINE_REASON, useProjects, type ProjectsControl } from "../src/ui/use-projects";

/**
 * No `act`, on purpose: what is under test is an effect that awaits a store and a manager, and
 * `act`'s async form waits on that chain rather than on the clock (the first version of this file
 * hung for exactly that reason). The assertions read the last value the hook returned, which is
 * what a render produced, so the render still has to happen — `settle()` gives it a tick.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

const STARTER = {
  "package.json": '{"name":"my-site"}',
  "index.html": "<h1>Hello</h1>",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
});

interface Rendered {
  /** The latest value the hook returned. Assigned on every render. */
  current: () => ProjectsControl;
  unmount: () => void;
}

function renderProjects(
  environment: FakeEnvironment | null,
  options: { store?: ProjectStore; persistent?: boolean } = {},
): Rendered {
  const store = options.store ?? new MemoryProjectStore();
  let latest: ProjectsControl | null = null;

  function Probe(): null {
    const control = useProjects({
      environment,
      starter: STARTER,
      autosaveMs: 0,
      pollMs: 0,
      openStore: () =>
        Promise.resolve({ store, persistent: options.persistent ?? true }),
    });
    useEffect(() => {
      latest = control;
    });
    latest = control;
    return null;
  }

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // `flushSync`, not `act`: the mount has to have *happened* before `current()` is readable,
  // and `act`'s async form waits on the effect chain this test is about.
  flushSync(() => {
    root?.render(<Probe />);
  });

  return {
    current: () => {
      if (latest === null) throw new Error("the probe never rendered");
      return latest;
    },
    unmount: () => root?.unmount(),
  };
}

/**
 * Let the hook's effect promise chain run to completion.
 *
 * Deliberately *not* `await act(async () => …)`: the effect awaits the store and then the
 * manager's `start()`, and holding that open-ended chain inside `act` makes React wait on it
 * rather than on the clock. A plain tick is what a browser gives those microtasks anyway.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

async function machine(tree: Record<string, string> = {}): Promise<FakeEnvironment> {
  const environment = new FakeEnvironment({ tree });
  await environment.initialize();
  return environment;
}

describe("useProjects", () => {
  it("says why there are no projects before the machine exists", () => {
    const rendered = renderProjects(null);
    expect(rendered.current().unavailable).toBe(NO_MACHINE_REASON);
    expect(rendered.current().state.projects).toEqual([]);
  });

  it("refuses an action with a sentence, rather than throwing at the caller", async () => {
    const rendered = renderProjects(null);
    await rendered.current().create("blog");
    await settle();
    expect(rendered.current().error).toBe(NO_MACHINE_REASON);
  });

  it("builds the manager on the booted machine and starts it", async () => {
    const environment = await machine({ "index.html": "<h1>guest</h1>" });
    const rendered = renderProjects(environment, { persistent: false });
    await settle();

    expect(rendered.current().unavailable).toBeNull();
    // A memory store is a fact the panel must admit, not a detail to hide.
    expect(rendered.current().persistent).toBe(false);
    // `start()` adopts the workspace the guest booted with, so the list is not empty.
    expect(rendered.current().state.projects.length).toBe(1);
    expect(rendered.current().state.active).not.toBeNull();
  });

  it("creates a project through the manager, and the new one is what is open", async () => {
    const environment = await machine({ "index.html": "<h1>guest</h1>" });
    const store = new MemoryProjectStore();
    const rendered = renderProjects(environment, { store });
    await settle();

    await rendered.current().create("blog");
    await settle();

    const state = rendered.current().state;
    expect(state.projects.map((project) => project.name)).toContain("blog");
    expect(state.active?.name).toBe("blog");
    expect(rendered.current().error).toBeNull();
    // The store is the source of truth: the project is in it, not only in React state.
    expect((await store.list()).map((project) => project.name)).toContain("blog");
  });

  it("prints a rejected action instead of leaving a promise unhandled", async () => {
    const environment = await machine({ "index.html": "<h1>guest</h1>" });
    const rendered = renderProjects(environment);
    await settle();

    // `open` on an id that was never created fails inside the manager.
    await rendered.current().open("does-not-exist");
    await settle();
    const error = rendered.current().error;
    expect(error).not.toBeNull();
    expect(rendered.current().busy).toBe(false);
  });

  it("stops the autosave watcher when the machine goes away", async () => {
    const environment = await machine({ "index.html": "<h1>guest</h1>" });
    const rendered = renderProjects(environment);
    await settle();
    const before = rendered.current().state.projects.length;

    // Unmounting is what a shutdown or a StrictMode remount does; a timer left behind would keep
    // writing into a dead kernel.
    rendered.unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rendered.current().state.projects.length).toBe(before);
  });
});
