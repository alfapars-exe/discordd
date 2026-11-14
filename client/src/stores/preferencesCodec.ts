import { DEVICE_LOCAL_VOICE_SETTING_KEYS } from "./voicePreferenceScope";
import { DEFAULT_NOTIFICATION_PREFERENCES, NOTIFICATION_BOOLEAN_FIELDS } from "../utils/notificationPreferenceDefaults";
import { APPEARANCE_RANGES, APPEARANCE_STORAGE_KEYS } from "./appearancePreferences";

export type PreferencesData = Record<string, unknown>;

const MERGED_NAMESPACES = new Set(["voice_settings", "accessibility", "appearance", "sidebar_sections", "cosmetics_view", "entrance_sounds", "privacy", "notifications", "email_preferences", "locale"]);
const DEVICE_FIELDS = new Set(DEVICE_LOCAL_VOICE_SETTING_KEYS);
const CACHE_FIELDS: Record<string, Set<string>> = {
  cosmetics_view: new Set(["plain"]),
  appearance: new Set(Object.keys(APPEARANCE_STORAGE_KEYS)),
  entrance_sounds: new Set(["enabled", "volume"]),
  accessibility: new Set(["chatFontSize", "alwaysUnderlineLinks", "showDisplayNameStyles", "density", "messageStyle", "messageGroupGapPx", "saturation", "saturateCustomColors", "highContrast", "syncHighContrast", "showSwitchIndicators", "roleColorMode", "officialMessageStyle", "reduceMotion", "syncReducedMotion", "disableAnimatedEmoji", "autoplayGifs", "stickerAnimation", "notificationSoundVolume", "ttsEnabled", "ttsRate", "notificationDuration", "showImageDescriptions", "legacyComposer"]),
  voice_settings: new Set(["inputMode", "pttKey", "micSensitivity", "userVolumes", "masterVolume", "inputVolume", "soundsEnabled", "localMutedUsers", "noiseReduction", "noiseReductionEngine", "noiseSuppressionLevel", "deepfilterSuppression", "screenShareVolumes", "screenShareAudio", "screenShareQuality", "screenShareFps", "screenShareShowCursor", "screenShareLowLatency", "screenShareMode", "cameraQuality", "cameraFps", "micProfile", "muteHotkeyEnabled", "muteHotkey"]),
  privacy: new Set(["improvementTelemetry", "profileAudience", "shareProfileUpdates", "shareOnlineUpdates", "shareStreamUpdates", "shareGameActivity", "allowFriendsToJoinGame", "allowVoiceParticipantsToJoinGame", "gameActivityNewServerAudience", "gameActivityServerOverrides", "clipVoiceConsent", "experiencePersonalization", "friendRequests", "ignoredUsers", "personalizedFriendMessages", "spamFilter", "spamRestoredMessages", "serverDMDefault", "serverDMOverrides", "sensitiveMedia", "disturbingMedia"]),
  notifications: new Set(Object.keys(DEFAULT_NOTIFICATION_PREFERENCES)),
  email_preferences: new Set(["communication", "social", "announcements", "tips", "recommendations", "marketingUnsubscribed"]),
  locale: new Set(["timeFormat"]),
};
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const BOOLEAN_FIELDS = new Set([
  "plain", "enabled", "blurEnabled", "wallpaperEnabled", "lightningEnabled", "neonEnabled", "alwaysUnderlineLinks", "showDisplayNameStyles", "saturateCustomColors", "highContrast", "syncHighContrast", "showSwitchIndicators", "reduceMotion", "syncReducedMotion", "disableAnimatedEmoji", "autoplayGifs", "ttsEnabled", "showImageDescriptions", "legacyComposer", "soundsEnabled", "noiseReduction", "screenShareAudio", "screenShareShowCursor", "screenShareLowLatency", "muteHotkeyEnabled", "voiceOverlayEnabled", "voiceOverlaySpeakingOnly", "voiceOverlayChat", "voiceOverlayChatActions", "voiceOverlayChatCompose", "improvementTelemetry", "shareProfileUpdates", "shareOnlineUpdates", "shareStreamUpdates", "clipVoiceConsent", "experiencePersonalization", "personalizedFriendMessages", "serverDMDefault", "communication", "social", "announcements", "tips", "recommendations", "marketingUnsubscribed",
  ...NOTIFICATION_BOOLEAN_FIELDS,
]);
const NUMBER_RANGES: Record<string, [number, number]> = {
  ...APPEARANCE_RANGES,
  chatFontSize: [12, 24], messageGroupGapPx: [0, 24], saturation: [0, 100], notificationSoundVolume: [0, 100], ttsRate: [0.5, 2],
  micSensitivity: [0, 100], masterVolume: [0, 100], inputVolume: [0, 200], deepfilterSuppression: [0, 100], volume: [0, 100], voiceOverlaySpeakingOpacity: [20, 100], voiceOverlayIdleOpacity: [0, 100], voiceOverlayScale: [75, 150],
};
const ENUM_FIELDS: Record<string, readonly (string | number)[]> = {
  avatarAnimation: ["hover", "always"], density: ["compact", "default", "cozy"], messageStyle: ["default", "compact"],
  inputMode: ["voice_activity", "push_to_talk"], noiseReductionEngine: ["rnnoise", "krisp", "webrtc", "deepfilter", "gtcrn", "dtln", "speex"],
  noiseSuppressionLevel: ["low", "medium", "high", "maximum"], screenShareQuality: ["720p", "1080p", "1440p", "native"],
  screenShareFps: [30, 60, 120, -1], screenShareMode: ["motion", "detail"], cameraQuality: ["360p", "720p", "1080p"],
  cameraFps: [15, 30], micProfile: ["konusma", "muzik"],
  profileAudience: ["all_servers", "small_servers", "friends_only"],
  gameActivityNewServerAudience: ["all", "small", "none"],
  reactionMode: ["all", "direct", "none"], soundPack: ["classic", "soft", "minimal"], desktopDelaySeconds: [0, 3, 5, 10], notificationDuration: [3, 5, 10, 15, 20], stickerAnimation: ["always", "interaction", "never"],
  timeFormat: ["auto", "12", "24"],
  voiceOverlayPosition: ["top-left", "bottom-left", "top-right", "bottom-right"],
  roleColorMode: ["names", "dots", "hidden"],
  officialMessageStyle: ["default", "subtle", "prominent"],
  spamFilter: ["all", "nonfriends", "off"],
};
export function object(value: unknown): value is PreferencesData {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function clean(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map((v) => clean(v, depth + 1)).filter((v) => v !== undefined);
  if (!object(value)) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !UNSAFE_KEYS.has(key)).map(([key, v]) => [key, clean(v, depth + 1)]).filter(([, v]) => v !== undefined));
}
export function sanitize(data: unknown): PreferencesData {
  const result = object(data) ? clean(data) as PreferencesData : {};
  if (object(result.voice_settings)) {
    for (const key of DEVICE_FIELDS) delete result.voice_settings[key];
    if (["krisp", "dpdfnet"].includes(result.voice_settings.noiseReductionEngine as string)) {
      result.voice_settings.noiseReductionEngine = "rnnoise";
    }
  }
  return result;
}
function mergeObjects(base: PreferencesData, patch: PreferencesData): PreferencesData {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = object(result[key]) && object(value) ? mergeObjects(result[key], value) : value;
  }
  return result;
}
export function merge(base: PreferencesData, patch: PreferencesData): PreferencesData {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = MERGED_NAMESPACES.has(key) && object(result[key]) && object(value)
      ? mergeObjects(result[key], value) : value;
  }
  return result;
}
export function nonempty(value: PreferencesData): boolean { return Object.keys(value).length > 0; }
function validField(key: string, value: unknown): boolean {
  if (BOOLEAN_FIELDS.has(key) || key === "shareGameActivity" || key === "allowFriendsToJoinGame" || key === "allowVoiceParticipantsToJoinGame") return typeof value === "boolean";
  if (NUMBER_RANGES[key]) return typeof value === "number" && Number.isFinite(value) && value >= NUMBER_RANGES[key][0] && value <= NUMBER_RANGES[key][1];
  if (ENUM_FIELDS[key]) return ENUM_FIELDS[key].includes(value as string | number);
  if (key === "pttKey" || key === "muteHotkey") return typeof value === "string" && value.length <= 64;
  if (key === "friendRequests" && object(value)) {
    const entries = Object.entries(value);
    return entries.length <= 3 && entries.every(([name, enabled]) => ["everyone", "mutual", "server"].includes(name) && typeof enabled === "boolean");
  }
  if (key === "spamRestoredMessages" && object(value)) {
    const entries = Object.entries(value);
    return entries.length <= 1024 && entries.every(([id, revision]) => id.length > 0 && id.length <= 128 && typeof revision === "string" && revision.length <= 64);
  }
  if (key === "ignoredUsers" && object(value)) {
    const entries = Object.entries(value);
    return entries.length <= 1024 && entries.every(([id, ignored]) => id.length > 0 && id.length <= 128 && typeof ignored === "boolean");
  }
  if ((key === "serverDMOverrides" || key === "gameActivityServerOverrides") && object(value)) {
    const entries = Object.entries(value);
    const maxIdLength = key === "gameActivityServerOverrides" ? 256 : 128;
    return entries.length <= 1024 && entries.every(([id, enabled]) => id.length > 0 && id.length <= maxIdLength && typeof enabled === "boolean");
  }
  if ((key === "sensitiveMedia" || key === "disturbingMedia") && object(value)) {
    const entries = Object.entries(value);
    return entries.length <= 3 && entries.every(([scope, mode]) => ["friendDMs", "otherDMs", "channels"].includes(scope) && ["show", "blur", "block"].includes(mode as string));
  }
  return ["userVolumes", "screenShareVolumes", "localMutedUsers"].includes(key) && object(value);
}
function cachedGIFs(raw: unknown[]): PreferencesData[] {
  const seen = new Set<string>();
  return raw.filter(object).flatMap((item) => {
    const { id, title, url, preview_url, width, height } = item;
    if (typeof id !== "string" || !id || id.length > 128 || seen.has(id) || typeof title !== "string") return [];
    if (typeof url !== "string" || typeof preview_url !== "string" || !/^https?:\/\/static\.klipy\.com\/[^\s]+$/.test(url) || !/^https?:\/\/static\.klipy\.com\/[^\s]+$/.test(preview_url)) return [];
    if (url.length > 2048 || preview_url.length > 2048 || typeof width !== "number" || !Number.isFinite(width) || width < 0 || width > 16384 || typeof height !== "number" || !Number.isFinite(height) || height < 0 || height > 16384) return [];
    seen.add(id);
    return [{ id, title: title.slice(0, 200), url, preview_url, width, height }];
  }).slice(0, 50);
}

