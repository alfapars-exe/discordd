/** EncryptionSettings — E2EE status, recovery password, and device management. */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useE2EEStore } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";
import * as keyStorage from "../../crypto/keyStorage";
import {
  checkRecoveryPassphrase,
  WeakRecoveryPassphraseError,
  RECOVERY_PASSPHRASE_MIN_LENGTH,
  RECOVERY_PASSPHRASE_MAX_LENGTH,
} from "../../crypto/recoveryPassphrase";
import RecoveryPassphraseStrength from "../shared/RecoveryPassphraseStrength";
import { formatDateTime } from "../../utils/dateFormat";

function EncryptionSettings() {
  const { t } = useTranslation("e2ee");
  const addToast = useToastStore((s) => s.addToast);

  // E2EE store state
  const initStatus = useE2EEStore((s) => s.initStatus);
  const localDeviceId = useE2EEStore((s) => s.localDeviceId);
  const devices = useE2EEStore((s) => s.devices);
  const hasRecoveryBackup = useE2EEStore((s) => s.hasRecoveryBackup);
  const fetchDevices = useE2EEStore((s) => s.fetchDevices);
  const removeDevice = useE2EEStore((s) => s.removeDevice);
  const setRecoveryPassword = useE2EEStore((s) => s.setRecoveryPassword);
  const peerTrustAlerts = useE2EEStore((s) => s.peerTrustAlerts);
  const clearPeerTrustAlert = useE2EEStore((s) => s.clearPeerTrustAlert);

  // Recovery password form state
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  // Key fingerprint
  const [fingerprint, setFingerprint] = useState<string | null>(null);

  // Fetch device list on mount
  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  // Compute fingerprint from identity public key (SHA-256)
  useEffect(() => {
    async function loadFingerprint() {
      try {
        const identity = await keyStorage.getIdentityKeyPair();
        if (!identity) return;

        // SHA-256 hash -> hex -> 4-char groups
        const hashBuffer = await crypto.subtle.digest("SHA-256", identity.publicKey as BufferSource);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
        // First 32 chars (16 bytes), grouped by 4
        const formatted = hex
          .slice(0, 32)
          .match(/.{1,4}/g)
          ?.join(" ") ?? hex.slice(0, 32);
        setFingerprint(formatted);
      } catch { /* fingerprint format failed; fall through to raw hex */ }
    }

    if (initStatus === "ready") {
      loadFingerprint();
    }
  }, [initStatus]);

  /**
   * Save recovery password.
   *
   * The policy check here is for a specific, immediate error message — the
   * binding gate is in e2eeStore.setRecoveryPassword, which is why the catch
   * below still has to handle WeakRecoveryPassphraseError.
   */
  const handleSaveRecoveryPassword = useCallback(async () => {
    const limits = {
      min: RECOVERY_PASSPHRASE_MIN_LENGTH,
      max: RECOVERY_PASSPHRASE_MAX_LENGTH,
    };

    if (!password.trim()) {
      addToast("error", t("recoveryPasswordRequired"));
      return;
    }
    if (password !== confirmPassword) {
      addToast("error", t("recoveryPasswordMismatch"));
      return;
    }

    const policy = checkRecoveryPassphrase(password.trim());
    if (!policy.ok) {
      addToast("error", t(policy.i18nKey, limits));
      return;
    }

    setIsSavingPassword(true);
    try {
      await setRecoveryPassword(password.trim());
      addToast("success", t("recoveryPasswordSet"));
      setPassword("");
      setConfirmPassword("");
    } catch (err) {
      addToast(
        "error",
        err instanceof WeakRecoveryPassphraseError
          ? t(err.i18nKey, limits)
          : t("recoveryPasswordSaveError"),
      );
    }
    setIsSavingPassword(false);
  }, [password, confirmPassword, setRecoveryPassword, addToast, t]);

  /**
   * Remove device. Also clears any outstanding trust alert for it — otherwise
   * a removed device's own_new_device warning would linger as a ghost entry
   * in peerTrustAlerts with nothing left in the device list to attach it to.
   */
  async function handleRemoveDevice(userId: string, deviceId: string) {
    try {
      await removeDevice(deviceId);
      clearPeerTrustAlert(userId, deviceId);
      addToast("success", t("removeDeviceSuccess"));
    } catch {
      addToast("error", t("removeDeviceError"));
    }
  }

  /** Copy fingerprint to clipboard */
  function handleCopyFingerprint() {
    if (!fingerprint) return;
    navigator.clipboard.writeText(fingerprint).then(
      () => addToast("success", t("fingerprintCopied")),
      () => addToast("error", t("fingerprintCopyFailed")),
    );
  }

  /** Format date for display — locale follows the in-app language. */
  function formatDate(dateStr: string): string {
    return formatDateTime(dateStr, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const isReady = initStatus === "ready";

  // own_new_device alerts (a device the server injected under our own
  // account) surface first — burying that warning below already-known
  // devices would defeat the point of showing it at all.
  const sortedDevices = useMemo(() => {
    return [...devices].sort((a, b) => {
      const aFlagged = peerTrustAlerts[`${a.user_id}:${a.device_id}`]?.kind === "own_new_device";
      const bFlagged = peerTrustAlerts[`${b.user_id}:${b.device_id}`]?.kind === "own_new_device";
      if (aFlagged && !bFlagged) return -1;
      if (!aFlagged && bFlagged) return 1;
      return 0;
    });
  }, [devices, peerTrustAlerts]);

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("title")}</h2>
      <p className="settings-hint">{t("description")}</p>

      {/* ═══ E2EE Status ═══ */}
      <div className="e2ee-status-badge-wrap">
        <span className={`e2ee-status-badge ${isReady ? "active" : "inactive"}`}>
          {isReady ? t("encryptionActive") : t("encryptionNotSetup")}
        </span>
      </div>

      {!isReady && (
        <p className="e2ee-setup-warning">{t("setupRequired")}</p>
      )}

      {/* ═══ Key Fingerprint ═══ */}
      {isReady && fingerprint && (
        <>
          <div className="settings-divider" />
          <h3 className="settings-section-subtitle">{t("keyFingerprint")}</h3>
          <p className="settings-hint">{t("keyFingerprintDescription")}</p>

          <div className="e2ee-fingerprint-wrap">
            <code className="e2ee-fingerprint" onClick={handleCopyFingerprint} title={t("fingerprintCopied")}>
              {fingerprint}
            </code>
          </div>
        </>
      )}

      {/* ═══ Recovery Password ═══ */}
      {isReady && (
        <>
          <div className="settings-divider" />
          <h3 className="settings-section-subtitle">{t("recoveryPasswordTitle")}</h3>
          <p className="settings-hint">{t("recoveryPasswordDescription")}</p>

          {!hasRecoveryBackup && (
            <p className="e2ee-setup-warning">{t("noRecoveryWarning")}</p>
          )}

          <div className="settings-field">
            <label htmlFor="recoveryPwd" className="settings-label">
              {hasRecoveryBackup ? t("changeRecoveryPassword") : t("setRecoveryPassword")}
            </label>
            <input
              id="recoveryPwd"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("recoveryPasswordPlaceholder")}
              className="settings-input"
              autoComplete="new-password"
            />
            <RecoveryPassphraseStrength passphrase={password} />
          </div>

          <div className="settings-field">
            <label htmlFor="recoveryPwdConfirm" className="settings-label">
              {t("recoveryPasswordConfirmPlaceholder")}
            </label>
            <input
              id="recoveryPwdConfirm"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder={t("recoveryPasswordConfirmPlaceholder")}
              className="settings-input"
              autoComplete="new-password"
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveRecoveryPassword();
              }}
            />
          </div>

          <div style={{ marginTop: 12 }}>
            <button
              onClick={handleSaveRecoveryPassword}
              disabled={!password.trim() || isSavingPassword}
              className="settings-btn"
            >
              {isSavingPassword
                ? (hasRecoveryBackup ? t("changeRecoveryPassword") : t("setRecoveryPassword")) + "..."
                : hasRecoveryBackup ? t("changeRecoveryPassword") : t("setRecoveryPassword")}
            </button>
          </div>
        </>
      )}

      {/* ═══ Device Management ═══ */}
      {isReady && (
        <>
          <div className="settings-divider" />
          <h3 className="settings-section-subtitle">{t("devicesTitle")}</h3>
          <p className="settings-hint">{t("devicesDescription")}</p>

          <div className="e2ee-device-list">
            {devices.length === 0 ? (
              <p className="settings-hint">{t("noDevices")}</p>
            ) : (
              sortedDevices.map((device) => {
                const isThisDevice = device.device_id === localDeviceId;
                const alert = peerTrustAlerts[`${device.user_id}:${device.device_id}`];
                const isUntrusted = alert?.kind === "own_new_device";

                return (
                  <div
                    key={device.id}
                    className={isUntrusted ? "e2ee-device-item is-untrusted" : "e2ee-device-item"}
                  >
                    <div className="e2ee-device-info">
                      <span className="e2ee-device-name">
                        {device.display_name ?? device.device_id.slice(0, 8)}
                        {isThisDevice && (
                          <span className="e2ee-device-this"> ({t("thisDevice")})</span>
                        )}
                        {isUntrusted && (
                          <span className="e2ee-device-alert-badge">{t("ownDeviceAlertBadge")}</span>
                        )}
                      </span>
                      <span className="e2ee-device-meta">
                        {t("lastSeen", { time: formatDate(device.last_seen_at) })}
                      </span>
                      {isUntrusted && (
                        <span className="e2ee-device-alert-hint">{t("ownDeviceAlertHint")}</span>
                      )}
                    </div>

                    <div className="e2ee-device-actions">
                      {isUntrusted && (
                        <button
                          type="button"
                          onClick={() => clearPeerTrustAlert(device.user_id, device.device_id)}
                          className="settings-btn e2ee-device-acknowledge"
                        >
                          {t("ownDeviceAcknowledge")}
                        </button>
                      )}
                      {!isThisDevice && (
                        <button
                          onClick={() => handleRemoveDevice(device.user_id, device.device_id)}
                          className="settings-btn settings-btn-danger e2ee-device-remove"
                        >
                          {t("removeDevice")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default EncryptionSettings;
