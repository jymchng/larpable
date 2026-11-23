// @vitest-environment jsdom
/**
 * The projects panel, driven: the four actions, the two sentences, and the state a person sees.
 *
 * Until this file the app had a `ProjectManager` with 380 lines and a passing test suite, and a
 * person could not create a project: nothing in `src/ui/` called it. So the assertions here are
 * about the wiring that was missing, not about formatting: a press on `Open` reaches the
 * manager's operation for *that* id, a delete needs a second press (it deletes files, and there
 * is no undo), a failure appears as a sentence rather than a rejected promise, and a workspace
 * that will not survive a reload says so.
 *
 * jsdom rather than `renderToStaticMarkup`, because a static string cannot be *pressed*. The
 * real Escape / press-outside / focus behaviour of the surface still belongs to `Popover` and to
 * the Chromium audits; what this file proves is that the body the popover holds is wired to the
 * operations the manager actually exposes.
 */

import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { summarizeDistro } from "../src/env/distro";
import { evaluateSupport } from "../src/env/support";
import { INITIAL_ENVIRONMENT } from "../src/env/status";
import type { ProjectMetadata } from "../src/projects/store";
import type { ProjectState } from "../src/projects/manager";
import { EMPTY_PROJECT_STATE } from "../src/projects/manager";
import { Dashboard } from "../src/ui/dashboard";
import { StatusFacts } from "../src/ui/status-bar-view";
import { NO_TERMINAL } from "../src/ui/terminal-connection";
import {
  describeProjectStatus,
  ProjectSwitcher,
  relativeTime,
  type ProjectSwitcherProps,
} from "../src/ui/project-switcher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

function metadata(id: string, name: string, fileCount = 3): ProjectMetadata {
  return {
    id,
    name,
    template: "vite",
    createdAt: 1,
    updatedAt: 1,
    fileCount,
    conversation: [],
  };
}

interface Calls {
  created: string[];
  opened: string[];
  renamed: Array<[string, string]>;
  removed: string[];
}

/** Mount the real panel, recording every call the way the manager would receive it. */
function mount(overrides: Partial<ProjectSwitcherProps> = {}): { calls: Calls; host: HTMLElement } {
  const calls: Calls = { created: [], opened: [], renamed: [], removed: [] };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ProjectSwitcher
        state={EMPTY_PROJECT_STATE}
        onCreate={(name) => calls.created.push(name)}
        onOpen={(id) => calls.opened.push(id)}
        onRename={(id, name) => calls.renamed.push([id, name])}
        onRemove={(id) => calls.removed.push(id)}
        now={() => 1_000_000}
        {...overrides}
      />,
    );
  });
  return { calls, host: container };
}

function press(host: HTMLElement, testId: string): void {
  const element = query(host, testId);
  act(() => {
    element.click();
  });
}

function query(host: HTMLElement, testId: string): HTMLElement {
  const element = host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (element === null) throw new Error(`no element with data-testid=${testId}`);
  return element;
}

/**
 * React tracks an input's value on the DOM node, so assigning `.value` directly is invisible to
 * it: the setter has to be called through the prototype and an `input` event dispatched, which is
 * what typing does in a browser.
 */
