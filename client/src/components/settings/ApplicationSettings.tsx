import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  createApplication, invokeApplicationTest, listApplicationManifests, listApplications, listIncomingApplicationTransfers, removeApplication, requestApplicationTransfer,
  resolveApplicationTransfer, revokeApplicationCredentials, type ApplicationIdentity, type ApplicationTransferRequest,
  saveApplicationManifest, type ApplicationAction, type ApplicationManifest,
} from "../../api/applications";
import { getAuthGeneration } from "../../api/client";
import { registerGameApplication } from "../../api/gameApplications";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";

type RemovalDraft = { password: string; code: string; text: string; consent: boolean };
const emptyRemoval: RemovalDraft = { password: "", code: "", text: "", consent: false };

export default function ApplicationSettings() {
  const { t } = useTranslation("settings");
  const ownerID = useAuthStore((state) => state.user?.id) ?? "";
  const [generation] = useState(getAuthGeneration);
  const alive = useRef(true), pending = useRef(false), revision = useRef(0);
  const [applications, setApplications] = useState<ApplicationIdentity[]>([]);
  const [manifests, setManifests] = useState<ApplicationManifest[]>([]);
  const [incoming, setIncoming] = useState<ApplicationTransferRequest[]>([]);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [oneTimeToken, setOneTimeToken] = useState("");
  const [transferID, setTransferID] = useState<string | null>(null);
  const [recipientUsername, setRecipientUsername] = useState("");
  const [editingManifestID, setEditingManifestID] = useState<string | null>(null);
  const [manifestDescription, setManifestDescription] = useState("");
  const [manifestTestMode, setManifestTestMode] = useState(false);
  const [manifestActions, setManifestActions] = useState<ApplicationAction[]>([]);
  const [actionName, setActionName] = useState(""), [actionLabel, setActionLabel] = useState("");
  const [removingID, setRemovingID] = useState<string | null>(null);
  const [removal, setRemoval] = useState<RemovalDraft>(emptyRemoval);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const current = () => alive.current && ownerID !== "" && getAuthGeneration() === generation && useAuthStore.getState().user?.id === ownerID;
  useSettingsDraft(!!username || !!displayName || !!oneTimeToken || !!removingID || !!transferID || !!recipientUsername || !!editingManifestID || !!removal.password || !!removal.code || !!removal.text || removal.consent);

  async function load(own: number) {
    const [result, transfers, manifestResult] = await Promise.all([listApplications(current), listIncomingApplicationTransfers(current), listApplicationManifests(current)]);
    if (!current() || revision.current !== own) return;
    if (!result.success || !result.data) { setApplications([]); setError(t("applications.loadError")); return; }
    setApplications(result.data.bots ?? []);
    if (!transfers.success || !transfers.data) { setIncoming([]); setError(t("applications.loadError")); return; }
    setIncoming(transfers.data.requests ?? []);
    if (!manifestResult.success || !manifestResult.data) { setManifests([]); setError(t("applications.loadError")); return; }
    setManifests(manifestResult.data.applications ?? []);
  }

  useEffect(() => {
    alive.current = true;
    const own = ++revision.current;
    void load(own).catch(() => { if (current() && revision.current === own) setError(t("applications.loadError")); })
      .finally(() => { if (current() && revision.current === own) setBusy(false); });
    return () => { alive.current = false; };
    // Account identity/generation define this panel's request lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerID, generation]);

  async function refresh() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { await load(++revision.current); }
    catch { if (current()) setError(t("applications.loadError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function create() {
    if (pending.current || !username.trim() || !displayName.trim()) return;
    pending.current = true; setBusy(true); setError(""); setNotice(""); setOneTimeToken("");
    try {
      const result = await createApplication(username, displayName, current);
      if (!current()) return;
      if (!result.success || !result.data?.bot || !result.data.token) { setError(t("applications.createError")); return; }
      setApplications((items) => [...items, result.data!.bot]);
      setOneTimeToken(result.data.token); setUsername(""); setDisplayName("");
    } catch { if (current()) setError(t("applications.createError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function revoke(application: ApplicationIdentity) {
    if (pending.current) return;
    const approved = await useConfirmStore.getState().open({
      title: t("applications.revoke"), message: t("applications.revokeConfirm", { name: application.display_name || application.username }),
      confirmLabel: t("applications.revoke"), cancelLabel: t("sessions.cancel"), danger: true,
    });
    if (!approved || !current()) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await revokeApplicationCredentials(application.id, current);
      if (!current()) return;
      if (!result.success) { setError(t("applications.revokeError")); return; }
      setNotice(t("applications.revoked"));
    } catch { if (current()) setError(t("applications.revokeError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function registerGame(application: ApplicationIdentity) {
    if (pending.current || !current()) return;
    const approved = await useConfirmStore.getState().open({
      title: t("linkedGames.register"), message: t("linkedGames.registerConfirm", { name: application.display_name || application.username }),
      confirmLabel: t("linkedGames.register"), cancelLabel: t("sessions.cancel"),
    });
    if (!approved || pending.current || !current()) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await registerGameApplication(application.id, current);
      if (!current()) return;
      if (!result.success || result.data?.application_id !== application.id) { setError(t("linkedGames.saveError")); return; }
      setApplications(items => items.map(item => item.id === application.id ? { ...item, is_game_application: true } : item));
    } catch { if (current()) setError(t("linkedGames.saveError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function remove(application: ApplicationIdentity) {
    if (pending.current || removal.text !== "REMOVE" || !removal.consent || !removal.password) return;
    const approved = await useConfirmStore.getState().open({
      title: t("applications.remove"), message: t("applications.removeConfirm", { name: application.display_name || application.username }),
      confirmLabel: t("applications.remove"), cancelLabel: t("sessions.cancel"), danger: true,
    });
    if (!approved || !current() || removingID !== application.id) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await removeApplication(ownerID, application.id, removal.password, removal.code, removal.text, current);
      if (!current()) return;
      if (!result.success || result.data?.removed !== true || result.data.shared_history !== "retained" || result.data.personal_asset_cleanup !== "queued") {
        const key = result.code === "MFA_REQUIRED" ? "sessions.factorRequired" : result.code === "MFA_INVALID" ? "mfa.invalid" : result.code === "MFA_RATE_LIMITED" ? "mfa.rateLimited" : result.code === "APPLICATION_OWNS_SERVERS" || result.code === "APPLICATION_OWNS_APPLICATIONS" ? "applications.handoffRequired" : "applications.removeError";
        setError(t(key)); await load(++revision.current); return;
      }
      setApplications((items) => items.filter((item) => item.id !== application.id));
      setRemovingID(null); setRemoval(emptyRemoval); setNotice(t("applications.removed"));
    } catch { if (current()) { setError(t("applications.removeError")); try { await load(++revision.current); } catch { /* uncertain outcome stays explicit */ } } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function transfer(application: ApplicationIdentity) {
    if (pending.current || !recipientUsername.trim()) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await requestApplicationTransfer(application.id, recipientUsername, current);
      if (!current()) return;
      if (!result.success) { setError(t("applications.transferError")); return; }
      setTransferID(null); setRecipientUsername(""); setNotice(t("applications.transferRequested"));
    } catch { if (current()) setError(t("applications.transferError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function resolveTransfer(request: ApplicationTransferRequest, accept: boolean) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await resolveApplicationTransfer(request.id, accept, current);
      if (!current()) return;
      if (!result.success || result.data?.accepted !== accept || (accept && !result.data.token)) { setError(t("applications.transferResolveError")); return; }
      setIncoming(items => items.filter(item => item.id !== request.id));
      if (accept) { setOneTimeToken(result.data!.token!); await load(++revision.current); }
      setNotice(t(accept ? "applications.transferAccepted" : "applications.transferDeclined"));
    } catch { if (current()) setError(t("applications.transferResolveError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  function editManifest(applicationID: string) {
    if (editingManifestID === applicationID) { setEditingManifestID(null); return; }
    const manifest = manifests.find(item => item.application_id === applicationID);
    setEditingManifestID(applicationID); setManifestDescription(manifest?.description ?? ""); setManifestTestMode(manifest?.test_mode ?? false);
    setManifestActions((manifest?.actions ?? []).map(action => ({ ...action, context: "message" }))); setActionName(""); setActionLabel("");
  }

  async function saveManifest() {
    if (!editingManifestID || pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await saveApplicationManifest(editingManifestID, manifestDescription, manifestTestMode, manifestActions.map(({ name, label }) => ({ name, label, context: "message" })), current);
      if (!current()) return;
      if (!result.success || !result.data) { setError(t("applications.manifestSaveError")); return; }
      setManifests(items => [...items.filter(item => item.application_id !== editingManifestID), result.data!]); setEditingManifestID(null); setNotice(t("applications.manifestSaved"));
    } catch { if (current()) setError(t("applications.manifestSaveError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function testAction(applicationID: string, actionID?: string) {
    if (!actionID || pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    try { const result = await invokeApplicationTest(applicationID, actionID, current); if (!current()) return; if (!result.success) setError(t("applications.testError")); else setNotice(t("applications.testQueued")); }
    catch { if (current()) setError(t("applications.testError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  return <section aria-labelledby="settings-applications" aria-busy={busy}>
    <h2 id="settings-applications" className="settings-section-title">{t("applications.title")}</h2>
    <p className="settings-hint">{t("applications.description")}</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="settings-field"><label htmlFor="application-username" className="settings-label">{t("applications.username")}</label><input id="application-username" className="settings-input" value={username} minLength={3} maxLength={32} autoComplete="off" onChange={(event) => setUsername(event.target.value)} disabled={busy} /></div>
    <div className="settings-field"><label htmlFor="application-name" className="settings-label">{t("applications.displayName")}</label><input id="application-name" className="settings-input" value={displayName} minLength={1} maxLength={32} autoComplete="off" onChange={(event) => setDisplayName(event.target.value)} disabled={busy} /></div>
    <button type="button" className="settings-btn" disabled={busy || !username.trim() || !displayName.trim()} onClick={() => void create()}>{t("applications.create")}</button>
    {oneTimeToken && <div role="status" className="settings-field"><label htmlFor="application-token" className="settings-label">{t("applications.token")}</label><p className="settings-hint">{t("applications.tokenWarning")}</p><input id="application-token" className="settings-input" readOnly value={oneTimeToken} onFocus={(event) => event.currentTarget.select()} /><button type="button" className="settings-btn" onClick={() => void navigator.clipboard.writeText(oneTimeToken)}>{t("applications.copyToken")}</button><button type="button" className="settings-btn" onClick={() => setOneTimeToken("")}>{t("applications.tokenSaved")}</button></div>}
    <div className="settings-divider" />
    <h3 className="settings-section-subtitle">{t("applications.owned")}</h3>
    {!busy && applications.length === 0 && <p>{t("applications.empty")}</p>}
    <ul style={{ listStyle: "none", padding: 0 }}>{applications.map((application) => <li key={application.id} style={{ borderBottom: "1px solid var(--border-color, #555)", padding: "16px 0", overflowWrap: "anywhere" }}>
      <strong>{application.display_name || application.username}</strong><div className="settings-hint">@{application.username} · {application.id}</div>
      {application.is_game_application ? <p className="settings-hint">{t("linkedGames.registered")}</p> : <button type="button" className="settings-btn" disabled={busy} onClick={() => void registerGame(application)}>{t("linkedGames.register")}</button>}
      <button type="button" className="settings-btn" disabled={busy} onClick={() => void revoke(application)}>{t("applications.revoke")}</button>{" "}
      <button type="button" className="settings-btn" disabled={busy} onClick={() => editManifest(application.id)}>{t("applications.configure")}</button>{" "}
      <button type="button" className="settings-btn" disabled={busy} onClick={() => { setTransferID(transferID === application.id ? null : application.id); setRecipientUsername(""); }}>{t("applications.transfer")}</button>{" "}
      <button type="button" className="settings-btn settings-btn-danger" disabled={busy} onClick={() => { setRemovingID(removingID === application.id ? null : application.id); setRemoval(emptyRemoval); setError(""); }}>{t("applications.remove")}</button>
      {transferID === application.id && <div className="settings-field"><label htmlFor={`transfer-app-${application.id}`} className="settings-label">{t("applications.recipient")}</label><input id={`transfer-app-${application.id}`} className="settings-input" autoComplete="off" value={recipientUsername} onChange={event => setRecipientUsername(event.target.value)} disabled={busy} /><button type="button" className="settings-btn" disabled={busy || !recipientUsername.trim()} onClick={() => void transfer(application)}>{t("applications.requestTransfer")}</button></div>}
      {editingManifestID === application.id && <div className="settings-field">
        <label htmlFor={`manifest-description-${application.id}`} className="settings-label">{t("applications.manifestDescription")}</label><textarea id={`manifest-description-${application.id}`} className="settings-input" maxLength={500} value={manifestDescription} onChange={event => setManifestDescription(event.target.value)} disabled={busy} />
        <label><input type="checkbox" checked={manifestTestMode} onChange={event => setManifestTestMode(event.target.checked)} disabled={busy} /> {t("applications.testMode")}</label>
        <h4>{t("applications.messageActions")}</h4>
        <ul>{manifestActions.map((action, index) => <li key={`${action.name}-${index}`}><strong>{action.label}</strong> · {action.name} {manifestTestMode && action.id && <button type="button" className="settings-btn" disabled={busy} onClick={() => void testAction(application.id, action.id)}>{t("applications.testAction")}</button>} <button type="button" className="settings-btn settings-btn-danger" disabled={busy} onClick={() => setManifestActions(items => items.filter((_, itemIndex) => itemIndex !== index))}>{t("applications.removeAction")}</button></li>)}</ul>
        <label htmlFor={`action-name-${application.id}`} className="settings-label">{t("applications.actionName")}</label><input id={`action-name-${application.id}`} className="settings-input" value={actionName} pattern="[a-z0-9_]+" maxLength={32} onChange={event => setActionName(event.target.value.toLowerCase())} disabled={busy} />
        <label htmlFor={`action-label-${application.id}`} className="settings-label">{t("applications.actionLabel")}</label><input id={`action-label-${application.id}`} className="settings-input" value={actionLabel} maxLength={64} onChange={event => setActionLabel(event.target.value)} disabled={busy} />
        <button type="button" className="settings-btn" disabled={busy || !/^[a-z0-9_]{1,32}$/.test(actionName) || !actionLabel.trim() || manifestActions.length >= 10} onClick={() => { setManifestActions(items => [...items, { name: actionName, label: actionLabel.trim(), context: "message" }]); setActionName(""); setActionLabel(""); }}>{t("applications.addAction")}</button>{" "}
        <button type="button" className="settings-btn" disabled={busy} onClick={() => void saveManifest()}>{t("applications.saveManifest")}</button>
      </div>}
      {removingID === application.id && <div>
        <p className="settings-hint">{t("applications.retention")}</p>
        <div className="settings-field"><label htmlFor={`remove-app-password-${application.id}`} className="settings-label">{t("currentPassword")}</label><input id={`remove-app-password-${application.id}`} type="password" autoComplete="current-password" className="settings-input" value={removal.password} onChange={(event) => setRemoval({ ...removal, password: event.target.value })} disabled={busy} /></div>
        <div className="settings-field"><label htmlFor={`remove-app-code-${application.id}`} className="settings-label">{t("mfa.code")}</label><input id={`remove-app-code-${application.id}`} autoComplete="one-time-code" maxLength={64} className="settings-input" value={removal.code} onChange={(event) => setRemoval({ ...removal, code: event.target.value })} disabled={busy} /></div>
        <div className="settings-field"><label htmlFor={`remove-app-text-${application.id}`} className="settings-label">{t("applications.typeRemove")}</label><input id={`remove-app-text-${application.id}`} autoComplete="off" spellCheck={false} className="settings-input" value={removal.text} onChange={(event) => setRemoval({ ...removal, text: event.target.value })} disabled={busy} /></div>
        <label><input type="checkbox" checked={removal.consent} onChange={(event) => setRemoval({ ...removal, consent: event.target.checked })} disabled={busy} /> {t("applications.consent")}</label>
        <div><button type="button" className="settings-btn settings-btn-danger" disabled={busy || !removal.password || removal.text !== "REMOVE" || !removal.consent} onClick={() => void remove(application)}>{t("applications.confirmRemove")}</button></div>
      </div>}
    </li>)}</ul>
    <div className="settings-divider" />
    <h3 className="settings-section-subtitle">{t("applications.incoming")}</h3>
    {!busy && incoming.length === 0 && <p>{t("applications.noIncoming")}</p>}
    <ul style={{ listStyle: "none", padding: 0 }}>{incoming.map(request => <li key={request.id} style={{ borderBottom: "1px solid var(--border-color, #555)", padding: "16px 0" }}><strong>{request.application_name}</strong><div className="settings-hint">@{request.application_username} · {t("applications.from", { name: request.from_name })}</div><button type="button" className="settings-btn" disabled={busy} onClick={() => void resolveTransfer(request, true)}>{t("applications.acceptTransfer")}</button>{" "}<button type="button" className="settings-btn settings-btn-danger" disabled={busy} onClick={() => void resolveTransfer(request, false)}>{t("applications.declineTransfer")}</button></li>)}</ul>
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void refresh()}>{t("applications.refresh")}</button>
  </section>;
}
