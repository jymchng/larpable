/**
 * The host side of the mounted workspace: one object that both people and the agent
 * write through, with a single set of path rules and a single stream of change events.
 *
 * Why a bridge at all, when `ExecutionEnvironment` already reads and writes files: the
 * environment answers "what is in Linux", but three things are missing for an editor:
 *
 * - **One boundary.** Every path goes through `resolveWorkspacePath()`, so a generated
 *   `../../etc/passwd` fails here rather than somewhere deeper.
 * - **Change notifications.** The 9p mount is shared memory, so the guest and the host
 *   see the same files — but nothing tells the host *when* the guest edited one. This
 *   class keeps an index and reports the difference on `scan()`, which is what polls a
 *   build's output, an `npm install`'s lockfile or an agent's edits.
 * - **Whole-tree operations.** Saving a project, switching a project and diffing a
 *   build need "all files", not "one file at a time".
 *
 * Scanning deliberately reads file contents to hash them instead of trusting size and
 * timestamps: unkernel's file system has no mtimes, and an edit that keeps the same
 * length (a typo fix, a version bump) is exactly the edit a size-only diff would miss.
 * Paths under `node_modules/`, `dist/` and friends are skipped, because watching an
 * install is neither useful nor cheap; the list is configurable for a project whose
 * build output lives somewhere else.
 */

import type { ExecutionEnvironment, FileEntry, FileKind } from "./execution";
import { joinGuestPath, relativeToWorkspace, resolveWorkspacePath } from "./paths";
import { OutsideWorkspaceError } from "./environment-errors";

/** Who made a change: a host caller (bridge write) or the guest (found by a scan). */
export type ChangeOrigin = "host" | "guest";

export type ChangeKind = "write" | "delete" | "mkdir";

export interface WorkspaceChange {
  kind: ChangeKind;
  /** Workspace-relative path; `""` is the workspace root itself. */
  path: string;
  origin: ChangeOrigin;
  /** Injectable clock, so tests get deterministic timestamps. */
  at: number;
}

export interface WorkspaceEntryInfo {
  /** Workspace-relative path. */
  path: string;
  kind: FileKind;
  /** Bytes for files, 0 for directories and links. */
  size: number;
}

export interface WorkspaceBridgeOptions {
  /**
   * Directory names that are never walked. Defaults cover the four directories that
   * dominate a Node project and say nothing about the source:
   * `node_modules`, `dist`, `.git`, `.cache`, `.larpable`.
   */
  ignore?: readonly string[];
  /** Refuse to walk more files than this. Default 5000. */
  maxEntries?: number;
  /** Injectable clock for change timestamps. */
  now?: () => number;
}

/**
 * Above this size a file is compared by length only. Hashing a 50 MB bundle on every
 * poll would make the watcher the slowest part of the app, and a same-size edit to a
 * generated bundle is not a case worth covering.
 */
const MAX_HASHED_BYTES = 2 * 1024 * 1024;

const DEFAULT_IGNORE = ["node_modules", "dist", ".git", ".cache", ".larpable"] as const;

interface IndexEntry {
  kind: FileKind;
  size: number;
  /** FNV-1a of the contents, or null for a file too large to hash. */
  hash: number | null;
}

