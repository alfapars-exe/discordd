/** Account-scoped preferences sync; queued edits survive failed requests. */
import { create } from "zustand";
import * as preferencesApi from "../api/preferences";
import { loadPreferencePresenter } from "./preferencePresenter";
import { SERVER_URL } from "../utils/constants";

import { decodeLegacyAppearance, object, sanitize, merge, nonempty, cacheable, type PreferencesData } from "./preferencesCodec";

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

const CACHE_LIMIT = 64 * 1024;
const LEGACY_BACKUP_KEY = "hichat.preferences.legacy-presentation.v1";
const LEGACY_APPEARANCE_KEYS: Record<string, string> = {
  blurEnabled: "mqvi_blur_enabled", blurStrength: "mqvi_blur_strength", wallpaperEnabled: "mqvi_wallpaper_enabled",
  lightningEnabled: "mqvi_lightning_enabled", lightningBlur: "mqvi_lightning_blur", neonEnabled: "mqvi_neon_enabled",
  neonIntensity: "mqvi_neon_intensity", uiScale: "mqvi_ui_scale", avatarAnimation: "hichat-avatar-animation",
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
        const value = decodeLegacyAppearance(field, raw);
        if (value !== undefined) appearance[field] = value;
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

async function applyData(version: number, reset = false, preserveSessionState = false): Promise<void> {
  const applyAccountPreferences = await loadPreferencePresenter();
  if (!current(version)) return;
  applyAccountPreferences(
    () => current(version) ? cacheable(usePreferencesStore.getState().data) : null,
    reset,
    preserveSessionState,
  );
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

/** Includes queued preference edits without copying auth storage or store methods. */
export function preferencesForDeviceHandoff(ownerId:string):Record<string,unknown>{
 const state=usePreferencesStore.getState();
 if(state.accountId!==ownerId)throw new Error('handoff_preferences_account_mismatch');
 return cacheable(merge(merge(state.data,inFlight),pending));
}
