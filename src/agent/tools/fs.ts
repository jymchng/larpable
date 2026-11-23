/**
 * Filesystem tools (PRD §9.3, "Filesystem").
 *
 * Every path goes through `resolveWorkspacePath`, so the workspace boundary is enforced
 * once, in the environment, rather than trusted here: `../../etc/passwd` fails loudly and
 * the model gets a message it can act on.
 *
 * The other decision worth naming is *what the model reads back*. A tool result is prompt
 * text, so it is bounded (`clampText`) and structured (line numbers, byte counts, a
 * truncated marker) instead of being a dump. A model that cannot tell a 4 KB file from a
 * 4 MB one will happily try to rewrite the wrong one.
 */

import { resolveWorkspacePath } from "@/env/paths";
import { OutsideWorkspaceError } from "@/env/environment-errors";
import type { FileEntry } from "@/env/execution";
import { clampText, defineTool, failure, success, type AgentTool, type ToolContext } from "./types";

/** Deepest directory walk a single tool call may perform. */
const MAX_WALK_DEPTH = 12;
/** How many entries a listing may report before it is summarised instead. */
const MAX_LIST_ENTRIES = 400;
/** Bytes of a file `read_file` will return without an explicit range. */
const MAX_READ_BYTES = 200_000;
/** How much of a searched file is examined. */
const MAX_SEARCH_BYTES = 2_000_000;

function guestPath(context: ToolContext, path: string): string {
  return resolveWorkspacePath(context.root, path);
}