/** FNV-1a (32-bit). Fast, dependency-free and good enough to notice an edit. */
function hashBytes(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < bytes.length; index += 1) {
    hash ^= bytes[index] as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function depthOf(path: string): number {
  return path === "" ? 0 : path.split("/").length;
}

/** A file system the host and Linux share, with path rules and change events. */
export class WorkspaceBridge {
  readonly #environment: ExecutionEnvironment;
  readonly #ignored: ReadonlySet<string>;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #listeners = new Set<(change: WorkspaceChange) => void>();
  #index = new Map<string, IndexEntry>();

  constructor(environment: ExecutionEnvironment, options: WorkspaceBridgeOptions = {}) {
    this.#environment = environment;
    this.#ignored = new Set(options.ignore ?? DEFAULT_IGNORE);
    this.#maxEntries = options.maxEntries ?? 5_000;
    this.#now = options.now ?? Date.now;
  }

  /** Guest-absolute workspace root, e.g. `/workspace`. */
  get workspacePath(): string {
    return this.#environment.workspacePath;
  }

  /**
   * Resolve `path` to a workspace-relative path, or throw `OutsideWorkspaceError`.
   * Everything below goes through this, so no caller can bypass the boundary.
   */
  resolve(path: string): string {
    return relativeToWorkspace(
      this.#environment.workspacePath,
      resolveWorkspacePath(this.#environment.workspacePath, path),
    );
  }

  guestPathOf(path: string): string {
    const relative = this.resolve(path);
    return relative === "" ? this.#environment.workspacePath : joinGuestPath(this.#environment.workspacePath, relative);
  }

  async read(path: string): Promise<Uint8Array> {
    return this.#environment.readFile(this.guestPathOf(path));
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.read(path));
  }

  async exists(path: string): Promise<boolean> {
    const relative = this.resolve(path);
    if (relative === "") return true;
    const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
    const name = relative.includes("/") ? relative.slice(relative.lastIndexOf("/") + 1) : relative;
    try {
      const entries = await this.#environment.listFiles(
        parent === "" ? this.#environment.workspacePath : joinGuestPath(this.#environment.workspacePath, parent),
      );
      return entries.some((entry) => entry.name === name);
    } catch {
      return false;
    }
  }

  /** Write a file and report it. Parent directories are created for you. */
  async write(path: string, content: Uint8Array | string, origin: ChangeOrigin = "host"): Promise<void> {
    const relative = this.#requirePath(path);
    await this.#environment.writeFile(this.guestPathOf(relative), content);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.#index.set(relative, {
      kind: "file",
      size: bytes.byteLength,
      hash: bytes.byteLength <= MAX_HASHED_BYTES ? hashBytes(bytes) : null,
    });
    this.#emit({ kind: "write", path: relative, origin });
  }

  async mkdir(path: string): Promise<void> {
    const relative = this.#requirePath(path);
    await this.#environment.createDirectory(this.guestPathOf(relative));
    this.#index.set(relative, { kind: "directory", size: 0, hash: null });
    this.#emit({ kind: "mkdir", path: relative, origin: "host" });
  }

  /** Remove a file or an empty directory. */
  async remove(path: string): Promise<void> {
    const relative = this.#requirePath(path);
    await this.#environment.removeFile(this.guestPathOf(relative));
    this.#index.delete(relative);
    this.#emit({ kind: "delete", path: relative, origin: "host" });
  }

  async list(path = ""): Promise<WorkspaceEntryInfo[]> {
    const relative = this.resolve(path);
    const entries = await this.#environment.listFiles(
      relative === "" ? this.#environment.workspacePath : joinGuestPath(this.#environment.workspacePath, relative),
    );
    return entries.map((entry) => ({
      path: relative === "" ? entry.name : `${relative}/${entry.name}`,
      kind: entry.kind,
      size: entry.size,
    }));
  }

  /**
   * Every file and directory under `path`, depth-first, sorted by path. Ignored
   * directories are skipped entirely; directories still appear as entries.
   */
  async walk(path = "", options: { ignore?: boolean } = {}): Promise<WorkspaceEntryInfo[]> {
    const useIgnore = options.ignore ?? true;
    const collected: WorkspaceEntryInfo[] = [];
    const queue: string[] = [this.resolve(path)];

    while (queue.length > 0) {
      const current = queue.shift() as string;
      let entries: WorkspaceEntryInfo[];
      try {
        entries = await this.list(current);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const name = entry.path.includes("/") ? entry.path.slice(entry.path.lastIndexOf("/") + 1) : entry.path;
        const ignored = useIgnore && entry.kind === "directory" && this.#ignored.has(name);
        if (ignored) continue;

        collected.push(entry);
        if (entry.kind === "directory") queue.push(entry.path);
        if (collected.length > this.#maxEntries) {
          throw new Error(
            `workspace has more than ${String(this.#maxEntries)} entries; add the extra directories to \`ignore\``,
          );
        }
      }
    }

    return collected.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Every file under `path`, keyed by workspace-relative path. */
  async tree(path = ""): Promise<Record<string, Uint8Array>> {
    const files = (await this.walk(path)).filter((entry) => entry.kind === "file");
    const tree: Record<string, Uint8Array> = {};
    for (const file of files) {
      tree[file.path] = await this.read(file.path);
    }
    return tree;
  }

  /** Delete everything under `path`, deepest first, so directories are empty when removed. */
  async clear(path = ""): Promise<void> {
    const entries = await this.walk(path, { ignore: false });
    const deepestFirst = [...entries].sort((a, b) => depthOf(b.path) - depthOf(a.path));
    for (const entry of deepestFirst) {
      await this.#environment.removeFile(this.guestPathOf(entry.path)).catch(() => undefined);
      this.#index.delete(entry.path);
    }
    this.#emit({ kind: "delete", path: this.resolve(path), origin: "host" });
  }

  /**
   * Compare the workspace with the last known index and report what the guest changed.
   * Host writes through this bridge update the index immediately, so they are never
   * reported twice as guest edits.
   */
  async scan(): Promise<WorkspaceChange[]> {
    const files = (await this.walk("")).filter((entry) => entry.kind === "file");
    const seen = new Set<string>();
    const changes: WorkspaceChange[] = [];

    for (const file of files) {
      seen.add(file.path);
      const previous = this.#index.get(file.path);
      const bytes = file.size <= MAX_HASHED_BYTES ? await this.read(file.path) : null;
      const hash = bytes ? hashBytes(bytes) : null;

      const unchanged =
        previous !== undefined &&
        previous.kind === "file" &&
        previous.size === file.size &&
        previous.hash === hash;
      if (unchanged) continue;

      this.#index.set(file.path, { kind: "file", size: file.size, hash });
      changes.push({ kind: "write", path: file.path, origin: "guest", at: this.#now() });
    }

    for (const path of [...this.#index.keys()]) {
      if (seen.has(path)) continue;
      this.#index.delete(path);
      changes.push({ kind: "delete", path, origin: "guest", at: this.#now() });
    }

    changes.sort((a, b) => a.path.localeCompare(b.path));
    for (const change of changes) this.#emit(change);
    return changes;
  }

  /** Forget what the index knows, e.g. after the tree was replaced out of band. */
  forget(): void {
    this.#index = new Map();
  }

  onChange(listener: (change: WorkspaceChange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #requirePath(path: string): string {
    const relative = this.resolve(path);
    if (relative === "") {
      throw new OutsideWorkspaceError(path, this.#environment.workspacePath);
    }
    return relative;
  }

  #emit(change: Omit<WorkspaceChange, "at">): void {
    const event: WorkspaceChange = { ...change, at: this.#now() };
    for (const listener of [...this.#listeners]) listener(event);
  }
}
