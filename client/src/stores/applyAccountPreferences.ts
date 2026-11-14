import { useSettingsStore } from "./settingsStore";
import { useSidebarStore } from "./sidebarStore";
import { useVoiceStore } from "./voiceStore";
import { useAccessibilityStore } from "./accessibilityStore";
import { useTimeFormatStore } from "./timeFormatStore";
import { object, type PreferencesData } from "./preferencesCodec";

export function applyAccountPreferences(
  readCurrent: () => PreferencesData | null,
  reset: boolean,
  preserveSessionState: boolean,
): void {
  const settings = useSettingsStore.getState();
  const sidebar = useSidebarStore.getState();
  const voice = useVoiceStore.getState();
  const accessibility = useAccessibilityStore.getState();
  const timeFormat = useTimeFormatStore.getState();
  if (reset) {
    const args: [] | [true] = preserveSessionState ? [true] : [];
    settings.resetAccountPreferences(...args);
    sidebar.resetAccountPreferences();
    voice.resetAccountPreferences(...args);
    accessibility.resetAccountPreferences();
    timeFormat.resetAccountPreferences();
  }
  const data = readCurrent();
  if (!data) return;
  if (typeof data.theme === "string") settings.applyFromServer(data.theme);
  if (object(data.appearance)) settings.applyAppearanceFromServer(data.appearance);
  if (object(data.sidebar_sections) || typeof data.sidebar_expanded === "boolean") {
    sidebar.applyFromServer(object(data.sidebar_sections) ? data.sidebar_sections as Record<string, boolean> : {}, typeof data.sidebar_expanded === "boolean" ? data.sidebar_expanded : undefined);
  }
  if (object(data.voice_settings)) voice.applyFromServer(data.voice_settings);
  if (object(data.accessibility)) accessibility.applyFromServer(data.accessibility);
  if (object(data.locale)) timeFormat.applyFromServer(data.locale);
}