function relative(context: ToolContext, path: string): string {
  const prefix = `${context.root.replace(/\/+$/, "")}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function messageOf(cause: unknown): string {
  if (cause instanceof OutsideWorkspaceError) {
    return `That path is outside the project workspace (${cause.message}), so it was refused. Paths must resolve inside the workspace.`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

export function isText(bytes: Uint8Array): boolean {
  // A NUL byte in the first 8 KB is the same test `git` uses, and it is right far more
  // often than a MIME guess from an extension the model chose.
  const window = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
  return !window.includes(0);
}

/** What a walk should do with an entry it just saw. */
type VisitResult = "descend" | "skip" | "stop";

/**
 * Walk `directory` depth-first. Returns false when a visitor asked to stop.
 *
 * Pruning is the reason this returns a verdict per entry rather than a boolean: a
 * `node_modules` in a small project is thousands of files, and "do not descend into this
 * directory" must not become "do not visit its siblings".
 */
async function walk(
  context: ToolContext,
  directory: string,
  depth: number,
  visit: (entry: FileEntry) => VisitResult,
): Promise<boolean> {
  if (depth > MAX_WALK_DEPTH) return true;
  const entries = await context.environment.listFiles(directory);
  for (const entry of entries) {
    const verdict = visit(entry);
    if (verdict === "stop") return false;
    if (entry.kind === "directory" && verdict === "descend") {
      const keepGoing = await walk(context, entry.path, depth + 1, visit);
      if (!keepGoing) return false;
    }
  }
  return true;
}

/** The directories a project walk never needs: dependency trees and VCS metadata. */
function isNoise(entry: FileEntry): boolean {
  return entry.name === "node_modules" || entry.name === ".git";
}

export const readFileTool: AgentTool = defineTool(
  {
    name: "read_file",
    description:
      "Read a text file from the project. Returns its content, or the first part of it when " +
      "the file is large. Use list_files first when you do not know the path.",
    readOnly: true,
    parameters: {
      type: "object",
      description: "read_file arguments",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or guest-absolute path, e.g. src/App.tsx",
          minLength: 1,
        },
        maxBytes: {
          type: "integer",
          description: "How much of the file to return, at most. Default 200000.",
          minimum: 1,
          maximum: MAX_READ_BYTES,
        },
      },
      required: ["path"],
    },
  },
  async (args, context) => {
    const path = guestPath(context, String(args.path));
    try {
      const bytes = await context.environment.readFile(path);
      if (!isText(bytes)) {
        return failure(
          `${relative(context, path)} is a binary file (${String(bytes.byteLength)} bytes), so it cannot be read as text.`,
        );
      }
      const limit = typeof args.maxBytes === "number" ? args.maxBytes : MAX_READ_BYTES;
      const text = new TextDecoder().decode(bytes.subarray(0, limit));
      const cut = bytes.byteLength > limit;
      const body = cut
        ? `${text}\n…[${String(bytes.byteLength - limit)} more bytes not shown]…`
        : text;
      return success(clampText(body), {
        path: relative(context, path),
        bytes: bytes.byteLength,
        truncated: cut,
      });
    } catch (cause) {
      return failure(`Could not read ${String(args.path)}: ${messageOf(cause)}`);
    }
  },
);

export const writeFileTool: AgentTool = defineTool(
  {
    name: "write_file",
    description:
      "Create a file or overwrite it completely. Parent directories are created. Use " +
      "edit_file for a targeted change to a file that already exists.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "write_file arguments",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or guest-absolute path, e.g. src/App.tsx",
          minLength: 1,
        },
        content: { type: "string", description: "The complete new contents of the file." },
      },
      required: ["path", "content"],
    },
  },
  async (args, context) => {
    const path = guestPath(context, String(args.path));
    const content = String(args.content);
    try {
      await ensureParent(context, path);
      await context.environment.writeFile(path, content);
      const bytes = new TextEncoder().encode(content).byteLength;
      return success(`Wrote ${relative(context, path)} (${String(bytes)} bytes).`, {
        path: relative(context, path),
        bytes,
      });
    } catch (cause) {
      return failure(`Could not write ${String(args.path)}: ${messageOf(cause)}`);
    }
  },
);

export const editFileTool: AgentTool = defineTool(
  {
    name: "edit_file",
    description:
      "Replace an exact string in a file that already exists. The string must match " +
      "exactly once unless 'all' is true; this is what makes an edit verifiable.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "edit_file arguments",
      properties: {
        path: { type: "string", description: "File to edit.", minLength: 1 },
        find: { type: "string", description: "Exact text to replace.", minLength: 1 },
        replace: { type: "string", description: "Replacement text. May be empty to delete." },
        all: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring exactly one.",
        },
      },
      required: ["path", "find", "replace"],
    },
  },
  async (args, context) => {
    const path = guestPath(context, String(args.path));
    const find = String(args.find);
    const replace = String(args.replace);
    const all = args.all === true;

    try {
      const bytes = await context.environment.readFile(path);
      if (!isText(bytes)) {
        return failure(`${relative(context, path)} is a binary file and cannot be edited as text.`);
      }
      const text = new TextDecoder().decode(bytes);
      const occurrences = text.split(find).length - 1;
      if (occurrences === 0) {
        return failure(
          `Could not find that text in ${relative(context, path)}. Read the file and use an exact string, including whitespace and indentation.`,
        );
      }
      if (occurrences > 1 && !all) {
        return failure(
          `That text occurs ${String(occurrences)} times in ${relative(context, path)}. Use a longer, unique string, or set all=true to replace every occurrence.`,
        );
      }
      const next = all ? text.split(find).join(replace) : text.replace(find, replace);
      await context.environment.writeFile(path, next);
      return success(
        `Edited ${relative(context, path)}: ${String(all ? occurrences : 1)} replacement(s).`,
        { path: relative(context, path), replacements: all ? occurrences : 1 },
      );
    } catch (cause) {
      return failure(`Could not edit ${String(args.path)}: ${messageOf(cause)}`);
    }
  },
);

export const listFilesTool: AgentTool = defineTool(
  {
    name: "list_files",
    description:
      "List a directory in the project. Set recursive to walk the whole subtree (node_modules " +
      "and .git are skipped).",
    readOnly: true,
    parameters: {
      type: "object",
      description: "list_files arguments",
      properties: {
        path: {
          type: "string",
          description: "Directory to list; the project root when empty.",
          minLength: 0,
        },
        recursive: { type: "boolean", description: "Walk subdirectories too." },
      },
      required: [],
    },
  },
  async (args, context) => {
    const path = guestPath(context, typeof args.path === "string" ? args.path : ".");
    try {
      const lines: string[] = [];
      let count = 0;
      let cut = false;

      if (args.recursive === true) {
        await walk(context, path, 0, (entry) => {
          if (isNoise(entry)) return "skip";
          if (count >= MAX_LIST_ENTRIES) {
            cut = true;
            return "stop";
          }
          count += 1;
          const suffix = entry.kind === "directory" ? "/" : "";
          lines.push(
            `${relative(context, entry.path)}${suffix}${
              entry.kind === "file" ? ` (${String(entry.size)} bytes)` : ""
            }`,
          );
          return "descend";
        });
      } else {
        for (const entry of await context.environment.listFiles(path)) {
          if (count >= MAX_LIST_ENTRIES) {
            cut = true;
            break;
          }
          count += 1;
          const suffix = entry.kind === "directory" ? "/" : "";
          lines.push(
            `${entry.name}${suffix}${entry.kind === "file" ? ` (${String(entry.size)} bytes)` : ""}`,
          );
        }
      }

      if (lines.length === 0) return success(`${relative(context, path)} is empty.`);
      const body = `${lines.join("\n")}${cut ? `\n…[more than ${String(MAX_LIST_ENTRIES)} entries not shown]…` : ""}`;
      return success(clampText(body), {
        path: relative(context, path),
        entries: count,
        truncated: cut,
      });
    } catch (cause) {
      return failure(`Could not list ${String(args.path)}: ${messageOf(cause)}`);
    }
  },
);

export const searchFilesTool: AgentTool = defineTool(
  {
    name: "search_files",
    description:
      "Search the project's text files for a string or regular expression. Returns " +
      "path:line matches. Use this instead of reading files one by one to find a symbol.",
    readOnly: true,
    parameters: {
      type: "object",
      description: "search_files arguments",
      properties: {
        query: { type: "string", description: "Text or JavaScript regular expression.", minLength: 1 },
        path: { type: "string", description: "Directory to search from. Default the project root." },
        fixedString: {
          type: "boolean",
          description: "Treat the query as literal text instead of a regular expression.",
        },
        maxResults: {
          type: "integer",
          description: "Stop after this many matches. Default 100.",
          minimum: 1,
          maximum: 500,
        },
      },
      required: ["query"],
    },
  },
  async (args, context) => {
    const root = guestPath(context, typeof args.path === "string" ? args.path : ".");
    const query = String(args.query);
    const limit = typeof args.maxResults === "number" ? args.maxResults : 100;

    let matcher: RegExp;
    try {
      matcher =
        args.fixedString === true
          ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          : new RegExp(query);
    } catch (cause) {
      return failure(`That is not a valid regular expression: ${messageOf(cause)}`);
    }

    const matches: string[] = [];
    let stopped = false;
    let scanned = 0;

    try {
      // The walk only *collects* candidate paths; reading happens below so a large tree
      // does not hold every file's content in memory at once.
      const files: string[] = [];
      await walk(context, root, 0, (entry) => {
        if (isNoise(entry)) return "skip";
        if (entry.kind === "file" && entry.size <= MAX_SEARCH_BYTES) files.push(entry.path);
        return "descend";
      });
      scanned = files.length;

      for (const file of files) {
        if (stopped) break;
        const bytes = await context.environment.readFile(file);
        if (!isText(bytes)) continue;
        const lines = new TextDecoder().decode(bytes).split("\n");
        for (const [index, line] of lines.entries()) {
          if (!matcher.test(line)) continue;
          matches.push(`${relative(context, file)}:${String(index + 1)}: ${line.trim().slice(0, 300)}`);
          if (matches.length >= limit) {
            stopped = true;
            break;
          }
        }
      }
    } catch (cause) {
      return failure(`Could not search: ${messageOf(cause)}`);
    }

    if (matches.length === 0) {
      return success(`No matches for ${JSON.stringify(query)} in ${String(scanned)} file(s).`, {
        matches: 0,
        scanned,
      });
    }
    return success(clampText(`${matches.join("\n")}${stopped ? "\n…[result limit reached]…" : ""}`), {
      matches: matches.length,
      scanned,
      truncated: stopped,
    });
  },
);

export const deleteFileTool: AgentTool = defineTool(
  {
    name: "delete_file",
    description: "Delete a file from the project. Directories are not removed.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "delete_file arguments",
      properties: {
        path: { type: "string", description: "File to delete.", minLength: 1 },
      },
      required: ["path"],
    },
  },
  async (args, context) => {
    const path = guestPath(context, String(args.path));
    try {
      await context.environment.removeFile(path);
      return success(`Deleted ${relative(context, path)}.`, { path: relative(context, path) });
    } catch (cause) {
      return failure(`Could not delete ${String(args.path)}: ${messageOf(cause)}`);
    }
  },
);

export const createDirectoryTool: AgentTool = defineTool(
  {
    name: "create_directory",
    description: "Create a directory (and any missing parents) in the project.",
    readOnly: false,
    parameters: {
      type: "object",
      description: "create_directory arguments",
      properties: {
        path: { type: "string", description: "Directory to create.", minLength: 1 },
      },
      required: ["path"],
    },
  },
  async (args, context) => {
    const path = guestPath(context, String(args.path));
    try {
      await context.environment.createDirectory(path);
      return success(`Created ${relative(context, path)}.`, { path: relative(context, path) });
    } catch (cause) {
      return failure(`Could not create ${String(args.path)}: ${messageOf(cause)}`);
    }
  },
);

/** Create the parent directory of `path`, tolerating one that already exists. */
async function ensureParent(context: ToolContext, path: string): Promise<void> {
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (parent.length === 0 || parent === context.root.replace(/\/+$/, "")) return;
  try {
    await context.environment.createDirectory(parent);
  } catch {
    // An existing directory is not a failure; the write below is the real check.
  }
}

export const FILESYSTEM_TOOLS: readonly AgentTool[] = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  searchFilesTool,
  deleteFileTool,
  createDirectoryTool,
];