/** Only known, non-secret preference fields may survive in an account cache. */
export function cacheable(data: PreferencesData): PreferencesData {
  const out: PreferencesData = {};
  if (typeof data.theme === "string" && data.theme.length <= 64) out.theme = data.theme;
  if (typeof data.sidebar_expanded === "boolean") out.sidebar_expanded = data.sidebar_expanded;
  if (Array.isArray(data.gif_favorites)) out.gif_favorites = cachedGIFs(data.gif_favorites);
  if (object(data.sidebar_sections)) {
    out.sidebar_sections = Object.fromEntries(Object.entries(data.sidebar_sections).filter(([k, v]) => k.length <= 128 && typeof v === "boolean"));
  }
  for (const [namespace, fields] of Object.entries(CACHE_FIELDS)) {
    const value = data[namespace];
    if (!object(value)) continue;
    const allowed = Object.fromEntries(Object.entries(value).filter(([k, v]) => fields.has(k) && validField(k, v)));
    for (const key of ["userVolumes", "screenShareVolumes", "localMutedUsers"]) {
      if (object(allowed[key])) allowed[key] = Object.fromEntries(Object.entries(allowed[key]).filter(([k, v]) => k.length <= 128 && (key === "localMutedUsers" ? typeof v === "boolean" : typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 200)));
    }
    if (nonempty(allowed)) out[namespace] = allowed;
  }
  return sanitize(out);
}

export function decodeLegacyAppearance(field: string, raw: string | null): string | boolean | number | undefined {
  if (raw === null || raw.length > 64) return undefined;
  if (BOOLEAN_FIELDS.has(field)) {
    if (raw === "1") return true;
    if (raw === "0") return false;
    return undefined;
  }
  if (NUMBER_RANGES[field]) return raw.trim() === "" ? undefined : Number(raw);
  return raw;
}