function type(host: HTMLElement, testId: string, value: string): void {
  const input = query(host, testId) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submit(host: HTMLElement, testId: string): void {
  const form = query(host, testId) as HTMLFormElement;
  act(() => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const TWO: ProjectState = {
  active: metadata("p1", "landing-page", 4),
  projects: [metadata("p1", "landing-page", 4), metadata("p2", "docs-site", 7)],
  saving: false,
  dirty: false,
  lastSavedAt: 940_000,
  error: null,
};

describe("describeProjectStatus", () => {
  it("says a save is running before it says anything else", () => {
    expect(describeProjectStatus({ ...TWO, saving: true, dirty: true })).toBe("Saving…");
  });

  it("says the workspace is unsaved when it is dirty and idle", () => {
    expect(describeProjectStatus({ ...TWO, dirty: true })).toBe("Unsaved changes");
  });

  it("says nothing is open when nothing is", () => {
    expect(describeProjectStatus(EMPTY_PROJECT_STATE)).toBe("No project is open");
  });

  it("refuses to claim a save time for a project that has never been saved", () => {
    expect(describeProjectStatus({ ...TWO, lastSavedAt: null })).toBe("Not saved yet");
  });

  it("reports the last save relative to a fixed clock", () => {
    expect(describeProjectStatus(TWO, 1_000_000)).toBe("Saved 1 min ago");
  });
});

describe("relativeTime", () => {
  it("buckets seconds, minutes, hours and days", () => {
    const now = 100_000_000;
    expect(relativeTime(now - 2_000, now)).toBe("just now");
    expect(relativeTime(now - 30_000, now)).toBe("30 s ago");
    expect(relativeTime(now - 3 * 60_000, now)).toBe("3 min ago");
    expect(relativeTime(now - 5 * 3_600_000, now)).toBe("5 h ago");
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
  });
});

describe("ProjectSwitcher", () => {
  it("lists every project and marks the open one for sight and for a screen reader", () => {
    const { host } = mount({ state: TWO });
    const rows = [...host.querySelectorAll("[data-testid=project-row]")];
    expect(rows).toHaveLength(2);
    const active = rows[0]!;
    expect(active.getAttribute("data-active")).toBe("true");
    const open = active.querySelector("[data-testid=project-open]")!;
    // Colour is the second channel: `aria-current` is what the list *says*.
    expect(open.getAttribute("aria-current")).toBe("true");
    expect(rows[1]!.querySelector("[data-testid=project-open]")!.getAttribute("aria-current")).toBeNull();
    expect(host.textContent).toContain("docs-site");
    expect(host.textContent).toContain("7 f");
  });

  it("creates a project from a trimmed name and clears the field", () => {
    const { calls, host } = mount({ state: TWO });
    type(host, "project-name", "  blog  ");
    submit(host, "project-create");
    expect(calls.created).toEqual(["blog"]);
    expect((query(host, "project-name") as HTMLInputElement).value).toBe("");
  });

  it("will not create a project from whitespace", () => {
    const { calls, host } = mount({ state: TWO });
    type(host, "project-name", "   ");
    expect((query(host, "project-create-submit") as HTMLButtonElement).disabled).toBe(true);
    submit(host, "project-create");
    expect(calls.created).toEqual([]);
  });

  it("opens the project whose row was pressed, and only that one", () => {
    const { calls, host } = mount({ state: TWO });
    press(host, "project-rename-p2"); // a different row, to be sure ids do not drift
    act(() => {
      host.querySelectorAll<HTMLElement>("[data-testid=project-open]")[1]!.click();
    });
    expect(calls.opened).toEqual(["p2"]);
  });

  it("renames the row being edited, and starts from the current name", () => {
    const { calls, host } = mount({ state: TWO });
    press(host, "project-rename-p2");
    const input = query(host, "project-rename-input") as HTMLInputElement;
    expect(input.value).toBe("docs-site");
    type(host, "project-rename-input", "handbook");
    submit(host, "project-rename-form");
    expect(calls.renamed).toEqual([["p2", "handbook"]]);
    expect(host.querySelector("[data-testid=project-rename-form]")).toBeNull();
  });

  it("deletes only after a second press, because the files go too", () => {
    const { calls, host } = mount({ state: TWO });
    press(host, "project-delete-p1");
    expect(calls.removed).toEqual([]);
    expect(query(host, "project-delete-confirm").textContent).toContain("No undo");
    press(host, "project-delete-confirm-p1");
    expect(calls.removed).toEqual(["p1"]);
  });

  it("keeps the project when the confirmation is cancelled", () => {
    const { calls, host } = mount({ state: TWO });
    press(host, "project-delete-p2");
    press(host, "project-delete-cancel-p2");
    expect(calls.removed).toEqual([]);
    expect(host.querySelector("[data-testid=project-delete-confirm]")).toBeNull();
  });

  it("says why projects cannot be managed, and disables the controls instead of failing", () => {
    const { host } = mount({ state: EMPTY_PROJECT_STATE, unavailable: "Linux is not ready." });
    expect(query(host, "projects-unavailable").textContent).toBe("Linux is not ready.");
    expect((query(host, "project-name") as HTMLInputElement).disabled).toBe(true);
    expect((query(host, "project-create-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("admits a store that will not survive a reload", () => {
    const remembered = mount({ state: TWO, persistent: true });
    expect(remembered.host.querySelector("[data-testid=projects-session-only]")).toBeNull();

    const session = mount({ state: TWO, persistent: false });
    expect(query(session.host, "projects-session-only").textContent).toContain("until the page is");
  });

  it("prints a failed action as a sentence, not a rejected promise", () => {
    const { host } = mount({ state: TWO, error: "A project name cannot contain a slash." });
    const alert = query(host, "projects-error");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe("A project name cannot contain a slash.");
  });

  it("disables the actions while one is running, so a double press is not two deletes", () => {
    const { host } = mount({ state: TWO, busy: true });
    expect((query(host, "project-create-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(
      (host.querySelector("[data-testid=project-delete-p1]") as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

/**
 * The header half: there is no header half any more.
 *
 * The folder glyph, its popover and the badge beside it were removed on request ("remove the
 * Projects popover at the header"). The panel itself still exists — the app creates and remembers
 * an active project, and the status bar names it — but a header control that opened it is gone,
 * and this asserts the removal rather than leaving the old ids to be found by the next person
 * grepping for them.
 */
describe("the header after the projects surface was removed", () => {
  function shell(): string {
    return renderToStaticMarkup(
      <Dashboard
        version="9.9.9"
        support={evaluateSupport({ crossOriginIsolated: true, jspi: true, sharedArrayBuffer: true })}
        environment={INITIAL_ENVIRONMENT}
        distro={summarizeDistro([], null)}
        statusFacts={
          <StatusFacts
            input={{
              environment: INITIAL_ENVIRONMENT,
              project: { name: "landing-page", root: "/workspace" },
              build: { kind: "none" },
              netlify: { kind: "unknown" },
              preview: { kind: "idle" },
              terminal: NO_TERMINAL,
            }}
          />
        }
        chat={<div data-testid="chat-slot" />}
        settings={<div data-testid="settings-slot" />}
      />,
    );
  }

  it("renders no folder glyph, no projects popover and no project badge", () => {
    const html = shell();

    expect(html).not.toContain('data-testid="projects-toggle"');
    expect(html).not.toContain('data-testid="projects-anchor"');
    expect(html).not.toContain('data-testid="active-project"');
    expect(html).not.toContain("projects-popover");
  });

  it("keeps the cog at the header's right edge, which the glyph used to share", () => {
    const html = shell();

    expect(html).toContain('data-testid="settings-toggle"');
    // One `ml-auto` sibling, so the cog is still pinned to the window's edge.
    expect(html).toContain("relative ml-auto flex items-center");
  });
});
