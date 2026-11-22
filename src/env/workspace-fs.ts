/**
 * The workspace file system, as the environment adapter needs it.
 *
 * In the browser this is unkernel's `MemoryFs` — it is mounted into the guest over
 * 9p, so the host and Linux see the same files with no copying. Tests and the mock
 * agent use `MemoryWorkspace` below, which behaves the same way for the handful of
 * calls in this interface.
 *
 * The interface is deliberately narrow and structural: `MemoryFs` satisfies it, so
 * the adapter does not need a wrapper, and a test does not need a kernel to exercise
 * the file operations.
 */

import { FileNotFoundError } from "./environment-errors";

/** Directory entry type, in the vocabulary of unkernel's `FsFileType`. */
export type WorkspaceEntryType = "file" | "dir" | "symlink";

export interface WorkspaceEntry {
  name: string;
  type: WorkspaceEntryType;
}

export interface WorkspaceStat {
  type: WorkspaceEntryType;
  size?: number;
}

export interface WorkspaceFs {
  writeFile(path: string, content: string | Uint8Array): void;
  readFile(path: string): Uint8Array;
  /** Create a directory and its parents; no error when it already exists. */
  mkdirp(path: string): void;
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  readdir(path: string): WorkspaceEntry[];
  stat(path: string): WorkspaceStat | undefined;
}

interface MemoryNode {
  type: WorkspaceEntryType;
  bytes: Uint8Array;
}

function normalize(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  return `/${parts.join("/")}`;
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/**
 * An in-memory `WorkspaceFs`. Deterministic, synchronous and dependency-free, so the
 * adapter's file operations are testable without booting Linux — and a failing test
 * can never be blamed on a VM.
 */
export class MemoryWorkspace implements WorkspaceFs {
  readonly #nodes = new Map<string, MemoryNode>();

  constructor(tree: Record<string, string | Uint8Array> = {}) {
    this.#nodes.set("/", { type: "dir", bytes: new Uint8Array() });
    for (const [path, content] of Object.entries(tree)) {
      this.writeFile(path, content);
    }
  }

  writeFile(path: string, content: string | Uint8Array): void {
    const target = normalize(path);
    if (target === "/") throw new FileNotFoundError(path);
    this.#ensureParents(target);
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content.slice();
    this.#nodes.set(target, { type: "file", bytes });
  }

  readFile(path: string): Uint8Array {
    const target = normalize(path);
    const node = this.#nodes.get(target);
    if (!node) throw new FileNotFoundError(target);
    if (node.type === "dir") throw new FileNotFoundError(`${target} is a directory`);
    return node.bytes.slice();
  }

  mkdirp(path: string): void {
    const target = normalize(path);
    if (this.#nodes.has(target)) return;
    this.#ensureParents(target);
    this.#nodes.set(target, { type: "dir", bytes: new Uint8Array() });
  }

  rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): void {
    const target = normalize(path);
    if (target === "/") return;

    const node = this.#nodes.get(target);
    if (!node) {
      if (opts.force) return;
      throw new FileNotFoundError(target);
    }

    const children = [...this.#nodes.keys()].filter((key) => key.startsWith(`${target}/`));
    if (children.length > 0 && node.type === "dir" && !opts.recursive) {
      throw new FileNotFoundError(`${target} is not empty`);
    }

    for (const key of children) this.#nodes.delete(key);
    this.#nodes.delete(target);
  }

  readdir(path: string): WorkspaceEntry[] {
    const target = normalize(path);
    const node = this.#nodes.get(target);
    if (!node) throw new FileNotFoundError(target);
    if (node.type !== "dir") throw new FileNotFoundError(`${target} is not a directory`);

    const prefix = target === "/" ? "/" : `${target}/`;
    const entries: WorkspaceEntry[] = [];
    for (const [key, value] of this.#nodes) {
      if (key === target || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes("/")) continue;
      entries.push({ name: rest, type: value.type });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }

  stat(path: string): WorkspaceStat | undefined {
    const node = this.#nodes.get(normalize(path));
    return node ? { type: node.type, size: node.bytes.byteLength } : undefined;
  }

  /** Test helper: every path currently in the tree, sorted. */
  paths(): string[] {
    return [...this.#nodes.keys()].sort();
  }

  #ensureParents(path: string): void {
    const parent = parentOf(path);
    if (parent === "/" || this.#nodes.has(parent)) return;
    this.#ensureParents(parent);
    this.#nodes.set(parent, { type: "dir", bytes: new Uint8Array() });
  }
}
