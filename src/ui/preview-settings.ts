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
 * - **Prod says which of the two previews the user wants.** Off (the default for a developer)
 *   the preview runs the project's own `dev`/`start` script on the port above, and attaches to
 *   whatever is already answering there — so `bun run dev -- -p 1234` in the terminal remains
 *   the faster loop once it is warm. On, it is the older behaviour: the project's build output
 *   is read out of the guest and served statically on that same port.
 *   It is a boolean beside the two fields rather than a mode selector because it is one bit of
 *   information, and `src/preview/mode.ts` is what turns it into a plan.
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
  /** The guest port every preview server is started on, or attached to. */
  port: number;
  /** Build directory, workspace-relative. Never absolute, never empty. */
  buildDirectory: string;
  /**
   * `true` serves the built `buildDirectory` statically on `port` (the older behaviour).
   * `false` runs the project's own `dev`/`start` script on `port`, or attaches to the server
   * that already answers there — the user's, if they started one themselves.
   */
  prod: boolean;
}

/** What the two inputs currently show, which may be a half-typed invalid value. */
export interface PreviewSettingsDraft {
  port: string;
  buildDirectory: string;
}

export function defaultPreviewSettings(): PreviewSettings {
  return {
    port: DEFAULT_PREVIEW_SETTINGS_PORT,
    buildDirectory: DEFAULT_BUILD_DIRECTORY,
    // Prod, for now (user request: "set prod=true by default for now"). The switch is still the
    // user's: off means the preview runs the project's server (or attaches to one already up), and
    // `src/preview/mode.ts`
    // turns the bit into a plan either way.
    prod: true,
  };
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
 * The settings to keep when the Prod switch is at `prod`; the same object when it already is.
 *
 * Identity is the contract here too: the hook compares the returned object with the previous
 * one to decide whether anything is worth writing to `localStorage`, so flipping the switch
 * off and on again must not be a write.
 */
export function withProd(settings: PreviewSettings, prod: boolean): PreviewSettings {
  return settings.prod === prod ? settings : { ...settings, prod };
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
  return JSON.stringify({
    // 2 added `prod`. The parser ignores the number and reads field by field, so a stored v1
    // pair still loads; the number is for a human reading `localStorage` in devtools.
    v: 2,
    port: settings.port,
    buildDirectory: settings.buildDirectory,
    prod: settings.prod,
  });
}

/**
 * Stored settings, or the defaults.
 *
 * Field by field, not all-or-nothing: a stored port that is no longer a number must not wipe
 * the user's build directory, and the defaults are always runnable. A missing or non-boolean
 * `prod` is the current default (`true`), which is the same answer as "the user never chose".
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
  const record = parsed as { port?: unknown; buildDirectory?: unknown; prod?: unknown };
  const port =
    typeof record.port === "number" && Number.isInteger(record.port) && parsePort(String(record.port)) !== null
      ? record.port
      : defaults.port;
  const directory =
    typeof record.buildDirectory === "string"
      ? normaliseBuildDirectory(record.buildDirectory)
      : "";
  const prod = typeof record.prod === "boolean" ? record.prod : defaults.prod;
  return {
    port,
    buildDirectory: directory.length > 0 ? directory : defaults.buildDirectory,
    prod,
  };
}
