import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as api from "../../api/sessions";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";
import { formatDateTime } from "../../utils/dateFormat";

export default function SessionSettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const [sessions, setSessions] = useState<api.AuthSession[]>([]);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [generation] = useState(getAuthGeneration);
  const alive = useRef(true), pending = useRef(false), revision = useRef(0);
  const current = () => alive.current && getAuthGeneration() === generation && useAuthStore.getState().user?.id === userID;
  useSettingsDraft(!!(password || code || busy));

  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const own = ++revision.current;
    void api.getSessions(userID, () => !cancelled && current()).then(res => {
      if (cancelled || !current() || revision.current !== own) return;
      if (res.success && res.data) { setSessions(res.data.sessions); setLoaded(true); }
      else setError(t("sessions.loadError"));
    }).catch(() => { if (!cancelled && current() && revision.current === own) setError(t("sessions.loadError")); });
    return () => { cancelled = true; alive.current = false; };
    // The generation/user key defines the complete owner lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userID, generation]);

  async function refresh() {
    const own = ++revision.current; setError("");
    try {
      const res = await api.getSessions(userID, current);
      if (!current() || revision.current !== own) return;
      if (res.success && res.data) { setSessions(res.data.sessions); setLoaded(true); }
      else setError(t("sessions.loadError"));
    } catch { if (current() && revision.current === own) setError(t("sessions.loadError")); }
  }

  async function revoke(target: string, isSelf = false) {
    if (pending.current || !password) return;
    pending.current = true; setBusy(true); setError(""); setMessage("");
    try {
      const approved = await useConfirmStore.getState().open({
        message: t(isSelf ? "sessions.confirmSelf" : target === "others" ? "sessions.confirmOthers" : "sessions.confirmOne"),
        confirmLabel: t("sessions.revoke"), cancelLabel: t("sessions.cancel"), danger: true,
      });
      if (!approved || !current()) return;
      const res = await api.revokeSession(userID, target, password, code, current);
      if (!current()) return;
      if (!res.success || !res.data) {
        setError(t(res.code === "MFA_REQUIRED" ? "sessions.factorRequired" : res.code === "MFA_INVALID" ? "mfa.invalid" : res.code === "MFA_RATE_LIMITED" ? "mfa.rateLimited" : "sessions.revokeError"));
        return;
      }
      setPassword(""); setCode("");
      if (res.data.current_revoked) { void useAuthStore.getState().logout({ localOnly: true, expectedUserId: userID }); return; }
      setSessions(list => target === "others" ? list.filter(s => s.current) : list.filter(s => s.id !== target));
      setMessage(t("sessions.revoked", { count: res.data.revoked_count }));
      await refresh();
    } catch { if (current()) setError(t("sessions.revokeError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  const date = (seconds: number) => formatDateTime(seconds * 1000);
  return <section aria-labelledby="settings-security-sessions">
    <div className="settings-divider" />
    <h3 id="settings-security-sessions" className="settings-section-subtitle" data-settings-section="sessions">{t("sessions.title")}</h3>
    <p className="settings-hint">{t("sessions.description")}</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {!loaded && !error && <p role="status">{t("loading")}</p>}
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void refresh()}>{t("sessions.refresh")}</button>
    {loaded && <>
      <div className="settings-field" style={{ marginTop: 20 }}>
        <label className="settings-label" htmlFor="session-password">{t("currentPassword")}</label>
        <input id="session-password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} className="settings-input" />
      </div>
      <div className="settings-field">
        <label className="settings-label" htmlFor="session-code">{t("mfa.code")}</label>
        <input id="session-code" type="text" autoComplete="one-time-code" maxLength={64} value={code} onChange={e => setCode(e.target.value)} disabled={busy} className="settings-input" />
        <p className="settings-hint">{t("sessions.factorHint")}</p>
      </div>
      <button type="button" className="settings-btn settings-btn-danger" disabled={busy || !password || !sessions.some(s => !s.current)} onClick={() => void revoke("others")}>{t("sessions.revokeOthers")}</button>
      <ul aria-label={t("sessions.title")} style={{ padding: 0, listStyle: "none" }}>
        {sessions.map(s => <li key={s.id} style={{ borderBottom: "1px solid var(--border-color, #555)", padding: "20px 0", overflowWrap: "anywhere" }}>
          <h4>{t(s.client_type === "electron" ? "sessions.desktop" : s.client_type === "web" ? "sessions.web" : "sessions.unknown")}{s.current && ` · ${t("sessions.current")}`}</h4>
          {s.user_agent && <p className="settings-hint">{s.user_agent}</p>}
          <p className="settings-hint">{t("sessions.created")}: {date(s.created_at)}</p>
          <p className="settings-hint">{t("sessions.lastActive")}: {date(s.last_active_at)}</p>
          <p className="settings-hint">{t("sessions.expires")}: {date(s.expires_at)}</p>
          <button type="button" className="settings-btn settings-btn-danger" disabled={busy || !password} onClick={() => void revoke(s.id, s.current)}>{t(s.current ? "sessions.revokeCurrent" : "sessions.revoke")}</button>
        </li>)}
      </ul>
      {!sessions.length && <p role="status">{t("sessions.empty")}</p>}
    </>}
  </section>;
}
