import { create } from "zustand";

const STORAGE_KEY = "hichat.developer-mode.v1";

function loadDeveloperMode(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

type DeveloperSettingsState = {
  developerMode: boolean;
  setDeveloperMode: (enabled: boolean) => void;
};

export const useDeveloperSettingsStore = create<DeveloperSettingsState>((set) => ({
  developerMode: loadDeveloperMode(),
  setDeveloperMode: (enabled) => {
    try {
      localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
    } catch {
      // Storage may be blocked; the in-memory setting still applies.
    }
    set({ developerMode: enabled });
  },
}));

export { STORAGE_KEY as DEVELOPER_MODE_STORAGE_KEY };
