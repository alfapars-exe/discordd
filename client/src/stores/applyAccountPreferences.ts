import { useSettingsStore } from "./settingsStore";
import { useSidebarStore } from "./sidebarStore";
import { useVoiceStore } from "./voiceStore";
import { useAccessibilityStore } from "./accessibilityStore";
import { useTimeFormatStore } from "./timeFormatStore";
import { object, type PreferencesData } from "./preferencesCodec";

type ReadCurrentPreferences = () => PreferencesData | null;
type PreferenceDestinations = {
  settings: ReturnType<typeof useSettingsStore.getState>;
  sidebar: ReturnType<typeof useSidebarStore.getState>;
  voice: ReturnType<typeof useVoiceStore.getState>;
  accessibility: ReturnType<typeof useAccessibilityStore.getState>;
  timeFormat: ReturnType<typeof useTimeFormatStore.getState>;
};

function resetPreferenceDestinations(
  { settings, sidebar, voice, accessibility, timeFormat }: PreferenceDestinations,
  readCurrent: ReadCurrentPreferences,
  preserveSessionState: boolean,
): boolean {
  const args: [] | [true] = preserveSessionState ? [true] : [];
  // Destination actions notify synchronous subscribers. Recheck ownership
  // between adapters: a subscriber may bind a different account mid-apply.
  if (!readCurrent()) return false;
  settings.resetAccountPreferences(preserveSessionState, () => readCurrent() !== null);
  if (!readCurrent()) return false;
  sidebar.resetAccountPreferences();
  if (!readCurrent()) return false;
  voice.resetAccountPreferences(...args);
  if (!readCurrent()) return false;
  accessibility.resetAccountPreferences();
  if (!readCurrent()) return false;
  timeFormat.resetAccountPreferences();
  return true;
}

function applySidebarPreferences(sidebar: PreferenceDestinations["sidebar"], data: PreferencesData): void {
  if (object(data.sidebar_sections) || typeof data.sidebar_expanded === "boolean") {
    sidebar.applyFromServer(
      object(data.sidebar_sections) ? data.sidebar_sections as Record<string, boolean> : {},
      typeof data.sidebar_expanded === "boolean" ? data.sidebar_expanded : undefined,
    );
  }
}

function applyPreferenceValues(
  { settings, sidebar, voice, accessibility, timeFormat }: PreferenceDestinations,
  readCurrent: ReadCurrentPreferences,
): void {
  let data = readCurrent();
  if (!data) return;
  if (typeof data.theme === "string") settings.applyFromServer(data.theme);
  data = readCurrent();
  if (!data) return;
  if (object(data.appearance)) settings.applyAppearanceFromServer(data.appearance);
  data = readCurrent();
  if (!data) return;
  applySidebarPreferences(sidebar, data);
  data = readCurrent();
  if (!data) return;
  if (object(data.voice_settings)) voice.applyFromServer(data.voice_settings);
  data = readCurrent();
  if (!data) return;
  if (object(data.accessibility)) accessibility.applyFromServer(data.accessibility);
  data = readCurrent();
  if (!data) return;
  if (object(data.locale)) timeFormat.applyFromServer(data.locale);
}

export function applyAccountPreferences(
  readCurrent: ReadCurrentPreferences,
  reset: boolean,
  preserveSessionState: boolean,
): void {
  const destinations: PreferenceDestinations = {
    settings: useSettingsStore.getState(),
    sidebar: useSidebarStore.getState(),
    voice: useVoiceStore.getState(),
    accessibility: useAccessibilityStore.getState(),
    timeFormat: useTimeFormatStore.getState(),
  };
  if (reset && !resetPreferenceDestinations(destinations, readCurrent, preserveSessionState)) return;
  applyPreferenceValues(destinations, readCurrent);
}
