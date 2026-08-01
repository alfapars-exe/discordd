/**
 * E2EE Store — E2EE state management.
 */

import { create } from "zustand";
import * as deviceManager from "../crypto/deviceManager";
import * as keyBackup from "../crypto/keyBackup";
import * as keyStorage from "../crypto/keyStorage";
import * as signalProtocol from "../crypto/signalProtocol";
import * as e2eeApi from "../api/e2ee";
import type { DeviceInfo } from "../types";
import { useMessageStore } from "./messageStore";
import { useDMStore } from "./dmStore";
import { useChannelStore } from "./channelStore";
import { useServerStore } from "./serverStore";

// ──────────────────────────────────
// Types
// ──────────────────────────────────

export type E2EEInitStatus =
  | "uninitialized"
  | "initializing"
  | "ready"
  | "error";

export type DecryptionError = {
  messageId: string;
  channelId: string;
  error: string;
  timestamp: number;
};

/**
 * - identity_changed: a pinned peer identity key was replaced (possible MITM).
 * - new_device: a peer's device set gained a device we never pinned.
 * - own_new_device: the server listed a device under OUR OWN account that we
 *   never pinned. Distinct from new_device because the blast radius differs:
 *   the self-fanout loop encrypts a copy of every outgoing DM for it, so an
 *   injected row here reads everything we send, in every conversation.
 */
export type PeerTrustAlertKind =
  | "identity_changed"
  | "new_device"
  | "own_new_device";

export type PeerTrustAlert = {
  userId: string;
  deviceId: string;
  /** For own_new_device, userId is the local user's own id. */
  kind: PeerTrustAlertKind;
  /** base64 X25519 public — only set for identity_changed */
  previousKey?: string;
  /** base64 X25519 public — only set for identity_changed */
  newKey?: string;
  detectedAt: number;
};

type E2EEState = {
  initStatus: E2EEInitStatus;
  /** null = not yet registered */
  localDeviceId: string | null;
  devices: DeviceInfo[];
  hasRecoveryBackup: boolean;
  decryptionErrors: DecryptionError[];
  isGeneratingKeys: boolean;
  initError: string | null;
  /** Show non-blocking recovery password prompt when E2EE first becomes relevant. */
  showRecoveryPrompt: boolean;
  /** Whether the user dismissed the recovery prompt in this session. */
  recoveryPromptDismissed: boolean;
  /**
   * Peer devices that ship the pre-C5 key bundle shape (no Ed25519
   * signing_key). encryptDMMessage flags them on first contact via
   * LegacyDeviceError; the UI renders an "incompatible device" banner
   * for the affected conversation. Keyed by "userId:deviceId".
   */
  incompatibleDevices: Set<string>;
  /**
   * Peer devices whose identity key changed (possible MITM) or that were
   * newly seen for the first time. Fed by signalProtocol's identity-key
   * change queue. Keyed by "userId:deviceId".
   */
  peerTrustAlerts: Record<string, PeerTrustAlert>;

  // ─── Actions ───

  initialize: (userId: string) => Promise<void>;
  setupNewDevice: (userId: string, displayName?: string) => Promise<void>;
  restoreFromRecovery: (password: string) => Promise<boolean>;
  setRecoveryPassword: (password: string) => Promise<void>;
  completeRecoverySetup: (password: string) => Promise<void>;
  /** Check if recovery password prompt should be shown (E2EE active + no backup). */
  checkAndPromptRecovery: () => void;
  dismissRecoveryPrompt: () => void;
  fetchDevices: () => Promise<void>;
  removeDevice: (deviceId: string) => Promise<void>;
  addDecryptionError: (error: DecryptionError) => void;
  clearDecryptionErrors: (channelId: string) => void;
  /** Generate and upload new prekey batch when server signals low count. */
  handlePrekeyLow: () => Promise<void>;
  /** Record a peer device that uses the legacy (pre-C5) bundle format. */
  markIncompatibleDevice: (userId: string, deviceId: string) => void;
  /** Clear the incompatible mark — call after the peer re-registers. */
  clearIncompatibleDevice: (userId: string, deviceId: string) => void;
  /** Record a peer trust alert (identity change or new device). */
  markPeerTrustAlert: (alert: PeerTrustAlert) => void;
  /** Clear a peer trust alert — call after the user acknowledges it. */
  clearPeerTrustAlert: (userId: string, deviceId: string) => void;
  /** Load persisted peer trust alerts from IndexedDB. */
  loadPeerTrustAlerts: () => Promise<void>;
  /** Reset Zustand state on logout. IndexedDB keys are preserved. */
  reset: () => Promise<void>;
};

