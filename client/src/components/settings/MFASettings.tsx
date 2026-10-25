import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as mfa from "../../api/mfa";
import { useAuthStore } from "../../stores/authStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";

export default function MFASettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<mfa.MFAStatus | null>(null);
  const [setup, setSetup] = useState<mfa.MFASetup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);
  const alive = useRef(true);
  const pending = useRef(false);
  const current = () => alive.current && useAuthStore.getState().user?.id === userID;
  useSettingsDraft(!!(password || code || setup || codes.length || busy));

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    void mfa.getMFAStatus(userID).then(res => {
      if (cancelled) return;
      if (res.success && res.data) setStatus(res.data);
      else setError(t("mfa.loadError"));
    }).catch(() => { if (!cancelled) setError(t("mfa.loadError")); });
    return () => { cancelled = true; alive.current = false; };
  }, [userID, t]);

  function failure(code?: string) {
    if (code === "MFA_INVALID") return t("mfa.invalid");
    if (code === "MFA_RATE_LIMITED") return t("mfa.rateLimited");
    if (code === "ACCOUNT_MISMATCH") return t("securityAccountChanged");
    return t("mfa.operationError");
  }

  async function act(action: "setup" | "cancel" | "confirm" | "recovery" | "disable" | "refresh") {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      if (action === "refresh") {
        const res = await mfa.getMFAStatus(userID); if (!current()) return;
        if (!res.success || !res.data) { setError(failure(res.code)); return; }
        setStatus(res.data); if (res.data.enabled) setSetup(null);
      } else if (action === "cancel") {
        const res = await mfa.cancelMFA(userID, setup!.setup_id); if (!current()) return;
        if (!res.success) { setError(failure(res.code)); return; }
        setSetup(null); setCode("");
      } else if (action === "setup") {
        const res = await mfa.beginMFA(userID, password); if (!current()) return;
        if (!res.success || !res.data) { setError(failure(res.code)); return; }
        setSetup(res.data); setPassword(""); setCode("");
      } else if (action === "confirm" || action === "recovery") {
        const res = action === "confirm"
          ? await mfa.confirmMFA(userID, setup!.setup_id, code)
          : await mfa.regenerateMFA(userID, password, code);
        if (!current()) return;
        if (!res.success || !res.data) { setError(failure(res.code)); return; }
        setCodes(res.data.recovery_codes); setStatus({ enabled: true, recovery_remaining: res.data.recovery_codes.length });
        setSetup(null); setPassword(""); setCode("");
      } else {
        const res = await mfa.disableMFA(userID, password, code); if (!current()) return;
        if (!res.success) { setError(failure(res.code)); return; }
        setStatus({ enabled: false, recovery_remaining: 0 }); setConfirmDisable(false); setPassword(""); setCode(""); setCodes([]);
      }
    } catch { if (current()) setError(t("mfa.operationError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  return <section aria-labelledby="settings-security-mfa">
    <div className="settings-divider" />
    <h3 id="settings-security-mfa" className="settings-section-subtitle" data-settings-section="mfa">{t("mfa.title")}</h3>
    <p className="settings-hint">{t("mfa.description")}</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    <p role="status">{status ? t(status.enabled ? "mfa.enabled" : "mfa.disabled", { count: status.recovery_remaining }) : t("loading")}</p>
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void act("refresh")}>{t("mfa.refresh")}</button>
    {codes.length > 0 ? <>
      <p className="settings-hint">{t("mfa.saveCodes")}</p>
      <ul aria-label={t("mfa.recoveryCodes")} style={{ overflowWrap: "anywhere", userSelect: "text" }}>{codes.map(c => <li key={c}><code>{c}</code></li>)}</ul>
      <button type="button" className="settings-btn" onClick={() => setCodes([])}>{t("mfa.codesSaved")}</button>
    </> : status && <>
      {setup ? <>
        <p className="settings-hint">{t("mfa.setupInstructions")}</p>
        <p style={{ overflowWrap: "anywhere", userSelect: "text" }}><code aria-label={t("mfa.setupKey")}>{setup.secret}</code></p>
        <p className="settings-hint">{t("mfa.setupExpiry")}</p>
      </> : <div className="settings-field">
        <label htmlFor="mfa-password" className="settings-label">{t("currentPassword")}</label>
        <input id="mfa-password" type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" className="settings-input" disabled={busy} />
      </div>}
      {(setup || status.enabled) && <div className="settings-field">
        <label htmlFor="mfa-manage-code" className="settings-label">{t("mfa.code")}</label>
        <input id="mfa-manage-code" type="text" value={code} onChange={e => setCode(e.target.value)} autoComplete="one-time-code" maxLength={64} className="settings-input" disabled={busy} />
      </div>}
      <div className="settings-btn-row">
        {!status.enabled && !setup && <button type="button" className="settings-btn" disabled={busy || !password} onClick={() => void act("setup")}>{t("mfa.begin")}</button>}
        {setup && <>
          <button type="button" className="settings-btn" disabled={busy || !code} onClick={() => void act("confirm")}>{t("mfa.confirm")}</button>
          <button type="button" className="settings-btn" disabled={busy} onClick={() => void act("cancel")}>{t("mfa.cancelSetup")}</button>
        </>}
        {status.enabled && <>
          <button type="button" className="settings-btn" disabled={busy || !password || !code} onClick={() => void act("recovery")}>{t("mfa.regenerate")}</button>
          {!confirmDisable ? <button type="button" className="settings-btn settings-btn-danger" disabled={busy || !password || !code} onClick={() => setConfirmDisable(true)}>{t("mfa.disable")}</button> : <>
            <p role="alert">{t("mfa.disableWarning")}</p>
            <button type="button" className="settings-btn settings-btn-danger" disabled={busy || !password || !code} onClick={() => void act("disable")}>{t("mfa.confirmDisable")}</button>
            <button type="button" className="settings-btn" disabled={busy} onClick={() => setConfirmDisable(false)}>{t("mfa.keepEnabled")}</button>
          </>}
        </>}
      </div>
    </>}
  </section>;
}
