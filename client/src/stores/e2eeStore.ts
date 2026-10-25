/**
 * E2EE Store — E2EE state management.
 */

import { create } from "zustand";
import { getAuthSessionSnapshot, subscribeAuthOwnerChanges, subscribeAuthGenerationChanges } from "../api/authSessionEvents";
import { inspectLegacyKeyArchive, importLegacyKeyArchive, type LegacyArchiveInspection } from "../crypto/legacyKeyArchive";
import * as deviceManager from "../crypto/deviceManager";
import * as keyBackup from "../crypto/keyBackup";
import * as keyStorage from "../crypto/keyStorage";
import {
  checkRecoveryPassphrase,
  WeakRecoveryPassphraseError,
} from "../crypto/recoveryPassphrase";
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
  | "legacy-recovery"
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
  legacyArchive: LegacyArchiveInspection | null;
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
  resolveLegacyArchive: (choice: "import" | "fresh") => Promise<boolean>;
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
  legacyArchive: null,
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
    const session = getAuthSessionSnapshot();
    if (session.ownerId !== userId) return;
    const isCurrent = () => {
      const latest = getAuthSessionSnapshot();
      return latest.ownerId === userId && latest.generation === session.generation;
    };
    const current = get().initStatus;
    if (current === "initializing" || current === "ready") return;
    const previousArchive = get().legacyArchive;

    set({ initStatus: previousArchive ? "legacy-recovery" : "initializing", initError: null });

    try {
      const hasKeys = await keyStorage.hasLocalKeys();
      if (!isCurrent()) return;

      // Scoped storage must never contain another account's registration.
      // Preserve it for recovery rather than silently deleting key material.
      if (hasKeys) {
        const registration = await keyStorage.getRegistrationData();
        if (!isCurrent()) return;
        if (registration && registration.userId !== userId) {
          set({ initStatus: "error", initError: "Local key registration does not match this account", peerTrustAlerts: {} });
          return;
        }
      }

      if (!hasKeys) {
        const decision = await keyStorage.getMetadata<string>("legacyArchiveDecision.v1");
        if (!isCurrent()) return;
        if (decision !== "fresh") {
          const archive = await inspectLegacyKeyArchive();
          if (!isCurrent()) return;
          if (archive.status === "eligible" || archive.status === "unverified" || previousArchive) {
            set({ initStatus: "legacy-recovery", legacyArchive: archive });
            return;
          }
        }
      }

      // Background: restore peer trust alerts persisted by an earlier session.
      //
      // Deliberately started AFTER the account check above. Kicked off earlier
      // (it is intentionally not awaited) the read races clearAllE2EEData and,
      // when it wins, resurrects user A's alerts inside user B's session.
      get().loadPeerTrustAlerts();

      if (hasKeys) {
        let deviceId = await deviceManager.getLocalDeviceId();
        if (!isCurrent()) return;

        // Recover a lost device id from the registration record.
        //
        // hasLocalKeys() only checks identity+registration, while
        // getLocalDeviceId() reads ONLY metadata["deviceId"]. Those can
        // disagree — an aborted backup restore used to wipe metadata without
        // restoring it (security scan 2026-07-31, finding N-22) — and the
        // disagreement is silent and terminal: init reports "ready" with a
        // null device id, every DM decrypt bails on it, outgoing envelopes
        // carry sender_device_id null, and no code path re-registers because
        // they all guard on the same null. registration.deviceId is the same
        // value written next to it at registration time, so prefer repairing
        // over stranding the device.
        if (!deviceId) {
          const registration = await keyStorage.getRegistrationData();
          if (!isCurrent()) return;
          if (registration?.deviceId) {
            await keyStorage.setMetadata("deviceId", registration.deviceId);
            if (!isCurrent()) return;
            deviceId = registration.deviceId;
          }
        }

        // Re-register if server lost this device (DB reset, manual deletion).
        // Without this: prekey upload FK error + other devices can't create envelopes.
        if (deviceId) {
          let devicesRes: Awaited<ReturnType<typeof e2eeApi.listMyDevices>> | undefined;
          try {
            devicesRes = await e2eeApi.listMyDevices();
            if (!isCurrent()) return;
          } catch {
            if (!isCurrent()) return;
            // Offline local decryption remains available. A failed lookup is
            // not evidence that this device vanished and must be overwritten.
          }
          if (devicesRes?.success && Array.isArray(devicesRes.data)) {
            const registered = devicesRes.data.find((device) => device.device_id === deviceId);
            if (registered) {
              const identity = await keyStorage.getIdentityKeyPair();
              if (!isCurrent()) return;
              if (!identity || registered.user_id !== userId || registered.identity_key !== signalProtocol.toBase64(identity.publicKey)) {
                throw new Error("Local device identity does not match the authenticated account");
              }
            } else {
              await deviceManager.reRegisterDevice(deviceId);
              if (!isCurrent()) return;
            }
          }
        } else throw new Error("Local device registration is incomplete");

        set({
          initStatus: "ready",
          localDeviceId: deviceId,
          legacyArchive: null,
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
          if (!isCurrent()) return;
          if (backupRes.success && backupRes.data) {
            set({ hasRecoveryBackup: true });
          }
        } catch {
          if (!isCurrent()) return;
          // Non-critical — continue
        }

        await get().setupNewDevice(userId);
        if (!isCurrent()) return;
        scheduleDeferredRecoveryCheck(get);
      }
    } catch (err) {
      if (!isCurrent()) return;
      const message =
        err instanceof Error ? err.message : "E2EE initialization failed";
      console.error("[e2eeStore] initialize error:", message);
      set({
        initStatus: previousArchive ? "legacy-recovery" : "error",
        initError: message,
      });
    }
  },

  resolveLegacyArchive: async (choice) => {
    const session = getAuthSessionSnapshot();
    if (!session.ownerId || get().initStatus !== "legacy-recovery" || get().isGeneratingKeys) return false;
    const archive = get().legacyArchive;
    const isCurrent = () => {
      const latest = getAuthSessionSnapshot();
      return latest.ownerId === session.ownerId && latest.generation === session.generation;
    };
    set({ isGeneratingKeys: true, initError: null });
    try {
      if (choice === "import") {
        if (get().legacyArchive?.status !== "eligible") return false;
        const result = await importLegacyKeyArchive(true);
        if (!isCurrent()) return false;
        if (!result.success) {
          set({ initError: "Legacy key archive could not be imported" });
          return false;
        }
      } else if (choice === "fresh") {
        // Explicit user decision; the legacy source remains untouched.
        await keyStorage.setMetadata("legacyArchiveDecision.v1", "fresh");
      } else return false;
      if (!isCurrent()) return false;
      set({ initStatus: "uninitialized", legacyArchive: null });
      await get().initialize(session.ownerId);
      if (!isCurrent()) return false;
      if (get().initStatus !== "ready") {
        set({ initStatus: "legacy-recovery", legacyArchive: archive, initError: get().initError ?? "Legacy key recovery failed" });
        return false;
      }
      return true;
    } catch {
      if (isCurrent()) set({ initStatus: "legacy-recovery", legacyArchive: archive, initError: "Legacy key recovery failed" });
      return false;
    } finally {
      if (isCurrent()) set({ isGeneratingKeys: false });
    }
  },

  setupNewDevice: async (userId: string, displayName?: string) => {
    const session = getAuthSessionSnapshot();
    if (session.ownerId !== userId) return;
    const isCurrent = () => {
      const latest = getAuthSessionSnapshot();
      return latest.ownerId === userId && latest.generation === session.generation;
    };
    set({ isGeneratingKeys: true, initError: null });

    try {
      const deviceId = await deviceManager.registerNewDevice(
        userId,
        displayName
      );
      if (!isCurrent()) return;

      set({
        initStatus: "ready",
        localDeviceId: deviceId,
        legacyArchive: null,
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
      if (!isCurrent()) return;
      console.error("[e2eeStore] setupNewDevice error:", message);
      set({
        initError: message,
        isGeneratingKeys: false,
      });
    }
  },

  restoreFromRecovery: async (password: string) => {
    const isCurrent = captureStoreScope();
    if (!isCurrent()) return false;
    set({ isGeneratingKeys: true, initError: null });

    try {
      const response = await e2eeApi.downloadKeyBackup();
      if (!isCurrent()) return false;
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
      if (!isCurrent()) return false;

      if (!restored) {
        set({
          initError: "Invalid recovery password",
          isGeneratingKeys: false,
        });
        return false;
      }

      // New device ID for self-fanout; legacy ID kept for old envelope matching.
      const newDeviceId = await deviceManager.registerRestoredDevice();
      if (!isCurrent()) return false;

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
      if (!isCurrent()) return false;
      console.error("[e2eeStore] restoreFromRecovery error:", message);
      set({
        initError: message,
        isGeneratingKeys: false,
      });
      return false;
    }
  },

  setRecoveryPassword: async (password: string) => {
    /**
     * Strength policy chokepoint (pentest 2026-07-26, finding H-10).
     *
     * Both entry points reach the backup through here — settings and
     * completeRecoverySetup (the recovery prompt) — so this is the only
     * place where enforcement covers every caller. Validating in the
     * components instead would leave whichever path forgot to call it wide
     * open, which is exactly how H-10 shipped.
     *
     * Thrown BEFORE the try block on purpose: a rejected passphrase is a
     * failed precondition, not a failed backup, so it must not create a
     * backup, must not touch the network, and must not be swallowed by the
     * catch below. The test "should reject a one-character passphrase without
     * creating a backup" pins that ordering.
     *
     * Set-time only — restoreFromRecovery deliberately does not call this.
     */
    const policy = checkRecoveryPassphrase(password);
    if (!policy.ok) {
      throw new WeakRecoveryPassphraseError(policy.reason);
    }

    const isCurrent = captureStoreScope();
    const assertCurrent = () => { if (!isCurrent()) throw new Error("Auth session changed during backup"); };
    assertCurrent();

    try {
      const backup = await keyBackup.createBackup(password);
      assertCurrent();

      const response = await e2eeApi.uploadKeyBackup({
        version: backup.version,
        algorithm: backup.algorithm,
        encrypted_data: backup.encryptedData,
        nonce: backup.nonce,
        salt: backup.salt,
      });
      assertCurrent();

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
    const isCurrent = captureStoreScope();
    await get().setRecoveryPassword(password);
    if (isCurrent()) set({ showRecoveryPrompt: false });
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
    const isCurrent = captureStoreScope();
    if (!isCurrent()) return;
    try {
      const response = await e2eeApi.listMyDevices();
      if (!isCurrent()) return;
      if (response.success && response.data) {
        set({ devices: response.data });
      }
    } catch (err) {
      console.error("[e2eeStore] fetchDevices error:", err);
    }
  },

  removeDevice: async (deviceId: string) => {
    const isCurrent = captureStoreScope();
    if (!isCurrent()) return;
    try {
      const response = await e2eeApi.removeDevice(deviceId);
      if (!isCurrent()) return;
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
      // Keep the alert fresh when the same kind is observed again (for
      // example, a later identity change with a new key pair). Avoid a
      // render only when every field is unchanged.
      const unchanged = Object.keys({ ...existing, ...alert }).every(
        (field) => existing[field as keyof PeerTrustAlert] === alert[field as keyof PeerTrustAlert],
      ) && Object.keys(existing).every((field) => field in alert);
      if (unchanged) return;
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
    const isCurrent = captureStoreScope();
    if (!isCurrent()) return;
    try {
      const stored = await keyStorage.getMetadata<Record<string, PeerTrustAlert>>(
        "peer_trust_alerts"
      );
      if (stored && typeof stored === "object" && !Array.isArray(stored) && isCurrent()) {
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
      legacyArchive: null,
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

subscribeAuthOwnerChanges(() => { void useE2EEStore.getState().reset(); });
subscribeAuthGenerationChanges(() => { void useE2EEStore.getState().reset(); });

// ──────────────────────────────────
// Internal Helpers
// ──────────────────────────────────

function captureStoreScope(): () => boolean {
  const scope = getAuthSessionSnapshot();
  return () => {
    const current = getAuthSessionSnapshot();
    return !!scope.ownerId && scope.ownerId === current.ownerId && scope.generation === current.generation;
  };
}

/** Check recovery backup status in background. Silently continues on error. */
async function checkRecoveryBackup(
  set: (partial: Partial<E2EEState>) => void
): Promise<void> {
  const isCurrent = captureStoreScope();
  try {
    const response = await e2eeApi.downloadKeyBackup();
    if (!isCurrent()) return;
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
  const isCurrent = captureStoreScope();
  setTimeout(() => {
    if (isCurrent()) get().checkAndPromptRecovery();
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
