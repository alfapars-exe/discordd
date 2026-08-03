import { describe, it, expect, beforeEach, vi } from "vitest";
import type { IdentityKeyChange } from "../crypto/signalProtocol";

/**
 * The signalProtocol doubles live in vi.hoisted() rather than inline in the
 * vi.mock factory so their identity survives vi.resetModules(): the
 * identity-key ingestion test re-imports the store to replay module load, and
 * a factory-local vi.fn() would be rebuilt there, throwing away the queued
 * return value the test just staged.
 */
const signalMocks = vi.hoisted(() => ({
  drainIdentityKeyChanges: vi.fn(() => [] as IdentityKeyChange[]),
  onIdentityKeyChange: vi.fn(() => () => {}),
}));

// Mock all external crypto/api dependencies before importing the store
vi.mock("../crypto/deviceManager", () => ({
  getLocalDeviceId: vi.fn(),
  registerNewDevice: vi.fn(),
  registerRestoredDevice: vi.fn(),
  refreshPreKeys: vi.fn(),
  reRegisterDevice: vi.fn(),
}));
vi.mock("../crypto/keyBackup", () => ({
  createBackup: vi.fn(),
  restoreFromBackup: vi.fn(),
}));
vi.mock("../crypto/keyStorage", () => ({
  hasLocalKeys: vi.fn(),
  getRegistrationData: vi.fn(),
  clearAllE2EEData: vi.fn(),
  setMetadata: vi.fn(),
  getMetadata: vi.fn(),
}));
vi.mock("../crypto/signalProtocol", () => ({
  drainIdentityKeyChanges: signalMocks.drainIdentityKeyChanges,
  onIdentityKeyChange: signalMocks.onIdentityKeyChange,
}));
vi.mock("../api/e2ee", () => ({
  listMyDevices: vi.fn(),
  removeDevice: vi.fn(),
  uploadKeyBackup: vi.fn(),
  downloadKeyBackup: vi.fn(),
}));
vi.mock("./messageStore", () => ({
  useMessageStore: { getState: () => ({ invalidateFetchCache: vi.fn(), fetchMessages: vi.fn() }) },
}));
vi.mock("./dmStore", () => ({
  useDMStore: { getState: () => ({ invalidateFetchCache: vi.fn() }) },
}));
vi.mock("./channelStore", () => ({
  useChannelStore: { getState: () => ({ selectedChannelId: null }) },
}));

import * as keyStorage from "../crypto/keyStorage";
import * as keyBackup from "../crypto/keyBackup";
import * as deviceManager from "../crypto/deviceManager";
import * as e2eeApi from "../api/e2ee";
import { WeakRecoveryPassphraseError } from "../crypto/recoveryPassphrase";
import { useE2EEStore } from "./e2eeStore";
import type { DecryptionError, PeerTrustAlert } from "./e2eeStore";

function resetStore() {
  useE2EEStore.setState({
    initStatus: "uninitialized",
    localDeviceId: null,
    devices: [],
    hasRecoveryBackup: false,
    decryptionErrors: [],
    isGeneratingKeys: false,
    initError: null,
    peerTrustAlerts: {},
  });
}

