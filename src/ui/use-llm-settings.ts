/**
 * The provider settings, persisted where they belong: this browser.
 *
 * `localStorage` and not the guest, and not IndexedDB with the projects: a key is a credential
 * for an API the *page* calls, and putting it anywhere the agent's filesystem tools can read
 * would hand it to generated code. The storage key is versioned by `serializeSettings` so a
 * future field cannot be added by accident.
 *
 * Every access is guarded: this module is imported by the app shell, which the unit tests
 * render without a DOM.
 */

import { useCallback, useEffect, useState } from "react";

import {
  SETTINGS_STORAGE_KEY,
  defaultSettings,
  parseStoredSettings,
  serializeSettings,
  type LlmSettings,
} from "@/llm/settings";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A browser with storage disabled throws on the property itself; the settings still work
    // for this page's lifetime, they just do not survive a reload.
    return null;
  }
}

export interface LlmSettingsControl {
  settings: LlmSettings;
  update: (settings: LlmSettings) => void;
  /** Where the settings are kept, for the panel's copy. */
  persisted: boolean;
}

export function useLlmSettings(): LlmSettingsControl {
  const [settings, setSettings] = useState<LlmSettings>(() => {
    const store = storage();
    return parseStoredSettings(store === null ? null : store.getItem(SETTINGS_STORAGE_KEY));
  });

  const persisted = storage() !== null;

  const update = useCallback((next: LlmSettings) => {
    setSettings(next);
    const store = storage();
    if (store === null) return;
    try {
      store.setItem(SETTINGS_STORAGE_KEY, serializeSettings(next));
    } catch {
      // A full quota must not lose the in-memory choice: the user can still work this session.
    }
  }, []);

  // A second tab changing the provider should not leave this one sending to the old API.
  useEffect(() => {
    const store = storage();
    if (store === null) return;
    const onStorage = (event: StorageEvent) => {
      if (event.key !== SETTINGS_STORAGE_KEY) return;
      setSettings(parseStoredSettings(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return { settings, update, persisted };
}

/** The default settings, re-exported so the panel and the shell agree on "no key". */
export { defaultSettings };
