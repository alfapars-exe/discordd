/** Account-scoped preferences sync; queued edits survive failed requests. */
import { completePreferenceMutation } from "./preferenceMutation";
import { create } from "zustand";
import * as preferencesApi from "../api/preferences";
import { loadPreferencePresenter } from "./preferencePresenter";
import { APPEARANCE_STORAGE_KEYS } from "./appearancePreferences";
import { SERVER_URL } from "../utils/constants";
import { getPreferenceScopeGeneration, retirePreferenceScope } from "./preferenceScope";

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
const DEBOUNCE_MS = 1000;
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
type PresentationPlan = { reset: boolean; preserveSessionState: boolean };
class PreferencePresentationError extends Error {
  readonly plan: PresentationPlan;
  constructor(plan: PresentationPlan, cause?: unknown) { super("preferences_apply_failed", { cause }); this.plan = plan; }
}
let presentationRetry: (PresentationPlan & { preparation: boolean }) | null = null;
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
      for (const [field, key] of Object.entries(APPEARANCE_STORAGE_KEYS)) {
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
function current(version: number): boolean { return getPreferenceScopeGeneration() === version && cacheKey !== null; }
function canImportLegacyForCurrentScope(version: number): boolean {
  if (!current(version)) return false;
  const state = usePreferencesStore.getState();
  return state.isLoaded && state.syncError !== "preferences_account_mismatch" && canImportLegacy(state.data, true);
}

function retainLegacyPresentationRetry(version: number, queued: boolean, error: unknown): void {
  if (!current(version) || !queued) return;
  clearTimer();
  presentationRetry = { ...(error instanceof PreferencePresentationError ? error.plan : { reset: false, preserveSessionState: false }), preparation: false };
  usePreferencesStore.setState({ syncStatus: "error", syncError: "preferences_apply_failed", hasPendingChanges: nonempty(inFlight) || nonempty(pending) });
}

function clearTimer(): void { if (timer) clearTimeout(timer); timer = null; }
function requestContext(version: number) {
  return {
    expectedUserId: usePreferencesStore.getState().accountId ?? undefined,
    isCurrent: () => current(version),
    signal: controller.signal,
  };
}

async function applyData(version: number, reset = false, preserveSessionState = false): Promise<void> {
  try {
    const applyAccountPreferences = await loadPreferencePresenter();
    if (!current(version)) return;
    applyAccountPreferences(
      () => current(version) ? cacheable(usePreferencesStore.getState().data) : null,
      reset,
      preserveSessionState,
    );
  } catch (error) {
    if (current(version)) throw new PreferencePresentationError({ reset, preserveSessionState }, error);
  }
}
function schedule(): void {
  clearTimer();
  const version = getPreferenceScopeGeneration();
  const scheduled = setTimeout(() => {
    if (!current(version) || timer !== scheduled) return;
    timer = null;
    void flush().catch(() => {
      if (current(version)) console.error("[preferences] background_flush_failed");
    });
  }, DEBOUNCE_MS);
  timer = scheduled;
}

function validatePreferenceResponse(
  response: Awaited<ReturnType<typeof preferencesApi.updatePreferences>>,
  accountId: string | null,
  failure: "preferences_save_failed" | "preferences_load_failed",
): void {
  if (response.code === "PREFERENCES_ACCOUNT_MISMATCH" || (response.data?.user_id && response.data.user_id !== accountId)) {
    throw new Error("preferences_account_mismatch");
  }
  if (!response.success) throw new Error(failure);
}

function handlePreferenceWriteFailure(version: number, sent: PreferencesData, accepted: boolean, error: unknown): void {
  if (!current(version)) return;
  clearTimer();
  if (accepted) {
    // The server already committed this patch. A local presenter failure
    // must not turn it back into an outbound edit or overwrite newer data
    // on retry. Keep only edits queued after the acknowledged request.
    presentationRetry = { ...(error instanceof PreferencePresentationError ? error.plan : { reset: false, preserveSessionState: false }), preparation: false };
    usePreferencesStore.setState({ syncStatus: "error", syncError: "preferences_apply_failed", hasPendingChanges: nonempty(pending) });
    return;
  }
  pending = merge(sent, pending);
  inFlight = {};
  persistPending();
  if (error instanceof PreferencePresentationError) presentationRetry = { ...error.plan, preparation: false };
  const syncError = error instanceof PreferencePresentationError ? "preferences_apply_failed" :
    error instanceof Error && error.message === "preferences_account_mismatch" ? "preferences_account_mismatch" : "preferences_save_failed";
  usePreferencesStore.setState({ syncStatus: "error", syncError, hasPendingChanges: true });
}

async function flush(): Promise<void> {
  if (!cacheKey) return;
  if (writePromise) return writePromise;
  const version = getPreferenceScopeGeneration();
  if (!usePreferencesStore.getState().isLoaded) await usePreferencesStore.getState().fetchAndApply();
  if (!current(version) || !usePreferencesStore.getState().isLoaded || !nonempty(pending)) return;
  if (writePromise) return writePromise;
  const run = async () => {
    if (!current(version)) return;
    clearTimer();
    inFlight = pending;
    pending = {};
    const sent = inFlight;
    let accepted = false;
    try {
      persistPending();
      try { usePreferencesStore.setState({ syncStatus: "saving", syncError: null, hasPendingChanges: true }); }
      catch (error) { throw new PreferencePresentationError({ reset: false, preserveSessionState: false }, error); }
      if (!current(version)) return;
      const res = await preferencesApi.updatePreferences(sent, requestContext(version));
      if (!current(version)) return;
      validatePreferenceResponse(res, usePreferencesStore.getState().accountId, "preferences_save_failed");
      accepted = true;
      inFlight = {};
      const returned = sanitize(res.data?.data);
      acknowledged = merge(merge(acknowledged, sent), returned);
      if (fetchPromise) fetchAcknowledged = merge(fetchAcknowledged, merge(sent, returned));
      const data = merge(merge(usePreferencesStore.getState().data, returned), pending);
      // Record the validated acknowledgment before observers can throw or
      // replace the binding. Its accepted patch must not survive in the queue.
      persistCache(snapshotKey, acknowledged);
      persistPending();
      usePreferencesStore.setState({ data, syncStatus: nonempty(pending) ? "pending" : "saved", syncError: null, hasPendingChanges: nonempty(pending), legacyImportAvailable: canImportLegacy(data, true) });
      await applyData(version);
    } catch (error) {
      handlePreferenceWriteFailure(version, sent, accepted, error);
    }
  };
  // Reserve the writer before run notifies synchronous observers. Reentrant
  // retries join it; a replacement binding can retire it before any work runs.
  const task = Promise.resolve().then(run);
  writePromise = task;
  try { await task; }
  finally {
    if (current(version) && writePromise === task) {
      writePromise = null;
      if (nonempty(pending) && usePreferencesStore.getState().syncStatus !== "error") schedule();
    }
  }
}

export const usePreferencesStore = create<PreferencesState>((set, get) => ({
  data: {}, isLoaded: false, accountId: null, syncStatus: "idle", syncError: null, hasPendingChanges: false, legacyImportAvailable: false,
  bindAccount: (userId, backend = SERVER_URL) => {
    const scope = `${encodeURIComponent(backend)}:${encodeURIComponent(userId)}`;
    const key = `hichat.preferences.pending.v1:${scope}`;
    if (cacheKey === key) return;
    const previousVersion = getPreferenceScopeGeneration();
    get().reset();
    // Reset publishes too. A nested reset/bind owns the newer generation and
    // must not be overwritten when this older bind resumes.
    if (getPreferenceScopeGeneration() !== previousVersion + 1) return;
    cacheKey = key;
    snapshotKey = `hichat.preferences.snapshot.v1:${scope}`;
    legacyImportKey = `hichat.preferences.legacy-imported.v1:${scope}`;
    acknowledged = readCache(snapshotKey);
    pending = readCache(key);
    // Rewrite migrated legacy engines in both account caches, including offline starts.
    persistCache(snapshotKey, acknowledged);
    persistPending();
    // Reserve preparation before publication: an observer may throw or bind
    // another account, whose preparation must not be replaced on return.
    preparation = applyData(getPreferenceScopeGeneration(), true);
    // bindAccount is synchronous; callers may not fetch until the next render.
    // Observe preparation failures immediately while fetch still receives them.
    void preparation.catch(() => {});
    set({ accountId: userId, data: merge(acknowledged, pending), hasPendingChanges: nonempty(pending), syncStatus: nonempty(pending) ? "pending" : "idle", legacyImportAvailable: false });
  },
  fetchAndApply: async () => {
    if (!cacheKey) return;
    if (fetchPromise) return fetchPromise;
    const version = getPreferenceScopeGeneration();
    const run = async () => {
      let preparing = true;
      try {
        await preparation;
        preparing = false;
        if (writePromise) await writePromise;
        if (!current(version)) return;
        fetchEdits = { ...pending };
        fetchAcknowledged = {};
        set({ syncStatus: "loading", syncError: null });
        const res = await preferencesApi.getPreferences(requestContext(version));
        if (!current(version)) return;
        validatePreferenceResponse(res, get().accountId, "preferences_load_failed");
        acknowledged = merge(sanitize(res.data?.data), fetchAcknowledged);
        const data = merge(acknowledged, merge(fetchEdits, pending));
        persistCache(snapshotKey, acknowledged);
        try {
          set({
            data, isLoaded: true,
            syncStatus: nonempty(inFlight) ? "saving" : nonempty(pending) ? "pending" : "saved",
            syncError: null, hasPendingChanges: nonempty(inFlight) || nonempty(pending),
            legacyImportAvailable: canImportLegacy(data, true),
          });
        } catch (error) {
          throw new PreferencePresentationError({ reset: true, preserveSessionState: true }, error);
        }
        // A fresh authoritative GET may remove cached leaves; reset before applying its latest pending overlay.
        await applyData(version, true, true);
      } catch (error) {
        if (current(version)) {
          clearTimer();
          if (error instanceof PreferencePresentationError) {
            presentationRetry = { ...error.plan, preparation: preparing };
            set({ syncStatus: "error", syncError: "preferences_apply_failed" });
          } else {
            set({ syncStatus: "error", syncError: error instanceof Error && error.message === "preferences_account_mismatch" ? "preferences_account_mismatch" : "preferences_load_failed" });
          }
        }
      }
    };
    const task = run();
    fetchPromise = task;
    try { await task; }
    finally {
      if (current(version) && fetchPromise === task) {
        fetchPromise = null;
        fetchEdits = {}; fetchAcknowledged = {};
        if (get().syncStatus !== "error" && nonempty(pending)) schedule();
      }
    }
  },
  retrySync: async () => {
    const version = getPreferenceScopeGeneration();
    clearTimer();
    if (get().syncError === "preferences_apply_failed") {
      const plan = presentationRetry ?? { reset: false, preserveSessionState: false, preparation: false };
      try {
        const applying = applyData(version, plan.reset, plan.preserveSessionState);
        // A failed initial presenter must be replaced, not awaited forever.
        if (plan.preparation) preparation = applying;
        await applying;
      } catch {
        if (current(version)) set({ syncStatus: "error", syncError: "preferences_apply_failed" });
        return;
      }
      if (!current(version)) return;
      presentationRetry = null;
      set({ syncStatus: get().isLoaded ? nonempty(pending) ? "pending" : "saved" : "idle", syncError: null });
    }
    if (!get().isLoaded || get().syncError === "preferences_load_failed") await get().fetchAndApply();
    if (current(version)) await flush();
  },
  importLegacyPreferences: async () => {
    const version = getPreferenceScopeGeneration();
    if (!get().legacyImportAvailable || !get().isLoaded || get().syncError === "preferences_account_mismatch") return false;
    let queued = false;
    try {
      await preparation;
      if (!current(version)) return false;
      if (fetchPromise) await fetchPromise;
      if (!canImportLegacyForCurrentScope(version)) return false;
      const patch = legacyImportPatch(get().data);
      // Record assignment only after the recovery queue is durable, but before
      // observers can replace the account/marker key during publication.
      if (!persistCache(cacheKey, merge(inFlight, merge(pending, patch)))) return false;
      queued = true;
      const importedKey = legacyImportKey;
      try { if (importedKey) localStorage.setItem(importedKey, "1"); } catch { /* Queue and backup remain recoverable. */ }
      get().set(patch);
      if (!current(version)) return false;
      await applyData(version);
      return current(version);
    } catch (error) {
      retainLegacyPresentationRetry(version, queued, error);
      return false;
    }
  },
  set: (partial) => {
    // Unauthenticated changes stay device-local in their owning stores.
    if (!cacheKey) return;
    const version = getPreferenceScopeGeneration();
    const patch = sanitize(partial);
    if (!nonempty(patch)) return;
    pending = merge(pending, patch);
    if (fetchPromise) fetchEdits = merge(fetchEdits, patch);
    const data = merge(get().data, patch);
    completePreferenceMutation(
      () => set({ data, syncStatus: writePromise ? "saving" : "pending", syncError: null, hasPendingChanges: true, legacyImportAvailable: canImportLegacy(data, get().isLoaded) }),
      () => { if (current(version)) { persistPending(); schedule(); } },
    );
  },
  get: <T = unknown>(key: string): T | undefined => get().data[key] as T | undefined,
  reset: () => {
    preserveLegacyPreferences();
    // Cache old-account pending data, never dispatch it under new credentials.
    persistPending();
    retirePreferenceScope();
    controller.abort();
    controller = new AbortController();
    clearTimer();
    cacheKey = null; snapshotKey = null; legacyImportKey = null;
    acknowledged = {};
    pending = {}; inFlight = {}; fetchEdits = {};
    fetchAcknowledged = {};
    fetchPromise = null; writePromise = null; preparation = Promise.resolve(); presentationRetry = null;
    set({ data: {}, isLoaded: false, accountId: null, syncStatus: "idle", syncError: null, hasPendingChanges: false, legacyImportAvailable: false });
  },
}));

/** Includes queued preference edits without copying auth storage or store methods. */
export function preferencesForDeviceHandoff(ownerId:string):Record<string,unknown>{
 const state=usePreferencesStore.getState();
 if(state.accountId!==ownerId)throw new Error('handoff_preferences_account_mismatch');
 return cacheable(merge(merge(state.data,inFlight),pending));
}
