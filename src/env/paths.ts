/**
 * Path rules for the project workspace.
 *
 * Everything the agent can touch lives under one guest directory (`/workspace` by
 * default). The agent writes paths into files and commands, so the boundary has to be
 * enforced here, in one place, rather than trusted from the caller: a `..` in a
 * generated path must fail loudly instead of reading or writing the host's `/etc`.
 *
 * Both forms are accepted because both appear naturally in agent output: a guest
 * absolute path (`/workspace/src/App.tsx`) and a workspace-relative one
 * (`src/App.tsx`).
 */

import { OutsideWorkspaceError } from "./environment-errors";

/** Split a path into meaningful segments, dropping empty and `.` pieces. */
function segmentsOf(path: string): string[] {
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

/** The workspace root as a normalized guest-absolute path without a trailing slash. */
function rootOf(workspacePath: string): { root: string; segments: string[] } {
  const segments = segmentsOf(workspacePath);
  return { root: `/${segments.join("/")}`, segments };
}

/**
 * Resolve `input` inside `workspacePath`, or throw `OutsideWorkspaceError`.
 *
 * ```ts
 * resolveWorkspacePath("/workspace", "src/App.tsx");         // "/workspace/src/App.tsx"
 * resolveWorkspacePath("/workspace", "/workspace//./a.txt"); // "/workspace/a.txt"
 * resolveWorkspacePath("/workspace", "..");                  // throws
 * resolveWorkspacePath("/workspace", "/etc/passwd");         // throws
 * ```
 */
export function resolveWorkspacePath(workspacePath: string, input: string): string {
  if (input.includes("\0")) throw new OutsideWorkspaceError(input, workspacePath);

  const { root, segments: rootSegments } = rootOf(workspacePath);
  // An absolute path is resolved from `/`, so `/workspace/../etc` really does
  // escape and is rejected; a relative path is resolved from the workspace root.
  const stack: string[] = input.startsWith("/") ? [] : [...rootSegments];

  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) throw new OutsideWorkspaceError(input, workspacePath);
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  // Anything that climbed above (or diverged from) the root is out of bounds.
  if (stack.length < rootSegments.length) throw new OutsideWorkspaceError(input, workspacePath);
  for (let index = 0; index < rootSegments.length; index += 1) {
    if (stack[index] !== rootSegments[index]) {
      throw new OutsideWorkspaceError(input, workspacePath);
    }
  }

  return stack.length === 0 ? "/" : `/${stack.join("/")}`;
}

/** The path relative to the workspace root (`""` for the root itself). */
export function relativeToWorkspace(workspacePath: string, guestPath: string): string {
  const { root } = rootOf(workspacePath);
  if (guestPath === root) return "";
  return guestPath.startsWith(`${root}/`) ? guestPath.slice(root.length + 1) : guestPath;
}

/** Join a guest directory and a child name without inventing separators. */
export function joinGuestPath(directory: string, name: string): string {
  return directory.endsWith("/") ? `${directory}${name}` : `${directory}/${name}`;
}

/**
 * Map a guest path to a path *inside the mounted workspace file system*.
 *
 * The workspace `MemoryFs` is mounted at `/workspace`, so its own root is `/workspace`
 * from the guest's point of view: the guest's `/workspace/package.json` is
 * `/package.json` in the file system. Getting this wrong is invisible on the host side
 * and wrong in the guest (the file appears at `/workspace/workspace/...`), so it is
 * one exported function rather than a subtraction repeated in every adapter.
 */
export function toMountedPath(workspacePath: string, guestPath: string): string {
  const relative = relativeToWorkspace(workspacePath, guestPath);
  return relative === "" ? "/" : `/${relative}`;
}
