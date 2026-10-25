import { createContext, useContext, useEffect, useId } from "react";
import type { SettingsTab } from "../../stores/settingsStore";

export type SettingsSection = { id: string; label: string };
export type SettingsWorkspace = {
  sections: SettingsSection[];
  activeSection: string | null;
  navigate: (tab: SettingsTab, section?: string) => void;
  navigateSection: (id: string) => void;
  back: () => void;
  canGoBack: boolean;
  close: () => void;
  registerDraft: (id: string, dirty: boolean) => void;
};

export const SettingsWorkspaceContext = createContext<SettingsWorkspace | null>(null);

/** Form state stays in its owner; navigation must not silently discard it. */
export function useSettingsDraft(dirty: boolean) {
  const workspace = useContext(SettingsWorkspaceContext);
  const register = workspace?.registerDraft;
  const id = useId();
  useEffect(() => {
    register?.(id, dirty);
    return () => register?.(id, false);
  }, [register, id, dirty]);
}