describe("e2eeStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
  });

  // ─── Decryption Error Management ───

  describe("addDecryptionError", () => {
    it("should add a decryption error", () => {
      const error: DecryptionError = {
        messageId: "m1",
        channelId: "ch1",
        error: "Missing session key",
        timestamp: Date.now(),
      };
      useE2EEStore.getState().addDecryptionError(error);
      expect(useE2EEStore.getState().decryptionErrors).toHaveLength(1);
      expect(useE2EEStore.getState().decryptionErrors[0].messageId).toBe("m1");
    });

    it("should cap errors at 500 entries", () => {
      const store = useE2EEStore.getState();
      // Pre-fill with 500 errors
      const existing: DecryptionError[] = Array.from({ length: 500 }, (_, i) => ({
        messageId: `m${i}`,
        channelId: "ch1",
        error: "test",
        timestamp: i,
      }));
      useE2EEStore.setState({ decryptionErrors: existing });

      // Add one more — should trim to last 500
      store.addDecryptionError({
        messageId: "m_new",
        channelId: "ch1",
        error: "test",
        timestamp: 999,
      });

      const errors = useE2EEStore.getState().decryptionErrors;
      expect(errors).toHaveLength(500);
      expect(errors[errors.length - 1].messageId).toBe("m_new");
      // First entry (m0) should have been dropped
      expect(errors[0].messageId).toBe("m1");
    });
  });

  describe("clearDecryptionErrors", () => {
    it("should clear errors for a specific channel", () => {
      useE2EEStore.setState({
        decryptionErrors: [
          { messageId: "m1", channelId: "ch1", error: "err", timestamp: 1 },
          { messageId: "m2", channelId: "ch2", error: "err", timestamp: 2 },
          { messageId: "m3", channelId: "ch1", error: "err", timestamp: 3 },
        ],
      });
      useE2EEStore.getState().clearDecryptionErrors("ch1");
      const errors = useE2EEStore.getState().decryptionErrors;
      expect(errors).toHaveLength(1);
      expect(errors[0].channelId).toBe("ch2");
    });
  });

  // ─── Peer Trust Alerts ───

  describe("markPeerTrustAlert", () => {
    it("should add an alert to state", () => {
      const alert: PeerTrustAlert = {
        userId: "u1",
        deviceId: "d1",
        kind: "new_device",
        detectedAt: 1,
      };
      useE2EEStore.getState().markPeerTrustAlert(alert);
      expect(useE2EEStore.getState().peerTrustAlerts["u1:d1"]).toEqual(alert);
    });

    it("should not change the state reference when marking the same alert kind twice", () => {
      const alert: PeerTrustAlert = {
        userId: "u1",
        deviceId: "d1",
        kind: "new_device",
        detectedAt: 1,
      };
      useE2EEStore.getState().markPeerTrustAlert(alert);
      const before = useE2EEStore.getState().peerTrustAlerts;
      useE2EEStore.getState().markPeerTrustAlert({ ...alert, detectedAt: 2 });
      const after = useE2EEStore.getState().peerTrustAlerts;
      expect(after).toBe(before);
    });

    it("should let identity_changed overwrite an existing new_device alert", () => {
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "u1",
        deviceId: "d1",
        kind: "new_device",
        detectedAt: 1,
      });
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "u1",
        deviceId: "d1",
        kind: "identity_changed",
        previousKey: "prevKey",
        newKey: "nextKey",
        detectedAt: 2,
      });
      const alert = useE2EEStore.getState().peerTrustAlerts["u1:d1"];
      expect(alert.kind).toBe("identity_changed");
      expect(alert.previousKey).toBe("prevKey");
    });

    it("should commit state before persisting (persist runs outside the set updater)", () => {
      // A persist launched from inside the set() updater observes pre-commit
      // state, which is the tell for the impure-updater shape: two marks in
      // one tick would then race two full-map writes with no ordering
      // guarantee, and the lost write drops an unacknowledged alert.
      const persisted: Record<string, PeerTrustAlert>[] = [];
      vi.mocked(keyStorage.setMetadata).mockImplementationOnce(async () => {
        persisted.push(useE2EEStore.getState().peerTrustAlerts);
      });

      useE2EEStore.getState().markPeerTrustAlert({
        userId: "u1",
        deviceId: "d1",
        kind: "new_device",
        detectedAt: 1,
      });

      expect(persisted).toHaveLength(1);
      expect(persisted[0]["u1:d1"]).toBeDefined();
    });

    it("should cap alerts at 200 and evict the oldest new_device first", () => {
      // Exactly at the limit: one severe alert (also the OLDEST by detectedAt,
      // so pure FIFO would pick it) plus 199 pieces of new-device noise.
      const seeded: Record<string, PeerTrustAlert> = {
        "victim:mitm": {
          userId: "victim",
          deviceId: "mitm",
          kind: "identity_changed",
          previousKey: "prevKey",
          newKey: "nextKey",
          detectedAt: 0,
        },
      };
      for (let i = 0; i < 199; i++) {
        seeded[`flood:d${i}`] = {
          userId: "flood",
          deviceId: `d${i}`,
          kind: "new_device",
          detectedAt: i + 1,
        };
      }
      useE2EEStore.setState({ peerTrustAlerts: seeded });

      useE2EEStore.getState().markPeerTrustAlert({
        userId: "flood",
        deviceId: "d199",
        kind: "new_device",
        detectedAt: 1000,
      });

      const alerts = useE2EEStore.getState().peerTrustAlerts;
      expect(Object.keys(alerts)).toHaveLength(200);
      expect(alerts["flood:d199"]).toBeDefined();
      // Oldest noise entry evicted, severe entry untouched.
      expect(alerts["flood:d0"]).toBeUndefined();
      expect(alerts["victim:mitm"]).toBeDefined();
    });

    it("should survive a new_device flood without losing the identity_changed alert", () => {
      // The attacker-controlled shape: a hostile server drives hundreds of
      // new-device alerts to push the possible-MITM warning out of the map.
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "victim",
        deviceId: "mitm",
        kind: "identity_changed",
        previousKey: "prevKey",
        newKey: "nextKey",
        detectedAt: 0,
      });

      for (let i = 0; i < 500; i++) {
        useE2EEStore.getState().markPeerTrustAlert({
          userId: "flood",
          deviceId: `d${i}`,
          kind: "new_device",
          detectedAt: i + 1,
        });
      }

      const alerts = useE2EEStore.getState().peerTrustAlerts;
      expect(Object.keys(alerts)).toHaveLength(200);
      expect(alerts["victim:mitm"]?.kind).toBe("identity_changed");
    });

    // ── Device injected into the user's OWN account ──
    //
    // own_new_device means the server listed a device under this user's own
    // account that was never pinned: the self-fanout loop encrypts a copy of
    // every outgoing DM for it, so it reads everything the user sends, in
    // every conversation. It is not peer noise and must not be treated as
    // such by either the eviction or the overwrite rule.

    it("should survive a new_device flood without losing the own_new_device alert", () => {
      // Deliberately the OLDEST entry (detectedAt 0), so plain FIFO eviction
      // would drop it first — exactly what a hostile server would drive by
      // flooding cheap peer-device sightings after injecting its own device.
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "me",
        deviceId: "injected",
        kind: "own_new_device",
        detectedAt: 0,
      });

      for (let i = 0; i < 500; i++) {
        useE2EEStore.getState().markPeerTrustAlert({
          userId: "flood",
          deviceId: `d${i}`,
          kind: "new_device",
          detectedAt: i + 1,
        });
      }

      const alerts = useE2EEStore.getState().peerTrustAlerts;
      expect(Object.keys(alerts)).toHaveLength(200);
      expect(alerts["me:injected"]?.kind).toBe("own_new_device");
      // The flood itself is still subject to the cap: only the newest noise
      // survives, so the protection is not simply "nothing is ever evicted".
      expect(alerts["flood:d0"]).toBeUndefined();
      expect(alerts["flood:d499"]).toBeDefined();
    });

    it("should keep own_new_device and identity_changed together under the cap", () => {
      // Both protected kinds present at once: neither may be sacrificed to
      // make room for the other while evictable noise remains.
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "me",
        deviceId: "injected",
        kind: "own_new_device",
        detectedAt: 0,
      });
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "victim",
        deviceId: "mitm",
        kind: "identity_changed",
        previousKey: "prevKey",
        newKey: "nextKey",
        detectedAt: 1,
      });

      for (let i = 0; i < 400; i++) {
        useE2EEStore.getState().markPeerTrustAlert({
          userId: "flood",
          deviceId: `d${i}`,
          kind: "new_device",
          detectedAt: i + 2,
        });
      }

      const alerts = useE2EEStore.getState().peerTrustAlerts;
      expect(Object.keys(alerts)).toHaveLength(200);
      expect(alerts["me:injected"]?.kind).toBe("own_new_device");
      expect(alerts["victim:mitm"]?.kind).toBe("identity_changed");
    });

    it("should not let new_device overwrite an existing own_new_device alert", () => {
      // Same key space: an own_new_device alert is keyed by the user's OWN
      // id, and a self-DM (note to self) would produce a new_device sighting
      // under that very key on the receive side.
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "me",
        deviceId: "injected",
        kind: "own_new_device",
        detectedAt: 1,
      });
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "me",
        deviceId: "injected",
        kind: "new_device",
        detectedAt: 2,
      });
      expect(useE2EEStore.getState().peerTrustAlerts["me:injected"].kind).toBe(
        "own_new_device"
      );
    });

    it("should let identity_changed overwrite an existing own_new_device alert", () => {
      // Severity order is total: a key change on an already-suspect device is
      // strictly more informative than "we had not seen this device before".
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "me",
        deviceId: "injected",
        kind: "own_new_device",
        detectedAt: 1,
      });
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "me",
        deviceId: "injected",
        kind: "identity_changed",
        previousKey: "prevKey",
        newKey: "nextKey",
        detectedAt: 2,
      });
      expect(useE2EEStore.getState().peerTrustAlerts["me:injected"].kind).toBe(
        "identity_changed"
      );
    });

    it("should not let new_device overwrite an existing identity_changed alert", () => {
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "u1",
        deviceId: "d1",
        kind: "identity_changed",
        previousKey: "prevKey",
        newKey: "nextKey",
        detectedAt: 1,
      });
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "u1",
        deviceId: "d1",
        kind: "new_device",
        detectedAt: 2,
      });
      const alert = useE2EEStore.getState().peerTrustAlerts["u1:d1"];
      expect(alert.kind).toBe("identity_changed");
    });
  });

  describe("clearPeerTrustAlert", () => {
    it("should remove the alert from state and persist the change", () => {
      useE2EEStore.getState().markPeerTrustAlert({
        userId: "u1",
        deviceId: "d1",
        kind: "new_device",
        detectedAt: 1,
      });

      useE2EEStore.getState().clearPeerTrustAlert("u1", "d1");

      expect(useE2EEStore.getState().peerTrustAlerts["u1:d1"]).toBeUndefined();
      expect(keyStorage.setMetadata).toHaveBeenCalledWith("peer_trust_alerts", {});
    });
  });

  describe("loadPeerTrustAlerts", () => {
    it("should populate state from persisted metadata", async () => {
      const stored: Record<string, PeerTrustAlert> = {
        "u2:d2": { userId: "u2", deviceId: "d2", kind: "new_device", detectedAt: 5 },
      };
      vi.mocked(keyStorage.getMetadata).mockResolvedValueOnce(stored);

      await useE2EEStore.getState().loadPeerTrustAlerts();

      expect(useE2EEStore.getState().peerTrustAlerts).toEqual(stored);
    });
  });

  // ─── Account Switch ───
  //
  // Trust alerts name the previous account's contacts and carry their identity
  // keys. Loading them concurrently with the different-user wipe lets the read
  // win the race and strand user A's alerts inside user B's session — where
  // the next mark persists them straight back into B's cleared metadata store.

  describe("initialize (different user)", () => {
    it("should drop the previous account's trust alerts", async () => {
      useE2EEStore.setState({
        peerTrustAlerts: {
          "userA-contact:d1": {
            userId: "userA-contact",
            deviceId: "d1",
            kind: "identity_changed",
            previousKey: "prevKey",
            newKey: "nextKey",
            detectedAt: 1,
          },
        },
      });
      vi.mocked(keyStorage.hasLocalKeys).mockResolvedValue(true);
      vi.mocked(keyStorage.getRegistrationData).mockResolvedValue({
        registrationId: 1,
        deviceId: "devA",
        userId: "userA",
        createdAt: 0,
      });
      vi.mocked(keyStorage.clearAllE2EEData).mockResolvedValue(undefined);
      vi.mocked(e2eeApi.downloadKeyBackup).mockResolvedValue({ success: false });
      vi.mocked(e2eeApi.listMyDevices).mockResolvedValue({ success: true, data: [] });
      vi.mocked(deviceManager.registerNewDevice).mockResolvedValue("devB");

      await useE2EEStore.getState().initialize("userB");

      expect(keyStorage.clearAllE2EEData).toHaveBeenCalled();
      expect(useE2EEStore.getState().peerTrustAlerts).toEqual({});
    });

    it("should not start the alert load before the account wipe", async () => {
      vi.mocked(keyStorage.hasLocalKeys).mockResolvedValue(true);
      vi.mocked(keyStorage.getRegistrationData).mockResolvedValue({
        registrationId: 1,
        deviceId: "devA",
        userId: "userA",
        createdAt: 0,
      });
      vi.mocked(keyStorage.clearAllE2EEData).mockResolvedValue(undefined);
      vi.mocked(e2eeApi.downloadKeyBackup).mockResolvedValue({ success: false });
      vi.mocked(e2eeApi.listMyDevices).mockResolvedValue({ success: true, data: [] });
      vi.mocked(deviceManager.registerNewDevice).mockResolvedValue("devB");

      await useE2EEStore.getState().initialize("userB");

      const wipedAt =
        vi.mocked(keyStorage.clearAllE2EEData).mock.invocationCallOrder[0];
      const loadedAt = vi.mocked(keyStorage.getMetadata).mock.invocationCallOrder[0];
      expect(wipedAt).toBeDefined();
      expect(loadedAt).toBeGreaterThan(wipedAt);
    });
  });

  // ─── Lost device id recovery (security scan 2026-07-31, N-22) ───
  //
  // hasLocalKeys() looks at identity+registration; getLocalDeviceId() looks
  // ONLY at metadata["deviceId"]. An aborted backup restore could clear the
  // second without the first, and the resulting state is silent and terminal:
  // initStatus "ready" with localDeviceId null, every DM decrypt bailing on
  // that null, handlePrekeyLow returning early, no path back. registration
  // still holds the same device id, so init repairs it instead.

  describe("initialize (keys present, metadata deviceId missing)", () => {
    beforeEach(() => {
      vi.mocked(keyStorage.hasLocalKeys).mockResolvedValue(true);
      vi.mocked(keyStorage.getRegistrationData).mockResolvedValue({
        registrationId: 1,
        deviceId: "dev-recovered",
        userId: "userA",
        createdAt: 0,
      });
      vi.mocked(e2eeApi.downloadKeyBackup).mockResolvedValue({ success: false });
      vi.mocked(e2eeApi.listMyDevices).mockResolvedValue({ success: true, data: [] });
    });

    it("should rewrite deviceId from registration and keep the device usable", async () => {
      vi.mocked(deviceManager.getLocalDeviceId).mockResolvedValue(null);

      await useE2EEStore.getState().initialize("userA");

      // Repaired in IndexedDB, not just in memory — otherwise the next reload
      // (and every direct keyStorage consumer) is back in the broken state.
      expect(keyStorage.setMetadata).toHaveBeenCalledWith(
        "deviceId",
        "dev-recovered"
      );
      expect(useE2EEStore.getState().localDeviceId).toBe("dev-recovered");
      expect(useE2EEStore.getState().initStatus).toBe("ready");
    });

    it("should run the existing re-register path for the recovered id", async () => {
      // listMyDevices returns an empty list: the recovered device is unknown
      // to the server, which is precisely the state an interrupted restore
      // leaves behind. Recovery is worthless if the id never reaches the
      // server, so the repaired id must flow into the existing branch.
      vi.mocked(deviceManager.getLocalDeviceId).mockResolvedValue(null);

      await useE2EEStore.getState().initialize("userA");

      expect(deviceManager.reRegisterDevice).toHaveBeenCalledWith("dev-recovered");
    });

    it("REGRESSION: should not touch metadata when the deviceId is present", async () => {
      vi.mocked(deviceManager.getLocalDeviceId).mockResolvedValue("dev-normal");

      await useE2EEStore.getState().initialize("userA");

      expect(useE2EEStore.getState().localDeviceId).toBe("dev-normal");
      expect(useE2EEStore.getState().initStatus).toBe("ready");
      expect(keyStorage.setMetadata).not.toHaveBeenCalledWith(
        "deviceId",
        expect.anything()
      );
      expect(deviceManager.reRegisterDevice).toHaveBeenCalledWith("dev-normal");
    });
  });

  // ─── Reset ───

  describe("reset", () => {
    it("should reset all state to defaults", async () => {
      useE2EEStore.setState({
        initStatus: "ready",
        localDeviceId: "dev1",
        devices: [{
          id: "1", user_id: "u1", device_id: "dev1", display_name: "Test",
          identity_key: "", signed_prekey: "", signed_prekey_id: 0,
          signed_prekey_signature: "", registration_id: 0,
          last_seen_at: "", created_at: "",
        }],
        hasRecoveryBackup: true,
        decryptionErrors: [{ messageId: "m1", channelId: "ch1", error: "err", timestamp: 1 }],
        isGeneratingKeys: true,
        initError: "old error",
      });

      await useE2EEStore.getState().reset();
      const state = useE2EEStore.getState();

      expect(state.initStatus).toBe("uninitialized");
      expect(state.localDeviceId).toBeNull();
      expect(state.devices).toHaveLength(0);
      expect(state.hasRecoveryBackup).toBe(false);
      expect(state.decryptionErrors).toHaveLength(0);
      expect(state.isGeneratingKeys).toBe(false);
      expect(state.initError).toBeNull();
    });
  });

  // ─── Recovery passphrase policy (pentest 2026-07-26, finding H-10) ───
  //
  // The backup blob holds private keys AND the plaintext message cache, and
  // the server can attack it offline. Before H-10 a one-character passphrase
  // was accepted. Enforcement lives in setRecoveryPassword because BOTH entry
  // points funnel through it; a component-level check would have left
  // completeRecoverySetup open.

  const STRONG_PASSPHRASE = "Correct-Horse-Battery9";

  /** Mock a successful backup + upload. Returns the fake backup payload. */
  function stageSuccessfulBackup() {
    const backup = {
      version: 1,
      algorithm: "aes-256-gcm+pbkdf2-2000000",
      encryptedData: "ZW5j",
      nonce: "bm9u",
      salt: "c2Fs",
    };
    vi.mocked(keyBackup.createBackup).mockResolvedValue(backup);
    vi.mocked(e2eeApi.uploadKeyBackup).mockResolvedValue({ success: true, data: null });
    return backup;
  }

  describe("setRecoveryPassword", () => {
    it("should reject a one-character passphrase without creating a backup", async () => {
      stageSuccessfulBackup();

      await expect(
        useE2EEStore.getState().setRecoveryPassword("a"),
      ).rejects.toBeInstanceOf(WeakRecoveryPassphraseError);

      // Sequence proof: the rejection must happen BEFORE any key material is
      // collected and BEFORE anything is handed to the server. Asserting only
      // on the throw would pass even if the weak-passphrase blob had already
      // been uploaded.
      expect(keyBackup.createBackup).not.toHaveBeenCalled();
      expect(e2eeApi.uploadKeyBackup).not.toHaveBeenCalled();
      expect(useE2EEStore.getState().hasRecoveryBackup).toBe(false);
    });

    it("should reject the other weak shapes the policy names", async () => {
      stageSuccessfulBackup();

      for (const weak of ["short", "aaaaaaaaaaaa", "918273645500", "abcdefghijkl", "password1234"]) {
        await expect(
          useE2EEStore.getState().setRecoveryPassword(weak),
        ).rejects.toBeInstanceOf(WeakRecoveryPassphraseError);
      }

      expect(keyBackup.createBackup).not.toHaveBeenCalled();
      expect(e2eeApi.uploadKeyBackup).not.toHaveBeenCalled();
    });

    it("should carry a translatable reason on the thrown error", async () => {
      stageSuccessfulBackup();

      await expect(
        useE2EEStore.getState().setRecoveryPassword("a"),
      ).rejects.toMatchObject({
        reason: "tooShort",
        i18nKey: "recoveryPasswordTooShort",
      });
    });

    it("should still create and upload a backup for a strong passphrase", async () => {
      // The positive case: a policy that rejected everything would satisfy all
      // of the tests above while breaking the feature outright.
      const backup = stageSuccessfulBackup();

      await useE2EEStore.getState().setRecoveryPassword(STRONG_PASSPHRASE);

      expect(keyBackup.createBackup).toHaveBeenCalledWith(STRONG_PASSPHRASE);
      expect(e2eeApi.uploadKeyBackup).toHaveBeenCalledWith({
        version: backup.version,
        algorithm: backup.algorithm,
        encrypted_data: backup.encryptedData,
        nonce: backup.nonce,
        salt: backup.salt,
      });
      expect(useE2EEStore.getState().hasRecoveryBackup).toBe(true);
    });
  });

  describe("completeRecoverySetup", () => {
    it("should apply the same policy as the settings path", async () => {
      // Second entry point (RecoveryPasswordPrompt). It delegates to
      // setRecoveryPassword, so it must inherit the gate rather than needing
      // its own copy of the rules.
      stageSuccessfulBackup();
      useE2EEStore.setState({ showRecoveryPrompt: true });

      await expect(
        useE2EEStore.getState().completeRecoverySetup("a"),
      ).rejects.toBeInstanceOf(WeakRecoveryPassphraseError);

      expect(keyBackup.createBackup).not.toHaveBeenCalled();
      expect(e2eeApi.uploadKeyBackup).not.toHaveBeenCalled();
      // The prompt stays open — dismissing it here would look like success.
      expect(useE2EEStore.getState().showRecoveryPrompt).toBe(true);
    });

    it("should complete and close the prompt for a strong passphrase", async () => {
      stageSuccessfulBackup();
      useE2EEStore.setState({ showRecoveryPrompt: true });

      await useE2EEStore.getState().completeRecoverySetup(STRONG_PASSPHRASE);

      expect(keyBackup.createBackup).toHaveBeenCalledWith(STRONG_PASSPHRASE);
      expect(useE2EEStore.getState().showRecoveryPrompt).toBe(false);
      expect(useE2EEStore.getState().hasRecoveryBackup).toBe(true);
    });
  });

  describe("restoreFromRecovery (backward compatibility)", () => {
    it("should restore a backup made under a weak legacy passphrase", async () => {
      // The policy is SET-TIME ONLY. Backups created before H-10 was fixed
      // are protected by whatever the user typed then, often a single
      // character. Gating the restore path on the new rules would lock those
      // users out of their own identity keys and message history — the policy
      // would then cause exactly the loss it exists to prevent.
      const legacyWeakPassphrase = "a";

      vi.mocked(e2eeApi.downloadKeyBackup).mockResolvedValue({
        success: true,
        data: {
          id: "b1",
          user_id: "u1",
          version: 1,
          algorithm: "aes-256-gcm",
          encrypted_data: "ZW5j",
          nonce: "bm9u",
          salt: "c2Fs",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
      });
      vi.mocked(keyBackup.restoreFromBackup).mockResolvedValue(true);
      vi.mocked(deviceManager.registerRestoredDevice).mockResolvedValue("devRestored");
      vi.mocked(deviceManager.refreshPreKeys).mockResolvedValue(undefined);
      vi.mocked(e2eeApi.listMyDevices).mockResolvedValue({ success: true, data: [] });

      const restored = await useE2EEStore.getState().restoreFromRecovery(legacyWeakPassphrase);

      expect(restored).toBe(true);
      expect(keyBackup.restoreFromBackup).toHaveBeenCalledWith(
        expect.objectContaining({ algorithm: "aes-256-gcm" }),
        legacyWeakPassphrase,
      );
      expect(useE2EEStore.getState().initStatus).toBe("ready");
      expect(useE2EEStore.getState().localDeviceId).toBe("devRestored");
    });
  });

  // ─── Initial State ───

  describe("initial state", () => {
    it("should start uninitialized with no device", () => {
      const state = useE2EEStore.getState();
      expect(state.initStatus).toBe("uninitialized");
      expect(state.localDeviceId).toBeNull();
      expect(state.devices).toHaveLength(0);
      expect(state.hasRecoveryBackup).toBe(false);
      expect(state.isGeneratingKeys).toBe(false);
    });
  });
});