/**
 * Upper bound on retained peer trust alerts.
 *
 * The receive path writes this map from server-delivered envelopes, so its
 * growth is attacker-influenced: without a cap it is unbounded IndexedDB state
 * plus alarm fatigue burying the one warning that matters. Mirrors the
 * 500-entry cap on decryptionErrors.
 */
const PEER_TRUST_ALERT_LIMIT = 200;

/**
 * Overwrite order for two alerts sharing one "userId:deviceId" key.
 *
 * Typed as a total Record over the union on purpose: adding a kind without
 * deciding where it ranks is a compile error, not a silent 0.
 */
const ALERT_KIND_SEVERITY: Record<PeerTrustAlertKind, number> = {
  new_device: 0,
  own_new_device: 1,
  identity_changed: 2,
};

/**
 * Kinds that survive the PEER_TRUST_ALERT_LIMIT trim while cheaper alerts
 * remain droppable.
 *
 * new_device is the only attacker-cheap kind: a hostile server mints it by
 * listing devices for any peer. The two protected kinds each name a concrete
 * compromise of THIS user — a replaced identity key, or a device added to
 * their own account that receives a copy of every DM they send — so neither
 * may be pushed out of the map by peer-device noise. Distinct from
 * ALERT_KIND_SEVERITY: that ranks overwrites of one key, this ranks eviction
 * across keys, and own_new_device sits at the top of this one.
 */
const EVICTION_PROTECTED_KINDS: ReadonlySet<PeerTrustAlertKind> = new Set([
  "identity_changed",
  "own_new_device",
]);

// ──────────────────────────────────
// Store
// ──────────────────────────────────

