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
    // Destination actions notify synchronous subscribers. Recheck ownership
    // between adapters: a subscriber may bind a different account mid-apply.
    if (!readCurrent()) return;
    settings.resetAccountPreferences(...args);
    if (!readCurrent()) return;
    sidebar.resetAccountPreferences();
    if (!readCurrent()) return;
    voice.resetAccountPreferences(...args);
    if (!readCurrent()) return;
    accessibility.resetAccountPreferences();
    if (!readCurrent()) return;
    timeFormat.resetAccountPreferences();
  }
  let data = readCurrent();
  if (!data) return;
  if (typeof data.theme === "string") settings.applyFromServer(data.theme);
  data = readCurrent(); if (!data) return;
  if (object(data.appearance)) settings.applyAppearanceFromServer(data.appearance);
  data = readCurrent(); if (!data) return;
  if (object(data.sidebar_sections) || typeof data.sidebar_expanded === "boolean") {
    sidebar.applyFromServer(object(data.sidebar_sections) ? data.sidebar_sections as Record<string, boolean> : {}, typeof data.sidebar_expanded === "boolean" ? data.sidebar_expanded : undefined);
  }
  data = readCurrent(); if (!data) return;
  if (object(data.voice_settings)) voice.applyFromServer(data.voice_settings);
  data = readCurrent(); if (!data) return;
  if (object(data.accessibility)) accessibility.applyFromServer(data.accessibility);
  data = readCurrent(); if (!data) return;
  if (object(data.locale)) timeFormat.applyFromServer(data.locale);
}