// ──────────────────────────────────
// Identity Key Change Ingestion
// ──────────────────────────────────
//
// signalProtocol queues identity-key changes and the store drains them on
// module load. Exercising that wiring with an EMPTY queue proves nothing: the
// original H-02 regression was "queue produced, nobody consumes it", and an
// always-empty drain mock passes both with and without the consumer. So this
// test stages a real change and replays module load.
//
// It lives outside the main describe because vi.resetModules() builds a second
// store instance; assertions target that fresh module, not the shared import.

describe("e2eeStore — identity key change ingestion", () => {
  it("should surface a queued identity change as an identity_changed alert", async () => {
    const change: IdentityKeyChange = {
      userId: "u9",
      deviceId: "d9",
      previousKey: "prevKey",
      newKey: "nextKey",
      detectedAt: 42,
    };
    signalMocks.drainIdentityKeyChanges.mockReturnValueOnce([change]);

    vi.resetModules();
    const fresh = await import("./e2eeStore");

    expect(signalMocks.drainIdentityKeyChanges).toHaveBeenCalled();
    expect(fresh.useE2EEStore.getState().peerTrustAlerts["u9:d9"]).toEqual({
      userId: "u9",
      deviceId: "d9",
      kind: "identity_changed",
      previousKey: "prevKey",
      newKey: "nextKey",
      detectedAt: 42,
    });
  });

  it("should register itself as a listener so later changes are drained too", async () => {
    // The load-time drain only covers what accumulated before the store
    // existed; without the subscription, every change after startup would sit
    // in the queue forever — the same silent-consumer failure, delayed.
    signalMocks.onIdentityKeyChange.mockClear();
    vi.resetModules();
    await import("./e2eeStore");

    expect(signalMocks.onIdentityKeyChange).toHaveBeenCalled();
  });
});