export const useE2EEStore = create<E2EEState>((set, get) => ({
  initStatus: "uninitialized",
  localDeviceId: null,
  devices: [],
  hasRecoveryBackup: false,
  decryptionErrors: [],
  isGeneratingKeys: false,
  initError: null,
  showRecoveryPrompt: false,
  recoveryPromptDismissed: false,
  incompatibleDevices: new Set(),
  peerTrustAlerts: {},

  initialize: async (userId: string) => {
    const current = get().initStatus;
    if (current === "initializing" || current === "ready") return;

    set({ initStatus: "initializing", initError: null });

    try {
      let hasKeys = await keyStorage.hasLocalKeys();

      // Clear keys if logged in as a different user
      if (hasKeys) {
        const registration = await keyStorage.getRegistrationData();
        if (registration && registration.userId !== userId) {
          await keyStorage.clearAllE2EEData();
          hasKeys = false;
          // Trust alerts belong to the account that was just wiped: they carry
          // that account's contacts' userIds and identity keys. The in-memory
          // copy has to go too, otherwise the next markPeerTrustAlert writes
          // user A's alerts back into user B's freshly cleared metadata store.
          set({ peerTrustAlerts: {} });
        }
      }

      // Background: restore peer trust alerts persisted by an earlier session.
      //
      // Deliberately started AFTER the account check above. Kicked off earlier
      // (it is intentionally not awaited) the read races clearAllE2EEData and,
      // when it wins, resurrects user A's alerts inside user B's session.
      get().loadPeerTrustAlerts();

      if (hasKeys) {
        const deviceId = await deviceManager.getLocalDeviceId();

        // Re-register if server lost this device (DB reset, manual deletion).
        // Without this: prekey upload FK error + other devices can't create envelopes.
        if (deviceId) {
          try {
            const devicesRes = await e2eeApi.listMyDevices();
            const existsOnServer = devicesRes.success && devicesRes.data?.some(
              (d) => d.device_id === deviceId
            );
            if (!existsOnServer) {
              await deviceManager.reRegisterDevice(deviceId);
            }
          } catch {
            // Network error — will retry during prekey refresh
          }
        }

        set({
          initStatus: "ready",
          localDeviceId: deviceId,
        });

        // Background: prekey check + device list + backup status + deferred recovery prompt
        get().handlePrekeyLow();
        get().fetchDevices();
        checkRecoveryBackup(set);
        scheduleDeferredRecoveryCheck(get);
      } else {
        // No local keys — check backup status (don't block on it).
        // Even if backup exists, silently generate new keys so the app is usable immediately.
        // If E2EE is active, the non-blocking recovery prompt will offer restore option.
        // This prevents the blocking modal for users who never used E2EE but had
        // a backup from the old mandatory recovery password flow.
        try {
          const backupRes = await e2eeApi.downloadKeyBackup();
          if (backupRes.success && backupRes.data) {
            set({ hasRecoveryBackup: true });
          }
        } catch {
          // Non-critical — continue
        }

        await get().setupNewDevice(userId);
        scheduleDeferredRecoveryCheck(get);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "E2EE initialization failed";
      console.error("[e2eeStore] initialize error:", message);
      set({
        initStatus: "error",
        initError: message,
      });
    }
  },

  setupNewDevice: async (userId: string, displayName?: string) => {
    set({ isGeneratingKeys: true, initError: null });

    try {
      const deviceId = await deviceManager.registerNewDevice(
        userId,
        displayName
      );

      set({
        initStatus: "ready",
        localDeviceId: deviceId,
        isGeneratingKeys: false,
      });

      get().fetchDevices();

      // Invalidate message cache so messages get re-decrypted
      useMessageStore.getState().invalidateFetchCache();
      useDMStore.getState().invalidateFetchCache();

      const activeChannelId = useChannelStore.getState().selectedChannelId;
      if (activeChannelId) {
        useMessageStore.getState().fetchMessages(activeChannelId);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Device setup failed";
      console.error("[e2eeStore] setupNewDevice error:", message);
      set({
        initError: message,
        isGeneratingKeys: false,
      });
    }
  },

  restoreFromRecovery: async (password: string) => {
    set({ isGeneratingKeys: true, initError: null });

    try {
      const response = await e2eeApi.downloadKeyBackup();
      if (!response.success || !response.data) {
        set({
          initError: "No backup found on server",
          isGeneratingKeys: false,
        });
        return false;
      }

      const restored = await keyBackup.restoreFromBackup(
        {
          encryptedData: response.data.encrypted_data,
          nonce: response.data.nonce,
          salt: response.data.salt,
          // Pass algorithm so legacy (1M iter) vs new (2M iter) backups
          // both decrypt correctly. See keyBackup.ts:parseAlgorithm.
          algorithm: response.data.algorithm,
        },
        password
      );

      if (!restored) {
        set({
          initError: "Invalid recovery password",
          isGeneratingKeys: false,
        });
        return false;
      }

      // New device ID for self-fanout; legacy ID kept for old envelope matching.
      const newDeviceId = await deviceManager.registerRestoredDevice();

      set({
        initStatus: "ready",
        localDeviceId: newDeviceId,
        hasRecoveryBackup: true,
        isGeneratingKeys: false,
      });

      get().handlePrekeyLow();
      get().fetchDevices();

      // Invalidate cache — messages will now decrypt with restored keys
      useMessageStore.getState().invalidateFetchCache();
      useDMStore.getState().invalidateFetchCache();

      const activeChannelId = useChannelStore.getState().selectedChannelId;
      if (activeChannelId) {
        useMessageStore.getState().fetchMessages(activeChannelId);
      }

      return true;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Recovery failed";
      console.error("[e2eeStore] restoreFromRecovery error:", message);
      set({
        initError: message,
        isGeneratingKeys: false,
      });
      return false;
    }
  },

  setRecoveryPassword: async (password: string) => {
    try {
      const backup = await keyBackup.createBackup(password);

      const response = await e2eeApi.uploadKeyBackup({
        version: backup.version,
        algorithm: backup.algorithm,
        encrypted_data: backup.encryptedData,
        nonce: backup.nonce,
        salt: backup.salt,
      });

      if (!response.success) {
        throw new Error(response.error ?? "Failed to upload key backup");
      }

      set({ hasRecoveryBackup: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to set recovery password";
      console.error("[e2eeStore] setRecoveryPassword error:", message);
      throw err;
    }
  },

  completeRecoverySetup: async (password: string) => {
    await get().setRecoveryPassword(password);
    set({ showRecoveryPrompt: false });
  },

  checkAndPromptRecovery: () => {
    const { initStatus, hasRecoveryBackup, recoveryPromptDismissed, showRecoveryPrompt } = get();
    if (initStatus !== "ready" || hasRecoveryBackup || recoveryPromptDismissed || showRecoveryPrompt) return;

    // Check if any DM channel or the active server has E2EE enabled
    const dmChannels = useDMStore.getState().channels;
    const activeServer = useServerStore.getState().activeServer;

    const hasE2EEActivity =
      dmChannels.some((ch) => ch.e2ee_enabled) ||
      (activeServer?.e2ee_enabled === true);

    if (hasE2EEActivity) {
      set({ showRecoveryPrompt: true });
    }
  },

  dismissRecoveryPrompt: () => {
    set({ showRecoveryPrompt: false, recoveryPromptDismissed: true });
  },

  fetchDevices: async () => {
    try {
      const response = await e2eeApi.listMyDevices();
      if (response.success && response.data) {
        set({ devices: response.data });
      }
    } catch (err) {
      console.error("[e2eeStore] fetchDevices error:", err);
    }
  },

  removeDevice: async (deviceId: string) => {
    try {
      const response = await e2eeApi.removeDevice(deviceId);
      if (response.success) {
        set((state) => ({
          devices: state.devices.filter((d) => d.device_id !== deviceId),
        }));
      }
    } catch (err) {
      console.error("[e2eeStore] removeDevice error:", err);
      throw err;
    }
  },

  addDecryptionError: (error: DecryptionError) => {
    set((state) => {
      const currentErrors = state.decryptionErrors;
      if (currentErrors.length >= 500) {
        const nextErrors = currentErrors.slice(1);
        nextErrors.push(error);
        return { decryptionErrors: nextErrors };
      }
      return { decryptionErrors: [...currentErrors, error] };
    });
  },

  clearDecryptionErrors: (channelId: string) => {
    set((state) => ({
      decryptionErrors: state.decryptionErrors.filter(
        (e) => e.channelId !== channelId
      ),
    }));
  },

  handlePrekeyLow: async () => {
    const deviceId = get().localDeviceId;
    if (!deviceId) return;

    try {
      await deviceManager.refreshPreKeys(deviceId);
    } catch (err) {
      console.error("[e2eeStore] handlePrekeyLow error:", err);
    }
  },

  markIncompatibleDevice: (userId: string, deviceId: string) => {
    set((state) => {
      const key = `${userId}:${deviceId}`;
      if (state.incompatibleDevices.has(key)) {
        // Already flagged — avoid re-rendering subscribers.
        return state;
      }
      const next = new Set(state.incompatibleDevices);
      next.add(key);
      return { incompatibleDevices: next };
    });
  },

  clearIncompatibleDevice: (userId: string, deviceId: string) => {
    set((state) => {
      const key = `${userId}:${deviceId}`;
      if (!state.incompatibleDevices.has(key)) return state;
      const next = new Set(state.incompatibleDevices);
      next.delete(key);
      return { incompatibleDevices: next };
    });
  },

  markPeerTrustAlert: (alert: PeerTrustAlert) => {
    const key = `${alert.userId}:${alert.deviceId}`;
    const current = get().peerTrustAlerts;
    const existing = current[key];
    if (existing?.kind === alert.kind) {
      // Already flagged with the same kind — avoid re-rendering subscribers.
      return;
    }
    // A more severe kind may overwrite a less severe one, never the reverse:
    // a plain new_device sighting must not erase an outstanding
    // identity_changed (possible MITM) or own_new_device (device injected into
    // our own account) warning the user has not acknowledged yet.
    if (
      existing &&
      ALERT_KIND_SEVERITY[alert.kind] < ALERT_KIND_SEVERITY[existing.kind]
    ) {
      return;
    }
    const next = capPeerTrustAlerts({ ...current, [key]: alert });
    set({ peerTrustAlerts: next });
    // Persist AFTER the commit, from the action body — never from inside a
    // set() updater. Zustand does not re-run updaters today, but a persist
    // launched from inside one makes two marks in the same tick start two
    // independent full-map writes whose completion order is unspecified, and
    // a lost write silently drops an alert the user never acknowledged.
    void persistPeerTrustAlerts(next);
  },

  clearPeerTrustAlert: (userId: string, deviceId: string) => {
    const key = `${userId}:${deviceId}`;
    const current = get().peerTrustAlerts;
    if (!(key in current)) return;
    const next = { ...current };
    delete next[key];
    set({ peerTrustAlerts: next });
    void persistPeerTrustAlerts(next);
  },

  loadPeerTrustAlerts: async () => {
    try {
      const stored = await keyStorage.getMetadata<Record<string, PeerTrustAlert>>(
        "peer_trust_alerts"
      );
      if (stored) {
        set({ peerTrustAlerts: stored });
      }
    } catch (err) {
      console.error("[e2eeStore] loadPeerTrustAlerts error:", err);
    }
  },

  reset: async () => {
    // Only reset Zustand state on logout.
    // IndexedDB keys and server device registration are PRESERVED
    // so re-login on the same device doesn't require key restore.
    // Device removal is done explicitly via Settings > Encryption.
    set({
      initStatus: "uninitialized",
      localDeviceId: null,
      devices: [],
      hasRecoveryBackup: false,
      decryptionErrors: [],
      isGeneratingKeys: false,
      initError: null,
      showRecoveryPrompt: false,
      recoveryPromptDismissed: false,
      incompatibleDevices: new Set(),
      peerTrustAlerts: {},
    });
  },
}));

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

/** Check recovery backup status in background. Silently continues on error. */
async function checkRecoveryBackup(
  set: (partial: Partial<E2EEState>) => void
): Promise<void> {
  try {
    const response = await e2eeApi.downloadKeyBackup();
    if (response.success && response.data) {
      set({ hasRecoveryBackup: true });
    }
  } catch {
    // Non-critical — silently continue
  }
}

/**
 * Schedule a deferred recovery prompt check.
 * DM channels and servers may not be loaded yet when init completes,
 * so we wait a few seconds for stores to populate from the WS ready event.
 */
function scheduleDeferredRecoveryCheck(
  get: () => E2EEState
): void {
  setTimeout(() => {
    get().checkAndPromptRecovery();
  }, 5000);
}

/**
 * True when `candidate` should be evicted before `incumbent`.
 *
 * Severity first, age second: a protected alert (see EVICTION_PROTECTED_KINDS)
 * is only ever dropped when there is no unprotected alert left to drop, so a
 * flood of cheap new-device noise cannot push a safety-number change — or a
 * device injected into the user's own account — out of the map.
 */
function isPreferredEviction(
  candidate: PeerTrustAlert,
  incumbent: PeerTrustAlert
): boolean {
  const candidateIsNoise = !EVICTION_PROTECTED_KINDS.has(candidate.kind);
  const incumbentIsNoise = !EVICTION_PROTECTED_KINDS.has(incumbent.kind);
  if (candidateIsNoise !== incumbentIsNoise) return candidateIsNoise;
  return candidate.detectedAt < incumbent.detectedAt;
}

/**
 * Trim the alert map back to PEER_TRUST_ALERT_LIMIT entries, oldest-first
 * within the severity order defined by isPreferredEviction.
 *
 * Returns the input untouched when it already fits, so the common path costs
 * one key count and allocates nothing.
 */
function capPeerTrustAlerts(
  alerts: Record<string, PeerTrustAlert>
): Record<string, PeerTrustAlert> {
  let remaining = Object.keys(alerts).length;
  if (remaining <= PEER_TRUST_ALERT_LIMIT) return alerts;

  const next = { ...alerts };
  while (remaining > PEER_TRUST_ALERT_LIMIT) {
    let victim: string | null = null;
    for (const key of Object.keys(next)) {
      if (victim === null || isPreferredEviction(next[key], next[victim])) {
        victim = key;
      }
    }
    if (victim === null) break;
    delete next[victim];
    remaining -= 1;
  }
  return next;
}

/** Persist peer trust alerts to IndexedDB. Fire-and-forget; errors are logged. */
async function persistPeerTrustAlerts(
  alerts: Record<string, PeerTrustAlert>
): Promise<void> {
  try {
    await keyStorage.setMetadata("peer_trust_alerts", alerts);
  } catch (err) {
    console.error("[e2eeStore] persistPeerTrustAlerts error:", err);
  }
}

// ──────────────────────────────────
// Identity Key Change Ingestion
// ──────────────────────────────────

/**
 * Drain signalProtocol's pending identity-key-change queue and surface each
 * entry as a peer trust alert. Called on module load (to flush anything that
 * accumulated before this store existed) and on every subsequent change.
 */
function ingestIdentityKeyChanges(): void {
  for (const change of signalProtocol.drainIdentityKeyChanges()) {
    useE2EEStore.getState().markPeerTrustAlert({
      userId: change.userId,
      deviceId: change.deviceId,
      kind: "identity_changed",
      previousKey: change.previousKey,
      newKey: change.newKey,
      detectedAt: change.detectedAt,
    });
  }
}
signalProtocol.onIdentityKeyChange(ingestIdentityKeyChanges);
ingestIdentityKeyChanges();
