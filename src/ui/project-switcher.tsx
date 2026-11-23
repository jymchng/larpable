/**
 * The project list: what is open, what else exists, and the four things you can do to it.
 *
 * Before this, the app had a `ProjectManager` that nothing called and a status bar whose
 * `project` segment was hard-coded to `{ name: null }` — so the app could create, open, rename
 * and delete projects in a test and a person could not do any of it. This is the missing half:
 * a body for a popover (the surface, its position, Escape and focus belong to `Popover` and to
 * `Dashboard`), listing the store's metadata and offering exactly the operations the manager
 * exposes.
 *
 * Why a list here rather than a project bar across the window: the workspace is one directory
 * that a project *replaces*, so switching is a serious action and hiding it behind a glyph is
 * honest — a person switches projects about as often as they change provider, and neither is
 * worth a permanent band of chrome. The active project's name still shows in the header as a
 * badge, because "which site am I editing" is a fact worth a glance, and in the status facts,
 * because the popover may be closed.
 *
 * What it refuses to pretend:
 *
 * - A browser without IndexedDB keeps projects only for the page's lifetime, so the panel says
 *   so in words rather than showing a list that quietly disappears on reload.
 * - With no machine there is no `/workspace`, so the panel says that too, instead of rendering
 *   an empty list that reads as "you have no projects".
 * - A save in flight, unsaved changes, a last-saved time and an action failure are all printed.
 *   A project that failed to save must never look saved.
 */

import { useState, type ReactNode } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";

import type { ProjectMetadata } from "@/projects/store";
import type { ProjectState } from "@/projects/manager";
import { Button } from "@/ui/components/button";
import { IconButton } from "@/ui/components/icon-button";
import { Input } from "@/ui/components/input";
import { cn } from "@/lib/utils";

export interface ProjectSwitcherProps {
  /** The manager's own state: the active project, the list, and whether a save is pending. */
  state: ProjectState;
  /** False when the store is the in-memory one, so the panel can say "this page only". */
  persistent?: boolean;
  /** Why projects cannot be managed (no machine), or null. */
  unavailable?: string | null;
  /** True while an action is running, so the controls can be disabled rather than double-fired. */
  busy?: boolean;
  /** The last action's failure text. */
  error?: string | null;
  /** Called with a trimmed, non-empty name. */
  onCreate: (name: string) => void;
  onOpen: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  /** Injected in tests so "saved 2 minutes ago" is a fixed sentence, not a moving target. */
  now?: () => number;
}

/**
 * One line saying what just happened to the open project, or why nothing is open.
 *
 * Extracted because it is the only prose in this panel with a rule: a save that is running beats
 * a dirty flag (the flag is what *caused* the save), and a project that has never been saved must
 * not claim a time. Exported so a test can pin the wording without a DOM.
 */
export function describeProjectStatus(state: ProjectState, now: number = Date.now()): string {
  if (state.saving) return "Saving…";
  if (state.dirty) return "Unsaved changes";
  if (state.active === null) return "No project is open";
  if (state.lastSavedAt === null) return "Not saved yet";
  return `Saved ${relativeTime(state.lastSavedAt, now)}`;
}

