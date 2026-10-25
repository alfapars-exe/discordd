import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteAccount, getDeletionStatus, type DeletionStatus } from "../../api/accountDeletion";
import { getAuthGeneration } from "../../api/client";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";
import ServerOwnershipTransfer from "./ServerOwnershipTransfer";

export default function AccountDeletionSettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const [state, setState] = useState<DeletionStatus | null>(null);
  const [password, setPassword] = useState(""), [code, setCode] = useState(""), [text, setText] = useState("");
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [generation] = useState(getAuthGeneration);
  const alive = useRef(true), pending = useRef(false), revision = useRef(0);
  const current = () => alive.current && getAuthGeneration() === generation && useAuthStore.getState().user?.id === userID;
  useSettingsDraft(!!password || !!code || !!text || consent);
  async function load(offset: number, own: number) {
    const response = await getDeletionStatus(userID, offset, current);
    if (!current() || revision.current !== own) return;
    if (!response.success || !response.data) { setState(null); setError(t("deletion.loadError")); return; }
    const data = response.data;
    setState(previous => offset && previous && previous.owned_count === data.owned_count ? { ...data, resources: [...new Map([...previous.resources, ...data.resources].map(resource => [`${resource.kind}:${resource.id}`, resource])).values()] } : data);
  }
  useEffect(() => {
    alive.current = true; const own = ++revision.current;
    void load(0, own).catch(() => { if (current() && revision.current === own) { setState(null); setError(t("deletion.loadError")); } })
      .finally(() => { if (current() && revision.current === own) setBusy(false); });
    return () => { alive.current = false; };
    // Keyed owner and auth generation define the request lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userID, generation]);
  async function refresh(offset = 0) {
    if (busy || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await load(offset, ++revision.current); }
    catch { if (current()) { setState(null); setError(t("deletion.loadError")); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  const blocked = !state || state.platform_admin || state.owned_count !== 0;
  async function remove() {
    if (busy || pending.current || blocked || !password || text !== "DELETE" || !consent) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const approved = await useConfirmStore.getState().open({ title: t("deletion.title"), message: t("deletion.finalConfirm"), confirmLabel: t("deletion.remove"), cancelLabel: t("sessions.cancel"), danger: true });
      if (!approved || !current()) return;
      const result = await deleteAccount(userID, password, code, text, current);
      if (!current()) return;
      if (!result.success || result.data?.deleted !== true || result.data.shared_history !== "retained" || result.data.personal_asset_cleanup !== "queued") {
        const key = result.code === "MFA_REQUIRED" ? "sessions.factorRequired" : result.code === "MFA_INVALID" ? "mfa.invalid" : result.code === "MFA_RATE_LIMITED" ? "mfa.rateLimited" : result.code === "ACCOUNT_OWNS_SERVERS" || result.code === "ACCOUNT_OWNS_APPLICATIONS" || result.code === "ACCOUNT_IS_PLATFORM_ADMIN" ? "deletion.changed" : "deletion.error";
        setError(t(key)); setState(null); return;
      }
      setPassword(""); setCode(""); setText(""); setConsent(false);
      await useAuthStore.getState().logout({ localOnly: true, expectedUserId: userID });
    } catch { if (current()) { setError(t("deletion.error")); setState(null); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  return <section aria-labelledby="settings-security-deletion" aria-busy={busy}>
    <div className="settings-divider" />
    <h3 id="settings-security-deletion" data-settings-section="deletion" className="settings-section-subtitle">{t("deletion.title")}</h3>
    <p className="settings-hint">{t("deletion.description")}</p>
    <p className="settings-hint">{t("deletion.retention")}</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {busy && <p role="status">{t("loading")}</p>}
    {state && <>
      {state.platform_admin && <p>{t("deletion.admin")}</p>}
      <p>{t("deletion.owned", { count: state.owned_count })}</p>
      {state.owned_count > 0 && <p className="settings-hint">{t("deletion.handoff")}</p>}
      <ul>{state.resources.map(resource => <li key={`${resource.kind}:${resource.id}`} style={{ overflowWrap: "anywhere" }}>{t(`deletion.${resource.kind}`)}: {resource.name} <small>({resource.id})</small>{resource.kind === "server" && <ServerOwnershipTransfer key={`${userID}:${resource.id}`} userID={userID} serverID={resource.id} onTransferred={() => void refresh()} />}{resource.kind === "application" && <button type="button" className="settings-btn" onClick={() => useSettingsStore.getState().setActiveTab("applications")}>{t("applications.title")}</button>}</li>)}</ul>
      {state.next_offset !== null && <button type="button" className="settings-btn" disabled={busy} onClick={() => void refresh(state.next_offset!)}>{t("deletion.more")}</button>}
    </>}
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void refresh()}>{t("deletion.refresh")}</button>
    <div className="settings-field"><label htmlFor="delete-password" className="settings-label">{t("currentPassword")}</label><input id="delete-password" type="password" autoComplete="current-password" className="settings-input" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></div>
    <div className="settings-field"><label htmlFor="delete-code" className="settings-label">{t("mfa.code")}</label><input id="delete-code" autoComplete="one-time-code" className="settings-input" value={code} maxLength={64} onChange={e => setCode(e.target.value)} disabled={busy} /><p className="settings-hint">{t("sessions.factorHint")}</p></div>
    <div className="settings-field"><label htmlFor="delete-text" className="settings-label">{t("deletion.type")}</label><input id="delete-text" autoComplete="off" spellCheck={false} className="settings-input" value={text} onChange={e => setText(e.target.value)} disabled={busy} /></div>
    <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} /> {t("deletion.consent")}</label>
    <div><button type="button" className="settings-btn settings-btn-danger" disabled={busy || blocked || !password || text !== "DELETE" || !consent} onClick={() => void remove()}>{t("deletion.remove")}</button></div>
  </section>;
}
