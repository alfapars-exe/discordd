import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { disableAccount } from "../../api/accountLifecycle";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";

export default function AccountLifecycleSettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [generation] = useState(getAuthGeneration);
  const alive = useRef(true), pending = useRef(false);
  const current = () => alive.current && getAuthGeneration() === generation && useAuthStore.getState().user?.id === userID;
  useSettingsDraft(!!password || !!code || busy);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function disable() {
    if (pending.current || !password) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const approved = await useConfirmStore.getState().open({ title: t("lifecycle.disableTitle"), message: t("lifecycle.confirm"), confirmLabel: t("lifecycle.disable"), cancelLabel: t("sessions.cancel"), danger: true });
      if (!approved || !current()) return;
      const result = await disableAccount(userID, password, code, current);
      if (!current()) return;
      if (!result.success || !result.data?.disabled) {
        setError(t(result.code === "MFA_REQUIRED" ? "sessions.factorRequired" : result.code === "MFA_INVALID" ? "mfa.invalid" : result.code === "MFA_RATE_LIMITED" ? "mfa.rateLimited" : "lifecycle.error"));
        return;
      }
      setPassword(""); setCode("");
      await useAuthStore.getState().logout({ localOnly: true, expectedUserId: userID });
    } catch { if (current()) setError(t("lifecycle.error")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  return <section aria-labelledby="settings-security-lifecycle">
    <div className="settings-divider" />
    <h3 id="settings-security-lifecycle" data-settings-section="lifecycle" className="settings-section-subtitle">{t("lifecycle.title")}</h3>
    <p className="settings-hint">{t("lifecycle.description")}</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    <div className="settings-field">
      <label htmlFor="disable-password" className="settings-label">{t("currentPassword")}</label>
      <input id="disable-password" type="password" autoComplete="current-password" className="settings-input" value={password} onChange={event => setPassword(event.target.value)} disabled={busy} />
    </div>
    <div className="settings-field">
      <label htmlFor="disable-code" className="settings-label">{t("mfa.code")}</label>
      <input id="disable-code" type="text" autoComplete="one-time-code" maxLength={64} className="settings-input" value={code} onChange={event => setCode(event.target.value)} disabled={busy} />
      <p className="settings-hint">{t("sessions.factorHint")}</p>
    </div>
    <button type="button" className="settings-btn settings-btn-danger" disabled={busy || !password} onClick={() => void disable()}>{t("lifecycle.disable")}</button>
  </section>;
}
