/**
 * Where projects survive a reload.
 *
 * A project is two things: metadata a person recognises (name, timestamps, the
 * conversation so far) and its files. Both are stored per project, under one key, so a
 * project is written and deleted atomically — a half-saved project would be worse than
 * a lost one, because the next boot would silently open it.
 *
 * Two implementations, one contract:
 *
 * - `IndexedDbProjectStore` is the product's store: IndexedDB is inside the browser, so
 *   persisting a project never touches a server, which is the whole premise of Larpable.
 * - `MemoryProjectStore` is for tests and for a browser where IndexedDB is unavailable
 *   (private modes have historically refused it). The app degrades to a session-only
 *   workspace rather than failing to boot, and says so in the project panel.
 *
 * File contents are `Uint8Array` in both, because a project contains images, fonts and
 * a `package-lock.json` that should not be re-encoded through a string. IndexedDB stores
 * typed arrays natively via structured clone.
 */

/** One turn of the conversation that belongs to a project. */
export interface ConversationTurn {
  role: "user" | "assistant" | "tool";
  content: string;
  /** Milliseconds since the epoch. */
  at: number;
}

/** What the UI lists: everything except the files. */
export interface ProjectMetadata {
  id: string;
  name: string;
  /** Starter the project was created from, e.g. `vite-react`. */
  template: string;
  createdAt: number;
  updatedAt: number;
  /** Count of files in `files`, kept in metadata so listing never loads a project. */
  fileCount: number;
  /** Turns persisted with the project, newest last. */
  conversation: ConversationTurn[];
}

export interface ProjectRecord {
  metadata: ProjectMetadata;
  /** Workspace-relative path (`src/App.tsx`) to bytes. */
  files: Record<string, Uint8Array>;
}

export interface ProjectStore {
  list(): Promise<ProjectMetadata[]>;
  get(id: string): Promise<ProjectRecord | null>;
  /** Create or replace a project. */
  put(record: ProjectRecord): Promise<void>;
  delete(id: string): Promise<void>;
  /** The project to reopen on the next boot, or null. */
  activeId(): Promise<string | null>;
  setActiveId(id: string | null): Promise<void>;
}

/** Copy a record so a store and its caller cannot share mutable state. */
export function cloneRecord(record: ProjectRecord): ProjectRecord {
  const files: Record<string, Uint8Array> = {};
  for (const [path, bytes] of Object.entries(record.files)) {
    files[path] = bytes.slice();
  }
  return {
    metadata: { ...record.metadata, conversation: record.metadata.conversation.map((turn) => ({ ...turn })) },
    files,
  };
}

/** Newest first: the order the project list is shown in. */
export function byMostRecent(a: ProjectMetadata, b: ProjectMetadata): number {
  return b.updatedAt - a.updatedAt || a.name.localeCompare(b.name);
}

/** A store that keeps projects for the lifetime of the page. */
export class MemoryProjectStore implements ProjectStore {
  readonly #records = new Map<string, ProjectRecord>();
  #active: string | null = null;

  async list(): Promise<ProjectMetadata[]> {
    return [...this.#records.values()].map((record) => cloneRecord(record).metadata).sort(byMostRecent);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const record = this.#records.get(id);
    return record ? cloneRecord(record) : null;
  }

  async put(record: ProjectRecord): Promise<void> {
    this.#records.set(record.metadata.id, cloneRecord(record));
  }

  async delete(id: string): Promise<void> {
    this.#records.delete(id);
    if (this.#active === id) this.#active = null;
  }

  async activeId(): Promise<string | null> {
    return this.#active;
  }

  async setActiveId(id: string | null): Promise<void> {
    this.#active = id;
  }
}

const DB_NAME = "larpable";
const DB_VERSION = 1;
const PROJECTS = "projects";
const SESSION = "session";
const ACTIVE_KEY = "active-project";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error("IndexedDB request failed"));
    };
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error("IndexedDB transaction failed"));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    };
  });
}

/**
 * The browser's project store.
 *
 * Deliberately hand-written rather than a wrapper library: the schema is one object
 * store and one session key, and keeping it here means the persistence format is
 * readable in this repository instead of in a dependency's changelog.
 */
export class IndexedDbProjectStore implements ProjectStore {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  /** True when this browser can persist projects at all. */
  static supported(): boolean {
    return typeof indexedDB !== "undefined";
  }

  static open(factory: IDBFactory = indexedDB): Promise<IndexedDbProjectStore> {
    return new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(PROJECTS)) {
          db.createObjectStore(PROJECTS, { keyPath: "metadata.id" });
        }
        if (!db.objectStoreNames.contains(SESSION)) {
          db.createObjectStore(SESSION);
        }
      };
      req.onsuccess = () => {
        resolve(new IndexedDbProjectStore(req.result));
      };
      req.onerror = () => {
        reject(req.error ?? new Error("could not open the larpable IndexedDB database"));
      };
    });
  }

  close(): void {
    this.#db.close();
  }

  async list(): Promise<ProjectMetadata[]> {
    const tx = this.#db.transaction(PROJECTS, "readonly");
    const records = await request<ProjectRecord[]>(tx.objectStore(PROJECTS).getAll());
    return records.map((record) => cloneRecord(record).metadata).sort(byMostRecent);
  }

  async get(id: string): Promise<ProjectRecord | null> {
    const tx = this.#db.transaction(PROJECTS, "readonly");
    const record = await request<ProjectRecord | undefined>(tx.objectStore(PROJECTS).get(id));
    return record ? cloneRecord(record) : null;
  }

  async put(record: ProjectRecord): Promise<void> {
    const tx = this.#db.transaction(PROJECTS, "readwrite");
    tx.objectStore(PROJECTS).put(cloneRecord(record));
    await transactionDone(tx);
  }

  async delete(id: string): Promise<void> {
    const tx = this.#db.transaction([PROJECTS, SESSION], "readwrite");
    tx.objectStore(PROJECTS).delete(id);
    // Clear the session pointer in the same transaction, so a deleted project can never
    // be the one the next boot tries to reopen.
    const active = await request<unknown>(tx.objectStore(SESSION).get(ACTIVE_KEY));
    if (active === id) tx.objectStore(SESSION).delete(ACTIVE_KEY);
    await transactionDone(tx);
  }

  async activeId(): Promise<string | null> {
    const tx = this.#db.transaction(SESSION, "readonly");
    const value = await request<unknown>(tx.objectStore(SESSION).get(ACTIVE_KEY));
    return typeof value === "string" ? value : null;
  }

  async setActiveId(id: string | null): Promise<void> {
    const tx = this.#db.transaction(SESSION, "readwrite");
    if (id === null) tx.objectStore(SESSION).delete(ACTIVE_KEY);
    else tx.objectStore(SESSION).put(id, ACTIVE_KEY);
    await transactionDone(tx);
  }
}

/**
 * The store the app should use: IndexedDB when the browser has it, memory otherwise.
 * Callers get the same contract either way; `persistent` says which one they got, so
 * the UI can be honest about a session-only workspace.
 */
export async function openProjectStore(): Promise<{ store: ProjectStore; persistent: boolean }> {
  if (IndexedDbProjectStore.supported()) {
    try {
      return { store: await IndexedDbProjectStore.open(), persistent: true };
    } catch {
      // A browser can expose `indexedDB` and still refuse to open (private mode, quota,
      // blocked storage). Booting must not fail because saving cannot.
    }
  }
  return { store: new MemoryProjectStore(), persistent: false };
}
