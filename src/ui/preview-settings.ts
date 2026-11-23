/**
 * The two settings that are not about the provider: the address a guest server listens on, and
 * the directory a static build lands in.
 *
 * Both used to be constants \u2014 `8123` for the preview server, `3000` for a project's own
 * `start` script, `dist` for the publish root \u2014 so a project that emits `build/`, or a guest
 * with something already on the port, had no way to say so. They are now the user's, and the
 * rules below are what makes a free-text field in a popover safe to type into:
 *
 * - **The host cannot be anything else, so it is shown and not typed.** The preview reaches the
 *   guest through the kernel's own HTTP door (`kernel.fetch()`), and the only host behind that
 *   door is the guest's `localhost`. A host field would be a field whose every other value fails
 *   with a socket error, which teaches the user that the product is broken.
 * - **One port, both servers.** The static preview server and a project's own `start` script
 *   are never reached the same way, but they are reached the same *where*: one number is what a
 *   person means by "the port", and two would be a setting nobody can reason about. Vite's
 *   default (`5173`) is the default here because that is the number a web developer already has
 *   in their fingers.
 * - **An invalid draft never reaches a server.** While the field is empty, or holds something
 *   that is not a port (`5173x`, `0`), the number actually used stays the last valid one and the
 *   panel says what is wrong. Adopting the draft regardless would mean a preview that fails on
 *   a keystroke. A *valid* prefix is adopted as soon as it is typed (`5` is a port), which is
 *   the honest reading of a field that already says what it means.
 * - **A build directory is workspace-relative.** An absolute path, or one that walks out with
 *   `..`, is refused rather than silently reinterpreted: reading a directory the guest cannot
 *   reach is a different question from mistyping a name.
 */

/** The guest's own loopback. The only host a guest server can be reached on. */
export const PREVIEW_HOST = "localhost";

/** Vite's default port, which is the number the target user already knows. */
export const DEFAULT_PREVIEW_SETTINGS_PORT = 5173;

/** Where a static build lands unless the project says otherwise (`build`, `out`, `public`). */
export const DEFAULT_BUILD_DIRECTORY = "dist";

/** Versioned like the provider settings, so a future field cannot appear by accident. */
export const PREVIEW_SETTINGS_STORAGE_KEY = "larpable.preview";

export interface PreviewSettings {
  /** The guest port every preview server is started on. */
  port: number;
  /** Build directory, workspace-relative. Never absolute, never empty. */
  buildDirectory: string;
}

/** What the two inputs currently show, which may be a half-typed invalid value. */
export interface PreviewSettingsDraft {
  port: string;
  buildDirectory: string;
}

export function defaultPreviewSettings(): PreviewSettings {
  return { port: DEFAULT_PREVIEW_SETTINGS_PORT, buildDirectory: DEFAULT_BUILD_DIRECTORY };
}

export function draftOf(settings: PreviewSettings): PreviewSettingsDraft {
  return { port: String(settings.port), buildDirectory: settings.buildDirectory };
}

/** `http://localhost:5173` \u2014 the address the panel paints beside the port field. */
export function baseUrlFor(settings: PreviewSettings): string {
  return `http://${PREVIEW_HOST}:${String(settings.port)}`;
}

/** A port, or null when the text is not one. Digits only: `81 23` is a typo, not a number. */
export function parsePort(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65_535 ? port : null;
}

/**
 * A workspace-relative directory, or the empty string when the text cannot be one.
 *
 * `./build/` and `build` are the same directory and become `build`; `/build` and `../build` are
 * refused, because both name somewhere the guest's workspace tools would not look.
 */
export function normaliseBuildDirectory(text: string): string {
  const trimmed = text.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return "";
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return "";
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment === ".." || segment.length === 0)) return "";
  return trimmed;
}

/** One sentence naming the fix, or null when both fields are usable. */
export function draftProblem(draft: PreviewSettingsDraft): string | null {
  if (parsePort(draft.port) === null) {
    return "The port must be a number between 1 and 65535.";
  }
  const directory = normaliseBuildDirectory(draft.buildDirectory);
  if (directory.length === 0) {
    return "The build directory must be a folder inside the project, such as `dist` or `build`.";
  }
  return null;
}

/**
 * The settings to keep when the port field holds `text`.
 *
 * Returns the same object when the text is not a usable port, so a caller can compare identity
 * to find out whether anything changed \u2014 and so a half-typed number cannot replace a good one.
 */
export function withPort(settings: PreviewSettings, text: string): PreviewSettings {
  const port = parsePort(text);
  if (port === null || port === settings.port) return settings;
  return { ...settings, port };
}

/** The settings to keep when the directory field holds `text`; the same object when unusable. */
export function withBuildDirectory(settings: PreviewSettings, text: string): PreviewSettings {
  const directory = normaliseBuildDirectory(text);
  if (directory.length === 0 || directory === settings.buildDirectory) return settings;
  return { ...settings, buildDirectory: directory };
}

/**
 * What the previews should use, from a draft.
 *
 * The draft is what the user is typing; the answer is the last valid value for each field
 * independently, so fixing the port does not throw away a half-typed directory and the other
 * way round.
 */
export function settingsFromDraft(
  previous: PreviewSettings,
  draft: PreviewSettingsDraft,
): PreviewSettings {
  return withBuildDirectory(withPort(previous, draft.port), draft.buildDirectory);
}

export function serializePreviewSettings(settings: PreviewSettings): string {
  return JSON.stringify({ v: 1, port: settings.port, buildDirectory: settings.buildDirectory });
}

/**
 * Stored settings, or the defaults.
 *
 * Field by field, not all-or-nothing: a stored port that is no longer a number must not wipe
 * the user's build directory, and the defaults are always runnable.
 */
export function parseStoredPreviewSettings(raw: string | null): PreviewSettings {
  const defaults = defaultPreviewSettings();
  if (raw === null) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (typeof parsed !== "object" || parsed === null) return defaults;
  const record = parsed as { port?: unknown; buildDirectory?: unknown };
  const port =
    typeof record.port === "number" && Number.isInteger(record.port) && parsePort(String(record.port)) !== null
      ? record.port
      : defaults.port;
  const directory =
    typeof record.buildDirectory === "string"
      ? normaliseBuildDirectory(record.buildDirectory)
      : "";
  return { port, buildDirectory: directory.length > 0 ? directory : defaults.buildDirectory };
}
