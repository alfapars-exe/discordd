/** Account-scoped preferences sync; queued edits survive failed requests. */
import { create } from "zustand";
import * as preferencesApi from "../api/preferences";
import { SERVER_URL } from "../utils/constants";

type PreferencesData = Record<string, unknown>;
type SyncStatus = "idle" | "loading" | "pending" | "saving" | "saved" | "error";
type PreferencesState = {
  data: PreferencesData;
  isLoaded: boolean;
  accountId: string | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  hasPendingChanges: boolean;
  /** A successful initial GET is required before offering legacy missing-leaf import. */
  legacyImportAvailable: boolean;
  importLegacyPreferences: () => Promise<boolean>;
  bindAccount: (userId: string, backend?: string) => void;
  fetchAndApply: () => Promise<void>;
  retrySync: () => Promise<void>;
  set: (partial: PreferencesData) => void;
  get: <T = unknown>(key: string) => T | undefined;
  reset: () => void;
};

const MERGED_NAMESPACES = new Set(["voice_settings", "accessibility", "appearance", "sidebar_sections", "cosmetics_view", "entrance_sounds", "privacy", "notifications", "email_preferences", "locale"]);
const DEVICE_FIELDS = new Set([
  "inputDevice", "outputDevice", "cameraDevice", "muteHotkeyGlobal",
  "voiceOverlayEnabled", "voiceOverlaySpeakingOpacity", "voiceOverlayIdleOpacity",
  "voiceOverlayScale", "voiceOverlayPosition", "voiceOverlaySpeakingOnly", "voiceOverlayMode",
  "voiceOverlayPinned",
  "voiceOverlayQuickActions", "voiceOverlayClickableActions",
  "voiceOverlayActivity",
  "voiceOverlayGameActivityNotifications", "voiceOverlayNowPlayingNotifications",
  "voiceOverlayNotifications",
  "voiceOverlayNotificationActions",
  "voiceOverlayChat",
  "voiceOverlayChatActions",
  "voiceOverlayChatCompose",
  "voiceOverlayAvatarSize", "voiceOverlayNameDisplay", "voiceOverlayMaxParticipants",
]);
const CACHE_FIELDS: Record<string, Set<string>> = {
  cosmetics_view: new Set(["plain"]),
  appearance: new Set(["blurEnabled", "blurStrength", "wallpaperEnabled", "lightningEnabled", "lightningBlur", "neonEnabled", "neonIntensity", "uiScale", "avatarAnimation"]),
  entrance_sounds: new Set(["enabled", "volume"]),
  accessibility: new Set(["chatFontSize", "alwaysUnderlineLinks", "showDisplayNameStyles", "density", "messageStyle", "messageGroupGapPx", "saturation", "saturateCustomColors", "highContrast", "syncHighContrast", "showSwitchIndicators", "roleColorMode", "officialMessageStyle", "reduceMotion", "syncReducedMotion", "disableAnimatedEmoji", "autoplayGifs", "stickerAnimation", "notificationSoundVolume", "ttsEnabled", "ttsRate", "notificationDuration", "showImageDescriptions", "legacyComposer"]),
  voice_settings: new Set(["inputMode", "pttKey", "micSensitivity", "userVolumes", "masterVolume", "inputVolume", "soundsEnabled", "localMutedUsers", "noiseReduction", "noiseReductionEngine", "noiseSuppressionLevel", "deepfilterSuppression", "screenShareVolumes", "screenShareAudio", "screenShareQuality", "screenShareFps", "screenShareShowCursor", "screenShareLowLatency", "screenShareMode", "cameraQuality", "cameraFps", "micProfile", "muteHotkeyEnabled", "muteHotkey"]),
  privacy: new Set(["improvementTelemetry", "profileAudience", "shareProfileUpdates", "shareOnlineUpdates", "shareStreamUpdates", "shareGameActivity", "allowFriendsToJoinGame", "allowVoiceParticipantsToJoinGame", "gameActivityNewServerAudience", "gameActivityServerOverrides", "clipVoiceConsent", "experiencePersonalization", "friendRequests", "ignoredUsers", "personalizedFriendMessages", "spamFilter", "spamRestoredMessages", "serverDMDefault", "serverDMOverrides", "sensitiveMedia", "disturbingMedia"]),
  notifications: new Set(["desktopEnabled", "taskbarFlash", "unreadBadge", "reactionMode", "soundPack", "messageSound", "currentChannelSound", "incomingCallSound", "muteAllSounds", "voiceJoinSound", "voiceLeaveSound", "voiceWatchStartSound", "voiceWatchStopSound", "voiceMuteSound", "voiceUnmuteSound", "voiceDeafenSound", "voiceUndeafenSound", "notifyWhenFocused", "desktopDelaySeconds", "streamNotifications", "onlineFriendNotifications", "friendAnniversaryNotifications", "profileUpdateNotifications", "upcomingEventNotifications"]),
  email_preferences: new Set(["communication", "social", "announcements", "tips", "recommendations", "marketingUnsubscribed"]),
  locale: new Set(["timeFormat"]),
};
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CACHE_LIMIT = 64 * 1024;
const LEGACY_BACKUP_KEY = "hichat.preferences.legacy-presentation.v1";
const LEGACY_APPEARANCE_KEYS: Record<string, string> = {
  blurEnabled: "mqvi_blur_enabled", blurStrength: "mqvi_blur_strength", wallpaperEnabled: "mqvi_wallpaper_enabled",
  lightningEnabled: "mqvi_lightning_enabled", lightningBlur: "mqvi_lightning_blur", neonEnabled: "mqvi_neon_enabled",
  neonIntensity: "mqvi_neon_intensity", uiScale: "mqvi_ui_scale", avatarAnimation: "hichat-avatar-animation",
};
const BOOLEAN_FIELDS = new Set(["plain", "enabled", "blurEnabled", "wallpaperEnabled", "lightningEnabled", "neonEnabled", "alwaysUnderlineLinks", "showDisplayNameStyles", "saturateCustomColors", "highContrast", "syncHighContrast", "showSwitchIndicators", "reduceMotion", "syncReducedMotion", "disableAnimatedEmoji", "autoplayGifs", "ttsEnabled", "showImageDescriptions", "legacyComposer", "soundsEnabled", "noiseReduction", "screenShareAudio", "screenShareShowCursor", "screenShareLowLatency", "muteHotkeyEnabled", "voiceOverlayEnabled", "voiceOverlaySpeakingOnly", "voiceOverlayChat", "voiceOverlayChatActions", "voiceOverlayChatCompose", "improvementTelemetry", "shareProfileUpdates", "shareOnlineUpdates", "shareStreamUpdates", "clipVoiceConsent", "experiencePersonalization", "personalizedFriendMessages", "serverDMDefault", "desktopEnabled", "taskbarFlash", "unreadBadge", "messageSound", "currentChannelSound", "incomingCallSound", "muteAllSounds", "voiceJoinSound", "voiceLeaveSound", "voiceWatchStartSound", "voiceWatchStopSound", "voiceMuteSound", "voiceUnmuteSound", "voiceDeafenSound", "voiceUndeafenSound", "notifyWhenFocused", "streamNotifications", "onlineFriendNotifications", "friendAnniversaryNotifications", "profileUpdateNotifications", "upcomingEventNotifications", "communication", "social", "announcements", "tips", "recommendations", "marketingUnsubscribed"]);
const NUMBER_RANGES: Record<string, [number, number]> = {
  blurStrength: [8, 40], lightningBlur: [0, 20], neonIntensity: [0, 100], uiScale: [50, 200],
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
const DEBOUNCE_MS = 1000;
let epoch = 0;
let cacheKey: string | null = null;
let snapshotKey: string | null = null;
let legacyImportKey: string | null = null;
let acknowledged: PreferencesData = {};
let legacyBackupFallback: PreferencesData = {};
let legacyBackupUnpersisted = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let pending: PreferencesData = {};
let inFlight: PreferencesData = {};
let fetchEdits: PreferencesData = {};
let fetchAcknowledged: PreferencesData = {};
let fetchPromise: Promise<void> | null = null;
let writePromise: Promise<void> | null = null;
let preparation: Promise<void> = Promise.resolve();
let controller = new AbortController();

function object(value: unknown): value is PreferencesData {
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
function sanitize(data: unknown): PreferencesData {
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
function merge(base: PreferencesData, patch: PreferencesData): PreferencesData {
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    result[key] = MERGED_NAMESPACES.has(key) && object(result[key]) && object(value)
      ? mergeObjects(result[key], value) : value;
  }
  return result;
}
function nonempty(value: PreferencesData): boolean { return Object.keys(value).length > 0; }
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
function cacheable(data: PreferencesData): PreferencesData {
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
function persistCache(key: string | null, data: PreferencesData): boolean {
  if (!key) return false;
  try {
    const value = cacheable(data);
    if (!nonempty(value)) localStorage.removeItem(key);
    else {
      const raw = JSON.stringify(value);
      if (raw.length > CACHE_LIMIT) return false;
      localStorage.setItem(key, raw);
    }
    return true;
  } catch { return false; /* Memory state remains authoritative when storage is unavailable. */ }
}
function persistPending(): boolean { return persistCache(cacheKey, merge(inFlight, pending)); }
function readCache(key: string): PreferencesData {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length <= CACHE_LIMIT ? cacheable(sanitize(JSON.parse(raw))) : {};
  } catch { return {}; }
}
function legacyPresentation(data: PreferencesData): PreferencesData {
  return cacheable({ appearance: data.appearance, accessibility: data.accessibility });
}
function readLegacyBackup(): PreferencesData {
  try {
    const raw = localStorage.getItem(LEGACY_BACKUP_KEY);
    if (raw === null) return legacyBackupFallback;
    if (raw.length > CACHE_LIMIT) return {};
    try { return legacyPresentation(sanitize(JSON.parse(raw))); } catch { return {}; }
  } catch { return legacyBackupFallback; }
}
/** Capture once, before reset overwrites unowned legacy mirrors. Never assign them to an account automatically. */
function preserveLegacyPreferences(): void {
  try {
    if (localStorage.getItem(LEGACY_BACKUP_KEY) !== null) {
      legacyBackupFallback = readLegacyBackup();
      legacyBackupUnpersisted = false;
      return;
    }
    if (legacyBackupUnpersisted) {
      // A prior quota failure must not let an account mirror replace the recovery copy.
      localStorage.setItem(LEGACY_BACKUP_KEY, JSON.stringify(legacyBackupFallback));
      legacyBackupUnpersisted = false;
      return;
    }
    // If storage was cleared during an account session, its mirror is owned, not legacy.
    const appearance: PreferencesData = {};
    let accessibility: unknown;
    if (!cacheKey) {
      for (const [field, key] of Object.entries(LEGACY_APPEARANCE_KEYS)) {
        const raw = localStorage.getItem(key);
        if (raw === null || raw.length > 64) continue;
        if (BOOLEAN_FIELDS.has(field)) {
          if (raw === "1" || raw === "0") appearance[field] = raw === "1";
        } else if (NUMBER_RANGES[field]) {
          if (raw.trim() !== "") appearance[field] = Number(raw);
        } else appearance[field] = raw;
      }
      const raw = localStorage.getItem("tayfa.accessibility.v1");
      if (raw && raw.length <= CACHE_LIMIT) {
        try { accessibility = JSON.parse(raw); } catch { /* Invalid legacy cache is not imported. */ }
      }
    }
    const backup = legacyPresentation({ appearance, accessibility });
    legacyBackupFallback = backup;
    legacyBackupUnpersisted = true;
    // Keep even an empty sentinel: future per-account mirrors are not an upgrade source.
    localStorage.setItem(LEGACY_BACKUP_KEY, JSON.stringify(backup));
    legacyBackupUnpersisted = false;
  } catch { /* A quota failure retains the sanitized recovery copy in memory. */ }
}
function legacyImportPatch(data: PreferencesData): PreferencesData {
  const existing = cacheable(data);
  const backup = readLegacyBackup();
  const patch: PreferencesData = {};
  for (const namespace of ["appearance", "accessibility"]) {
    if (!object(backup[namespace])) continue;
    const present = object(existing[namespace]) ? existing[namespace] : {};
    const missing = Object.fromEntries(Object.entries(backup[namespace]).filter(([key]) => !Object.prototype.hasOwnProperty.call(present, key)));
    if (nonempty(missing)) patch[namespace] = missing;
  }
  return patch;
}
function canImportLegacy(data: PreferencesData, loaded: boolean): boolean {
  if (!cacheKey || !legacyImportKey || !loaded) return false;
  try { if (localStorage.getItem(legacyImportKey) === "1") return false; } catch { /* Check the in-memory eligible leaves. */ }
  return nonempty(legacyImportPatch(data));
}
function current(version: number): boolean { return epoch === version && cacheKey !== null; }
function clearTimer(): void { if (timer) clearTimeout(timer); timer = null; }
function requestContext(version: number) {
  return {
    expectedUserId: usePreferencesStore.getState().accountId ?? undefined,
    isCurrent: () => current(version),
    signal: controller.signal,
  };
}

async function dependentStores() {
  const [settings, sidebar, voice, accessibility, timeFormat] = await Promise.all([
    import("./settingsStore"), import("./sidebarStore"), import("./voiceStore"), import("./accessibilityStore"), import("./timeFormatStore"),
  ]);
  return [settings.useSettingsStore.getState(), sidebar.useSidebarStore.getState(), voice.useVoiceStore.getState(), accessibility.useAccessibilityStore.getState(), timeFormat.useTimeFormatStore.getState()] as const;
}
async function applyData(version: number, reset = false, preserveSessionState = false): Promise<void> {
  const stores = await dependentStores();
  if (!current(version)) return;
  if (reset) {
    if (preserveSessionState) {
      stores[0].resetAccountPreferences(true);
      stores[1].resetAccountPreferences();
      stores[2].resetAccountPreferences(true);
      stores[3].resetAccountPreferences();
      stores[4].resetAccountPreferences();
    } else for (const store of stores) store.resetAccountPreferences();
  }
  if (!current(version)) return;
  // Read after imports: edits made while modules were loading must win.
  // Legacy backend JSON and local caches are not allowed to replace store methods.
  const data = cacheable(usePreferencesStore.getState().data);
  const [settings, sidebar, voice, accessibility, timeFormat] = stores;
  if (typeof data.theme === "string") settings.applyFromServer(data.theme);
  if (object(data.appearance)) settings.applyAppearanceFromServer(data.appearance);
  if (object(data.sidebar_sections) || typeof data.sidebar_expanded === "boolean") {
    sidebar.applyFromServer(object(data.sidebar_sections) ? data.sidebar_sections as Record<string, boolean> : {}, typeof data.sidebar_expanded === "boolean" ? data.sidebar_expanded : undefined);
  }
  if (object(data.voice_settings)) voice.applyFromServer(data.voice_settings);
  if (object(data.accessibility)) accessibility.applyFromServer(data.accessibility);
  if (object(data.locale)) timeFormat.applyFromServer(data.locale);
}
function schedule(): void {
  clearTimer();
  timer = setTimeout(() => { timer = null; void flush(); }, DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (!cacheKey) return;
  if (writePromise) return writePromise;
  const version = epoch;
  if (!usePreferencesStore.getState().isLoaded) await usePreferencesStore.getState().fetchAndApply();
  if (!current(version) || !usePreferencesStore.getState().isLoaded || !nonempty(pending)) return;
  if (writePromise) return writePromise;
  const run = async () => {
    clearTimer();
    inFlight = pending;
    pending = {};
    const sent = inFlight;
    usePreferencesStore.setState({ syncStatus: "saving", syncError: null, hasPendingChanges: true });
    persistPending();
    try {
      const res = await preferencesApi.updatePreferences(sent, requestContext(version));
      if (!current(version)) return;
      if (res.code === "PREFERENCES_ACCOUNT_MISMATCH" || (res.data?.user_id && res.data.user_id !== usePreferencesStore.getState().accountId)) throw new Error("preferences_account_mismatch");
      if (!res.success) throw new Error("preferences_save_failed");
      inFlight = {};
      const returned = sanitize(res.data?.data);
      acknowledged = merge(merge(acknowledged, sent), returned);
      if (fetchPromise) fetchAcknowledged = merge(fetchAcknowledged, merge(sent, returned));
      const data = merge(merge(usePreferencesStore.getState().data, returned), pending);
      usePreferencesStore.setState({ data, syncStatus: nonempty(pending) ? "pending" : "saved", syncError: null, hasPendingChanges: nonempty(pending), legacyImportAvailable: canImportLegacy(data, true) });
      persistCache(snapshotKey, acknowledged);
      persistPending();
      await applyData(version);
    } catch (error) {
      if (!current(version)) return;
      clearTimer();
      pending = merge(sent, pending);
      inFlight = {};
      usePreferencesStore.setState({ syncStatus: "error", syncError: error instanceof Error && error.message === "preferences_account_mismatch" ? "preferences_account_mismatch" : "preferences_save_failed", hasPendingChanges: true });
      persistPending();
    }
  };
  const task = run();
  writePromise = task;
  await task;
  if (!current(version)) return;
  if (writePromise === task) writePromise = null;
  if (nonempty(pending) && usePreferencesStore.getState().syncStatus !== "error") schedule();
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  data: {}, isLoaded: false, accountId: null, syncStatus: "idle", syncError: null, hasPendingChanges: false, legacyImportAvailable: false,
  bindAccount: (userId, backend = SERVER_URL) => {
    const scope = `${encodeURIComponent(backend)}:${encodeURIComponent(userId)}`;
    const key = `hichat.preferences.pending.v1:${scope}`;
    if (cacheKey === key) return;
    get().reset();
    cacheKey = key;
    snapshotKey = `hichat.preferences.snapshot.v1:${scope}`;
    legacyImportKey = `hichat.preferences.legacy-imported.v1:${scope}`;
    acknowledged = readCache(snapshotKey);
    pending = readCache(key);
    // Rewrite migrated legacy engines in both account caches, including offline starts.
    persistCache(snapshotKey, acknowledged);
    persistPending();
    set({ accountId: userId, data: merge(acknowledged, pending), hasPendingChanges: nonempty(pending), syncStatus: nonempty(pending) ? "pending" : "idle", legacyImportAvailable: false });
    preparation = applyData(epoch, true);
    // bindAccount is synchronous; callers may not fetch until the next render.
    // Observe preparation failures immediately while fetch still receives them.
    void preparation.catch(() => {});
  },
  fetchAndApply: async () => {
    if (!cacheKey) return;
    if (fetchPromise) return fetchPromise;
    const version = epoch;
    const run = async () => {
      try {
        await preparation;
        if (writePromise) await writePromise;
        if (!current(version)) return;
        fetchEdits = { ...pending };
        fetchAcknowledged = {};
        set({ syncStatus: "loading", syncError: null });
        const res = await preferencesApi.getPreferences(requestContext(version));
        if (!current(version)) return;
        if (res.code === "PREFERENCES_ACCOUNT_MISMATCH" || (res.data?.user_id && res.data.user_id !== get().accountId)) throw new Error("preferences_account_mismatch");
        if (!res.success) throw new Error("preferences_load_failed");
        acknowledged = merge(sanitize(res.data?.data), fetchAcknowledged);
        const data = merge(acknowledged, merge(fetchEdits, pending));
        set({
          data, isLoaded: true,
          syncStatus: nonempty(inFlight) ? "saving" : nonempty(pending) ? "pending" : "saved",
          syncError: null, hasPendingChanges: nonempty(inFlight) || nonempty(pending),
          legacyImportAvailable: canImportLegacy(data, true),
        });
        persistCache(snapshotKey, acknowledged);
        // A fresh authoritative GET may remove cached leaves; reset before applying its latest pending overlay.
        await applyData(version, true, true);
      } catch (error) {
        if (current(version)) {
          clearTimer();
          set({ syncStatus: "error", syncError: error instanceof Error && error.message === "preferences_account_mismatch" ? "preferences_account_mismatch" : "preferences_load_failed" });
        }
      }
    };
    const task = run();
    fetchPromise = task;
    await task;
    if (!current(version)) return;
    if (fetchPromise === task) fetchPromise = null;
    fetchEdits = {}; fetchAcknowledged = {};
    if (get().syncStatus !== "error" && nonempty(pending)) schedule();
  },
  retrySync: async () => {
    const version = epoch;
    clearTimer();
    if (!get().isLoaded || get().syncError === "preferences_load_failed") await get().fetchAndApply();
    if (current(version)) await flush();
  },
  importLegacyPreferences: async () => {
    const version = epoch;
    if (!get().legacyImportAvailable || !get().isLoaded) return false;
    await preparation;
    if (fetchPromise) await fetchPromise;
    if (!current(version) || !get().isLoaded || !canImportLegacy(get().data, true)) return false;
    const patch = legacyImportPatch(get().data);
    // Do not mark an import as used unless its recovery queue is safely persisted.
    if (!persistCache(cacheKey, merge(inFlight, merge(pending, patch)))) return false;
    get().set(patch);
    try { if (legacyImportKey) localStorage.setItem(legacyImportKey, "1"); } catch { /* Backup and persisted queue remain recoverable. */ }
    set({ legacyImportAvailable: false });
    await applyData(version);
    return current(version);
  },
  set: (partial) => {
    // Unauthenticated changes stay device-local in their owning stores.
    if (!cacheKey) return;
    const patch = sanitize(partial);
    if (!nonempty(patch)) return;
    pending = merge(pending, patch);
    if (fetchPromise) fetchEdits = merge(fetchEdits, patch);
    const data = merge(get().data, patch);
    set({ data, syncStatus: writePromise ? "saving" : "pending", syncError: null, hasPendingChanges: true, legacyImportAvailable: canImportLegacy(data, get().isLoaded) });
    persistPending();
    schedule();
  },
  get: <T = unknown>(key: string): T | undefined => get().data[key] as T | undefined,
  reset: () => {
    preserveLegacyPreferences();
    // Cache old-account pending data, never dispatch it under new credentials.
    persistPending();
    epoch += 1;
    controller.abort();
    controller = new AbortController();
    clearTimer();
    cacheKey = null; snapshotKey = null; legacyImportKey = null;
    acknowledged = {};
    pending = {}; inFlight = {}; fetchEdits = {};
    fetchAcknowledged = {};
    fetchPromise = null; writePromise = null; preparation = Promise.resolve();
    set({ data: {}, isLoaded: false, accountId: null, syncStatus: "idle", syncError: null, hasPendingChanges: false, legacyImportAvailable: false });
  },
}));
