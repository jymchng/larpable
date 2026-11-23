/**
 * The preview settings, persisted where the provider settings are: this browser.
 *
 * `localStorage` and not the guest, for the same reason as `use-llm-settings`: these are the
 * page's own choices about how it drives the guest, not files in the project. A build directory
 * the user set on one machine should not silently become a directory in someone else's project.
 *
 * The hook keeps two things apart on purpose \u2014 the **draft** (what the inputs show, which may
 * be half-typed) and the **settings** (the last valid pair the previews use). A keystroke that
 * cannot be a port changes the draft and nothing else, so the preview that is running keeps
 * running; see `settingsFromDraft`.
 *
 * Every storage access is guarded: this module is imported by the app shell, which the unit
 * tests render without a DOM.
 */

import { useCallback, useEffect, useState } from "react";

import {
  PREVIEW_SETTINGS_STORAGE_KEY,
  draftOf,
  defaultPreviewSettings,
  draftProblem,
  parseStoredPreviewSettings,
  serializePreviewSettings,
  settingsFromDraft,
  withProd,
  type PreviewSettings,
  type PreviewSettingsDraft,
} from "@/ui/preview-settings";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

interface PreviewSettingsState {
  settings: PreviewSettings;
  draft: PreviewSettingsDraft;
}

function initialState(): PreviewSettingsState {
  const store = storage();
  const settings = parseStoredPreviewSettings(
    store === null ? null : store.getItem(PREVIEW_SETTINGS_STORAGE_KEY),
  );
  return { settings, draft: draftOf(settings) };
}

function persist(settings: PreviewSettings): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(PREVIEW_SETTINGS_STORAGE_KEY, serializePreviewSettings(settings));
  } catch {
    // A full quota must not lose the in-memory choice: the session still works.
  }
}

export interface PreviewSettingsControl {
  /** The last valid pair. This is what both previews are started with. */
  settings: PreviewSettings;
  /** What the two inputs show, including a half-typed value. */
  draft: PreviewSettingsDraft;
  setPort: (text: string) => void;
  setBuildDirectory: (text: string) => void;
  /**
   * The Prod switch: `true` serves the built directory statically, `false` attaches to the
   * server the user runs. Persisted with the rest, and never a draft \u2014 a checkbox has no
   * half-typed state.
   */
  setProd: (prod: boolean) => void;
  /** Why the draft is not usable yet, in the panel's words; null when it is. */
  problem: string | null;
  /** True when the choice survives a reload. */
  persisted: boolean;
  /** Back to `localhost:5173` and `dist`. */
  reset: () => void;
}

export function usePreviewSettings(): PreviewSettingsControl {
  const [state, setState] = useState<PreviewSettingsState>(initialState);

  const apply = useCallback((draft: Partial<PreviewSettingsDraft>) => {
    setState((previous) => {
      const next: PreviewSettingsState = {
        draft: { ...previous.draft, ...draft },
        settings: previous.settings,
      };
      next.settings = settingsFromDraft(previous.settings, next.draft);
      if (next.settings !== previous.settings) persist(next.settings);
      return next;
    });
  }, []);

  const setPort = useCallback((text: string) => apply({ port: text }), [apply]);
  const setBuildDirectory = useCallback((text: string) => apply({ buildDirectory: text }), [apply]);

  // The switch is not a draft: it has two states and no in-between, so it goes straight into
  // the settings and is persisted in the same write as the two fields.
  const setProd = useCallback((prod: boolean) => {
    setState((previous) => {
      const settings = withProd(previous.settings, prod);
      if (settings === previous.settings) return previous;
      persist(settings);
      return { settings, draft: previous.draft };
    });
  }, []);

  const reset = useCallback(() => {
    const settings = defaultPreviewSettings();
    persist(settings);
    setState({ settings, draft: draftOf(settings) });
  }, []);

  // A second tab changing the port should not leave this one starting a server somewhere else.
  useEffect(() => {
    const store = storage();
    if (store === null) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== PREVIEW_SETTINGS_STORAGE_KEY) return;
      const settings = parseStoredPreviewSettings(event.newValue);
      setState({ settings, draft: draftOf(settings) });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return {
    settings: state.settings,
    draft: state.draft,
    setPort,
    setBuildDirectory,
    setProd,
    problem: draftProblem(state.draft),
    persisted: storage() !== null,
    reset,
  };
}
