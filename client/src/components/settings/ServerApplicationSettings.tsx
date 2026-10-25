import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SERVER_APPLICATIONS_CHANGED_EVENT, installServerApplication, listServerApplications, revokeServerApplication, type ApplicationInstallation } from "../../api/applications";
import { useSettingsStore } from "../../stores/settingsStore";
import { useConfirmStore } from "../../stores/confirmStore";

function announceServerApplicationsChanged(serverID: string) {
  window.dispatchEvent(new CustomEvent(SERVER_APPLICATIONS_CHANGED_EVENT, { detail: { serverID } }));
}

export default function ServerApplicationSettings() {
  const { t } = useTranslation("settings");
  const serverID = useSettingsStore(state => state.contextServerId) ?? "";
  const alive = useRef(true);
  const [items, setItems] = useState<ApplicationInstallation[]>([]), [applicationID, setApplicationID] = useState("");
  const [readMessage, setReadMessage] = useState(false), [sendResponse, setSendResponse] = useState(true);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  async function load() { const result = await listServerApplications(serverID, () => alive.current); if (!alive.current) return; if (!result.success) setError(t("serverApplications.loadError")); else setItems(result.data?.applications ?? []); }
  useEffect(() => { alive.current = true; void load().finally(() => { if (alive.current) setBusy(false); }); return () => { alive.current = false; }; }, [serverID]); // eslint-disable-line react-hooks/exhaustive-deps
  async function install() {
    if (!applicationID.trim() || (!readMessage && !sendResponse)) return;
    setBusy(true); setError(""); setNotice("");
    const scopes = [...(readMessage ? ["read_message"] : []), ...(sendResponse ? ["send_response"] : [])];
    try { const result = await installServerApplication(serverID, applicationID.trim(), scopes, () => alive.current); if (!alive.current) return; if (!result.success) setError(t("serverApplications.installError")); else { setApplicationID(""); setNotice(t("serverApplications.installed")); announceServerApplicationsChanged(serverID); await load(); } }
    catch { if (alive.current) setError(t("serverApplications.installError")); }
    finally { if (alive.current) setBusy(false); }
  }
  async function revoke(item: ApplicationInstallation) {
    const approved = await useConfirmStore.getState().open({ title: t("serverApplications.revoke"), message: t("serverApplications.revokeConfirm", { name: item.application_name }), confirmLabel: t("serverApplications.revoke"), cancelLabel: t("sessions.cancel"), danger: true });
    if (!approved || !alive.current) return;
    setBusy(true); setError(""); setNotice("");
    try { const result = await revokeServerApplication(serverID, item.application_id, () => alive.current); if (!alive.current) return; if (!result.success) setError(t("serverApplications.revokeError")); else { setNotice(t("serverApplications.revoked")); announceServerApplicationsChanged(serverID); await load(); } }
    catch { if (alive.current) setError(t("serverApplications.revokeError")); }
    finally { if (alive.current) setBusy(false); }
  }
  return <section aria-labelledby="server-applications-title" aria-busy={busy}>
    <h2 id="server-applications-title" className="settings-section-title">{t("serverApplications.title")}</h2>
    <p className="settings-hint">{t("serverApplications.description")}</p>
    {error && <p role="alert" className="auth-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <div className="settings-field"><label htmlFor="server-application-id" className="settings-label">{t("serverApplications.applicationID")}</label><input id="server-application-id" className="settings-input" value={applicationID} onChange={event => setApplicationID(event.target.value)} disabled={busy} /></div>
    <label><input type="checkbox" checked={readMessage} onChange={event => setReadMessage(event.target.checked)} disabled={busy} /> {t("serverApplications.readMessage")}</label><br />
    <label><input type="checkbox" checked={sendResponse} onChange={event => setSendResponse(event.target.checked)} disabled={busy} /> {t("serverApplications.sendResponse")}</label><br />
    <button type="button" className="settings-btn" disabled={busy || !applicationID.trim() || (!readMessage && !sendResponse)} onClick={() => void install()}>{t("serverApplications.install")}</button>
    <div className="settings-divider" /><ul style={{ listStyle: "none", padding: 0 }}>{items.map(item => <li key={item.application_id} style={{ padding: "12px 0", borderBottom: "1px solid var(--border-color, #555)" }}><strong>{item.application_name}</strong><div className="settings-hint">{item.application_id} · {item.scopes.join(", ")} {item.revoked_at ? `· ${t("serverApplications.revokedState")}` : ""}</div>{!item.revoked_at && <button type="button" className="settings-btn settings-btn-danger" disabled={busy} onClick={() => void revoke(item)}>{t("serverApplications.revoke")}</button>}</li>)}</ul>
  </section>;
}