/** "just now" / "3 minutes ago" / "2 hours ago". Short on purpose: the panel is narrow. */
export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${String(seconds)} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${String(days)} days ago`;
}

export function ProjectSwitcher({
  state,
  persistent = true,
  unavailable = null,
  busy = false,
  error = null,
  onCreate,
  onOpen,
  onRename,
  onRemove,
  now = Date.now,
}: ProjectSwitcherProps): ReactNode {
  const [draftName, setDraftName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);

  const disabled = busy || unavailable !== null;

  function submitCreate(): void {
    const name = draftName.trim();
    if (name === "") return;
    onCreate(name);
    setDraftName("");
  }

  function startRename(project: ProjectMetadata): void {
    setEditing(project.id);
    setEditName(project.name);
  }

  function submitRename(): void {
    const name = editName.trim();
    if (editing === null || name === "") return;
    onRename(editing, name);
    setEditing(null);
  }

  return (
    <div className="space-y-1.5">
      {unavailable !== null ? (
        <p data-testid="projects-unavailable" className="text-muted-foreground text-[11.5px]">
          {unavailable}
        </p>
      ) : null}

      <form
        data-testid="project-create"
        onSubmit={(event) => {
          event.preventDefault();
          submitCreate();
        }}
        className="space-y-1 border-b pb-1.5"
      >
        <label
          htmlFor="project-name"
          className="text-muted-foreground text-[10px] font-semibold tracking-[0.1em] uppercase"
        >
          New project
        </label>
        <div className="flex items-center gap-1">
          <Input
            id="project-name"
            data-testid="project-name"
            value={draftName}
            placeholder="landing-page"
            autoComplete="off"
            disabled={disabled}
            onChange={(event) => setDraftName(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            data-testid="project-create-submit"
            disabled={disabled || draftName.trim() === ""}
          >
            <Plus aria-hidden="true" />
            Create
          </Button>
        </div>
      </form>

      <ul data-testid="project-list" aria-label="Projects" className="space-y-1">
        {state.projects.map((project) => {
          const active = state.active?.id === project.id;
          const renaming = editing === project.id;
          return (
            <li
              key={project.id}
              data-testid="project-row"
              data-project={project.id}
              data-active={active ? "true" : "false"}
              className={cn(
                "rounded-md border px-1.5 py-1",
                active ? "border-primary/40 bg-primary/5" : "border-border",
              )}
            >
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  data-testid="project-open"
                  data-project={project.id}
                  // `aria-current` is how a list says "this is the one you are looking at"; the
                  // colour is a second channel for the same fact, never the only one.
                  aria-current={active ? "true" : undefined}
                  aria-label={`Open ${project.name}`}
                  disabled={disabled}
                  onClick={() => onOpen(project.id)}
                  className="min-w-0 flex-1 truncate text-left text-sm focus-visible:ring-ring/50 rounded outline-none focus-visible:ring-[3px]"
                >
                  {project.name}
                </button>
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                  {String(project.fileCount)} f
                </span>
                <IconButton
                  testId={`project-rename-${project.id}`}
                  label={`Rename ${project.name}`}
                  hint="Rename this project"
                  tone="muted"
                  disabled={disabled}
                  onClick={() => startRename(project)}
                >
                  <Pencil aria-hidden="true" />
                </IconButton>
                <IconButton
                  testId={`project-delete-${project.id}`}
                  label={`Delete ${project.name}`}
                  hint="Delete this project and its files from this browser"
                  tone="stop"
                  disabled={disabled}
                  onClick={() => setConfirming(confirming === project.id ? null : project.id)}
                >
                  <Trash2 aria-hidden="true" />
                </IconButton>
              </div>

              {confirming === project.id ? (
                // Two presses, not one: deleting a project also deletes its files, and there is
                // no undo. The second press is a sentence, because a dialog inside a dialog is
                // three ways to trap a keyboard user.
                <div
                  data-testid="project-delete-confirm"
                  className="mt-1 flex items-center justify-between gap-1"
                >
                  <span className="text-destructive text-[11px]">Delete and its files? No undo.</span>
                  <span className="flex items-center gap-1">
                    <IconButton
                      testId={`project-delete-confirm-${project.id}`}
                      label={`Delete ${project.name} for good`}
                      tone="stop"
                      disabled={disabled}
                      onClick={() => {
                        setConfirming(null);
                        onRemove(project.id);
                      }}
                    >
                      <Check aria-hidden="true" />
                    </IconButton>
                    <IconButton
                      testId={`project-delete-cancel-${project.id}`}
                      label="Keep it"
                      tone="muted"
                      onClick={() => setConfirming(null)}
                    >
                      <X aria-hidden="true" />
                    </IconButton>
                  </span>
                </div>
              ) : null}

              {renaming ? (
                <form
                  data-testid="project-rename-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitRename();
                  }}
                  className="mt-1 flex items-center gap-1"
                >
                  <Input
                    data-testid="project-rename-input"
                    aria-label={`New name for ${project.name}`}
                    value={editName}
                    autoFocus
                    onChange={(event) => setEditName(event.target.value)}
                  />
                  <IconButton
                    testId={`project-rename-save-${project.id}`}
                    label={`Save the new name for ${project.name}`}
                    tone="run"
                    type="submit"
                    disabled={editName.trim() === ""}
                  >
                    <Check aria-hidden="true" />
                  </IconButton>
                  <IconButton
                    testId={`project-rename-cancel-${project.id}`}
                    label="Keep the old name"
                    tone="muted"
                    onClick={() => setEditing(null)}
                  >
                    <X aria-hidden="true" />
                  </IconButton>
                </form>
              ) : null}
            </li>
          );
        })}
      </ul>

      <p
        data-testid="projects-status"
        // A save in flight and a failed save are both things a screen reader should hear.
        role="status"
        className="text-muted-foreground flex items-center gap-1 border-t pt-1 text-[11px]"
      >
        <span>{describeProjectStatus(state, now())}</span>
        {activeSuffix(state) === null ? null : (
          <span data-testid="projects-active-name" className="truncate">
            · {activeSuffix(state)}
          </span>
        )}
      </p>

      {persistent ? null : (
        <p data-testid="projects-session-only" className="text-warning text-[11px]">
          This browser will not let the app store files, so these projects last until the page is
          closed.
        </p>
      )}

      {error === null ? null : (
        <p data-testid="projects-error" role="alert" className="text-destructive text-[11px]">
          {error}
        </p>
      )}
    </div>
  );
}

/** The open project's name, for the status line; null when nothing is open. */
function activeSuffix(state: ProjectState): string | null {
  return state.active === null ? null : state.active.name;
}
