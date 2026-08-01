/**
 * DMSafetyNumberPanel — lets the user compare a peer device's safety number
 * out-of-band and mark it as manually verified. Same popup pattern as
 * DMSearchPanel / DMPinnedMessages (anchored under the DM header).
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useE2EEStore, type PeerTrustAlertKind } from "../../stores/e2eeStore";
import { useToastStore } from "../../stores/toastStore";
import * as keyStorage from "../../crypto/keyStorage";
import { computeSafetyNumber } from "../../crypto/safetyNumber";
import type { TrustedIdentity } from "../../crypto/types";
import type { User } from "../../types";

type DMSafetyNumberPanelProps = {
  otherUser: User;
  onClose: () => void;
};

// Explicit per-kind mapping (not a ternary) so a new PeerTrustAlertKind is a
// compile error here instead of silently falling through to the wrong
// label — own_new_device is about OUR OWN account and must never be shown
// with peer-facing copy (see e2eeStore's PeerTrustAlertKind doc comment).
const TRUST_ALERT_LABEL_KEYS: Record<PeerTrustAlertKind, string> = {
  identity_changed: "trustAlertIdentityChanged",
  new_device: "trustAlertNewDevice",
  own_new_device: "trustAlertOwnNewDevice",
};

function DMSafetyNumberPanel({ otherUser, onClose }: Readonly<DMSafetyNumberPanelProps>) {
  const { t } = useTranslation("e2ee");
  const addToast = useToastStore((s) => s.addToast);
  const peerTrustAlerts = useE2EEStore((s) => s.peerTrustAlerts);
  const clearPeerTrustAlert = useE2EEStore((s) => s.clearPeerTrustAlert);

  const [myPublicKey, setMyPublicKey] = useState<Uint8Array | null>(null);
  const [identities, setIdentities] = useState<TrustedIdentity[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load the local identity key + every pinned identity for this peer.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      const [myIdentity, allTrusted] = await Promise.all([
        keyStorage.getIdentityKeyPair(),
        keyStorage.getAllTrustedIdentities(),
      ]);
      if (cancelled) return;
      setMyPublicKey(myIdentity?.publicKey ?? null);
      setIdentities(allTrusted.filter((ti) => ti.userId === otherUser.id));
      setIsLoading(false);
    }

    load();
    return () => { cancelled = true; };
  }, [otherUser.id]);

  const handleMarkVerified = useCallback(
    async (deviceId: string) => {
      const ok = await keyStorage.setTrustedIdentityVerified(otherUser.id, deviceId, true);
      if (!ok) return;
      clearPeerTrustAlert(otherUser.id, deviceId);
      setIdentities((prev) =>
        prev.map((ti) => (ti.deviceId === deviceId ? { ...ti, verified: true } : ti))
      );
      addToast("success", t("markVerifiedDone"));
    },
    [otherUser.id, clearPeerTrustAlert, addToast, t]
  );

  // Devices carrying an active trust alert surface first and stay visually
  // distinct — a MITM warning buried below already-trusted devices would
  // defeat the point of this panel.
  const sortedIdentities = useMemo(() => {
    return [...identities].sort((a, b) => {
      const aAlert = peerTrustAlerts[`${otherUser.id}:${a.deviceId}`];
      const bAlert = peerTrustAlerts[`${otherUser.id}:${b.deviceId}`];
      if (aAlert && !bAlert) return -1;
      if (!aAlert && bAlert) return 1;
      return b.firstSeen - a.firstSeen;
    });
  }, [identities, peerTrustAlerts, otherUser.id]);

  return (
    <div className="search-panel trust-panel">
      {/* Header */}
      <div className="search-header">
        <span className="search-header-title">{t("trustPanelTitle")}</span>
        <button type="button" onClick={onClose} className="search-close">
          <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <p className="trust-panel-description">{t("trustPanelDescription")}</p>

      <div className="trust-list">
        {!isLoading && sortedIdentities.length === 0 ? (
          <p className="search-empty">{t("trustPanelEmpty")}</p>
        ) : (
          sortedIdentities.map((ti) => {
            const alert = peerTrustAlerts[`${otherUser.id}:${ti.deviceId}`];
            // Safety number is derived from the PINNED identity key (this
            // device's local TOFU baseline), never from a bundle freshly
            // fetched from the server — computing it from a server-supplied
            // key would let a compromised server show the user a number
            // that matches its own MITM key, making verification pointless.
            const safetyNumber = myPublicKey
              ? computeSafetyNumber(myPublicKey, ti.identityKey)
              : null;

            return (
              <div
                key={ti.deviceId}
                className={alert ? "trust-item trust-item-alert" : "trust-item"}
              >
                {alert && (
                  <div className="trust-item-alert-tag">
                    {t(TRUST_ALERT_LABEL_KEYS[alert.kind])}
                  </div>
                )}
                <div className="trust-item-header">
                  <span className="trust-item-device">{ti.deviceId.slice(0, 8)}</span>
                  <span className={`trust-item-badge ${ti.verified ? "verified" : "unverified"}`}>
                    {ti.verified ? t("verified") : t("unverified")}
                  </span>
                </div>
                {safetyNumber && <code className="e2ee-fingerprint">{safetyNumber}</code>}
                {!ti.verified && (
                  <button
                    type="button"
                    className="trust-verify-btn"
                    onClick={() => handleMarkVerified(ti.deviceId)}
                  >
                    {t("markVerified")}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="trust-panel-hint">{t("trustPanelHint")}</p>
    </div>
  );
}

export default DMSafetyNumberPanel;
