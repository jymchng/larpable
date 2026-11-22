/**
 * Projects: create, open, rename, delete, and keep the open one saved.
 *
 * A project owns two things — its files and its conversation — and this class is the
 * only place that moves them between the durable store and the live workspace. The
 * workspace itself is one directory (`/workspace`), because unkernel mounts one host
 * directory over 9p; opening a project therefore *replaces* the workspace contents with
 * that project's files. That is what makes project switching honest: what the agent
 * sees in Linux is exactly the project the person selected, never a merge of two.
 *
 * Saving is not a button:
 *
 * - A host write through the bridge marks the project dirty and saves after a short
 *   debounce, so a burst of agent writes costs one IndexedDB transaction.
 * - The guest writes to the same memory, so a poll compares the workspace with the last
 *   saved index (`WorkspaceBridge.scan()`) and marks the project dirty when Linux
 *   changed something. Nothing is saved that did not change.
 * - A save is all-or-nothing per record, so a half-written project can never be reopened.
 *
 * Every operation that touches the file system goes through `WorkspaceBridge`, which is
 * where the workspace boundary is enforced. A project created with a path outside
 * `/workspace` fails here rather than writing somewhere it should not.
 */

import type { WorkspaceBridge, WorkspaceChange } from "../env/fs-bridge";
import { DEFAULT_PROJECT_TREE } from "../env/default-project";
import type { ConversationTurn, ProjectMetadata, ProjectRecord, ProjectStore } from "./store";
import { byMostRecent } from "./store";

/** What the panel renders. Always derived from the store and the workspace. */
export interface ProjectState {
  active: ProjectMetadata | null;
  projects: ProjectMetadata[];
  /** True while a save is in flight. */
  saving: boolean;
  /** True when the workspace has changed since the last save. */
  dirty: boolean;
  /** When the last successful save finished, or null. */
  lastSavedAt: number | null;
  /** Last persistence failure, shown instead of pretending the save worked. */
  error: string | null;
}

export const EMPTY_PROJECT_STATE: ProjectState = {
  active: null,
  projects: [],
  saving: false,
  dirty: false,
  lastSavedAt: null,
  error: null,
};

export interface ProjectManagerOptions {
  bridge: WorkspaceBridge;
  store: ProjectStore;
  /** Files a new project starts from. Default: the starter Vite site. */
  starter?: Readonly<Record<string, string>>;
  /** Template name recorded in metadata. Default `vite`. */
  template?: string;
  now?: () => number;
  /** Id factory; tests pin it so ids are readable. */
  newId?: () => string;
  /** Debounce for autosave. Default 400 ms; 0 saves immediately. */
  autosaveMs?: number;
  /** How often to look for guest-side changes. Default 1500 ms; 0 disables polling. */
  pollMs?: number;
}

const MAX_NAME_LENGTH = 60;

/** Trim and validate a project name; the name is shown, not used as a path. */
export function normaliseProjectName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("A project needs a name.");
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new Error(`A project name can be at most ${String(MAX_NAME_LENGTH)} characters.`);
  }
  if (/[/\\\0]/.test(trimmed)) throw new Error("A project name cannot contain a slash.");
  return trimmed;
}

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
}

export class ProjectManager {
  readonly #bridge: WorkspaceBridge;
  readonly #store: ProjectStore;
  readonly #starter: Readonly<Record<string, string>>;
  readonly #template: string;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #autosaveMs: number;
  readonly #pollMs: number;

  readonly #listeners = new Set<(state: ProjectState) => void>();
  #state: ProjectState = EMPTY_PROJECT_STATE;
  #unsubscribeBridge: (() => void) | null = null;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #active: ProjectMetadata | null = null;
  /** True while this class is replacing the workspace itself; those writes are not edits. */
  #applying = false;

  constructor(options: ProjectManagerOptions) {
    this.#bridge = options.bridge;
    this.#store = options.store;
    this.#starter = options.starter ?? DEFAULT_PROJECT_TREE;
    this.#template = options.template ?? "vite";
    this.#now = options.now ?? Date.now;
    this.#newId =
      options.newId ??
      (() => `p-${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    this.#autosaveMs = options.autosaveMs ?? 400;
    this.#pollMs = options.pollMs ?? 1_500;
  }

  state(): ProjectState {
    return this.#state;
  }

  onState(listener: (state: ProjectState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Begin tracking: restore the session, then watch for edits from both sides. */
  async start(): Promise<void> {
    await this.restore();
    this.#unsubscribeBridge ??= this.#bridge.onChange((change) => {
      this.#onBridgeChange(change);
    });
    if (this.#pollMs > 0 && this.#pollTimer === null) {
      this.#pollTimer = setInterval(() => {
        void this.syncFromGuest();
      }, this.#pollMs);
    }
  }

  stop(): void {
    this.#unsubscribeBridge?.();
    this.#unsubscribeBridge = null;
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
  }

  async list(): Promise<ProjectMetadata[]> {
    return this.#store.list();
  }

  activeProject(): ProjectMetadata | null {
    return this.#active;
  }

  /**
   * Create a project from the starter (or explicit `files`), make it the open project,
   * and persist it. The workspace is replaced, so the new project starts clean.
   */
  async create(
    name: string,
    options: { template?: string; files?: Readonly<Record<string, string | Uint8Array>> } = {},
  ): Promise<ProjectMetadata> {
    const clean = normaliseProjectName(name);
    const files = options.files ?? this.#starter;
    const at = this.#now();
    const metadata: ProjectMetadata = {
      id: this.#newId(),
      name: clean,
      template: options.template ?? this.#template,
      createdAt: at,
      updatedAt: at,
      fileCount: Object.keys(files).length,
      conversation: [],
    };

    await this.#apply(files);
    await this.#store.put({ metadata, files: mapFiles(files) });
    await this.#store.setActiveId(metadata.id);
    this.#active = metadata;
    await this.#refresh({ lastSavedAt: at, dirty: false, error: null });
    return metadata;
  }

  /** Open a project: the workspace becomes exactly this project's files. */
  async open(id: string): Promise<ProjectMetadata> {
    const record = await this.#store.get(id);
    if (!record) throw new Error(`Project ${id} is not saved in this browser.`);

    await this.#apply(record.files);
    await this.#store.setActiveId(record.metadata.id);
    this.#active = record.metadata;
    await this.#refresh({ dirty: false, error: null });
    return record.metadata;
  }

  async rename(id: string, name: string): Promise<ProjectMetadata> {
    const clean = normaliseProjectName(name);
    const record = await this.#store.get(id);
    if (!record) throw new Error(`Project ${id} is not saved in this browser.`);

    const metadata: ProjectMetadata = { ...record.metadata, name: clean, updatedAt: this.#now() };
    await this.#store.put({ metadata, files: record.files });
    if (this.#active?.id === id) this.#active = metadata;
    await this.#refresh();
    return metadata;
  }

  async remove(id: string): Promise<void> {
    await this.#store.delete(id);
    if (this.#active?.id === id) this.#active = null;
    await this.#refresh();
  }

  /** Write the open project's workspace and conversation to the store. */
  async save(): Promise<ProjectMetadata | null> {
    if (!this.#active) return null;
    const metadata = this.#active;
    this.#state = { ...this.#state, saving: true, error: null };
    this.#emit();

    try {
      const files = await this.#bridge.tree();
      const updated: ProjectMetadata = {
        ...metadata,
        updatedAt: this.#now(),
        fileCount: Object.keys(files).length,
      };
      await this.#store.put({ metadata: updated, files });
      await this.#store.setActiveId(updated.id);
      this.#active = updated;
      await this.#refresh({ saving: false, dirty: false, lastSavedAt: updated.updatedAt });
      return updated;
    } catch (error) {
      // A failed save must be visible: the panel says so, and the project stays dirty so
      // the next edit (or the next poll) tries again.
      this.#state = {
        ...this.#state,
        saving: false,
        dirty: true,
        error: error instanceof Error ? error.message : String(error),
      };
      this.#emit();
      return null;
    }
  }

  /** Append a conversation turn to the open project and persist it immediately. */
  async appendTurn(turn: ConversationTurn): Promise<void> {
    if (!this.#active) throw new Error("No project is open.");
    const conversation = [...this.#active.conversation, turn];
    await this.#putConversation(conversation);
  }

  async setConversation(conversation: readonly ConversationTurn[]): Promise<void> {
    if (!this.#active) throw new Error("No project is open.");
    await this.#putConversation([...conversation]);
  }

  /**
   * Reopen the last session: the active project, else the most recent one, else adopt
   * whatever is already in the workspace (the starter the guest booted with) as the
   * first project. Adoption means a person's first visit never shows "no project" beside
   * files they can see in Linux.
   */
  async restore(): Promise<ProjectMetadata | null> {
    const activeId = await this.#store.activeId();
    if (activeId) {
      const record = await this.#store.get(activeId);
      if (record) return this.open(activeId);
    }

    const projects = await this.#store.list();
    const newest = projects[0];
    if (newest) return this.open(newest.id);

    const files = await this.#bridge.tree();
    const existing = Object.keys(files).length > 0 ? files : mapFiles(this.#starter);
    const at = this.#now();
    const metadata: ProjectMetadata = {
      id: this.#newId(),
      name: "my-site",
      template: this.#template,
      createdAt: at,
      updatedAt: at,
      fileCount: Object.keys(existing).length,
      conversation: [],
    };

    if (Object.keys(files).length === 0) await this.#apply(this.#starter);
    await this.#store.put({ metadata, files: existing });
    await this.#store.setActiveId(metadata.id);
    this.#active = metadata;
    await this.#refresh({ lastSavedAt: at, dirty: false });
    return metadata;
  }

  /** Look for edits made in Linux and save them. Safe to call at any time. */
  async syncFromGuest(): Promise<WorkspaceChange[]> {
    if (!this.#active || this.#applying || this.#state.saving) return [];
    const changes = await this.#bridge.scan();
    if (changes.length > 0) this.#scheduleSave();
    return changes;
  }

  async #putConversation(conversation: ConversationTurn[]): Promise<void> {
    const active = this.#active as ProjectMetadata;
    const record = await this.#store.get(active.id);
    if (!record) throw new Error(`Project ${active.id} is not saved in this browser.`);

    const metadata: ProjectMetadata = { ...record.metadata, conversation, updatedAt: this.#now() };
    await this.#store.put({ metadata, files: record.files });
    this.#active = metadata;
    await this.#refresh();
  }

  #onBridgeChange(change: WorkspaceChange): void {
    // Writes this class makes while applying a project are not edits by anyone.
    if (this.#applying || !this.#active) return;
    if (change.path === "" && change.kind === "delete") return;
    this.#scheduleSave();
  }

  #scheduleSave(): void {
    if (!this.#active) return;
    this.#state = { ...this.#state, dirty: true };
    this.#emit();
    if (this.#saveTimer !== null) clearTimeout(this.#saveTimer);
    if (this.#autosaveMs <= 0) {
      void this.save();
      return;
    }
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = null;
      void this.save();
    }, this.#autosaveMs);
  }

  /** Replace the workspace with `files`, without treating the writes as edits. */
  async #apply(files: Readonly<Record<string, string | Uint8Array>>): Promise<void> {
    this.#applying = true;
    try {
      await this.#bridge.clear();
      for (const [path, content] of Object.entries(files)) {
        await this.#bridge.write(path, toBytes(content));
      }
      this.#bridge.forget();
    } finally {
      this.#applying = false;
    }
  }

  async #refresh(overrides: Partial<ProjectState> = {}): Promise<void> {
    const projects = (await this.#store.list()).sort(byMostRecent);
    this.#active = projects.find((project) => project.id === this.#active?.id) ?? this.#active;
    this.#state = {
      ...this.#state,
      active: this.#active,
      projects,
      ...overrides,
    };
    this.#emit();
  }

  #emit(): void {
    const state = this.#state;
    for (const listener of [...this.#listeners]) listener(state);
  }
}

function mapFiles(files: Readonly<Record<string, string | Uint8Array>>): Record<string, Uint8Array> {
  const mapped: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) mapped[path] = toBytes(content);
  return mapped;
}

export type { ProjectRecord };
