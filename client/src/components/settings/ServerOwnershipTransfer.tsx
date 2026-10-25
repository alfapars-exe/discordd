import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import { getOwnershipMembers, getOwnershipServer, transferServerOwnership } from "../../api/serverOwnership";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useServerStore } from "../../stores/serverStore";
import { useMemberStore } from "../../stores/memberStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";
import type { MemberWithRoles, Server } from "../../types";

// Key this component by account + server when embedding it in a changing view.
export default function ServerOwnershipTransfer({ userID, serverID, onTransferred }: { userID: string; serverID: string; onTransferred?: (server: Server) => void }) {
  const { t } = useTranslation("settings");
  const id = useId();
  const [generation] = useState(getAuthGeneration);
  const [expanded, setExpanded] = useState(false), [busy, setBusy] = useState(false);
  const [server, setServer] = useState<Server | null>(null), [members, setMembers] = useState<MemberWithRoles[]>([]);
  const [target, setTarget] = useState(""), [query, setQuery] = useState("");
  const [password, setPassword] = useState(""), [code, setCode] = useState(""), [text, setText] = useState("");
  const [consent, setConsent] = useState(false), [error, setError] = useState(""), [done, setDone] = useState(false);
  const alive = useRef(true), pending = useRef(false);
  const current = () => alive.current && getAuthGeneration() === generation && useAuthStore.getState().user?.id === userID;
  const dirty = !!password || !!code || !!text || consent || !!target;
  useSettingsDraft(dirty);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  async function load() {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setError(""); setExpanded(true);
    try {
      const [detail, list] = await Promise.all([getOwnershipServer(serverID, current), getOwnershipMembers(serverID, current)]);
      if (!current()) return;
      if (!detail.success || !detail.data || detail.data.id !== serverID || detail.data.owner_id !== userID || !list.success || !list.data) {
        setServer(null); setMembers([]); setError(t("ownership.loadError")); return;
      }
      setServer(detail.data); setMembers(list.data.filter(m => m.id !== userID));
      setTarget(previous => list.data!.some(m => m.id === previous && m.id !== userID) ? previous : "");
    } catch { if (current()) { setServer(null); setMembers([]); setError(t("ownership.loadError")); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function cancel() {
    if (pending.current || !current()) return;
    if (dirty && !await useConfirmStore.getState().open({ title: t("ownership.title"), message: t("ownership.discard"), confirmLabel: t("ownership.discardAction"), cancelLabel: t("sessions.cancel") })) return;
    if (!current()) return;
    setPassword(""); setCode(""); setText(""); setTarget(""); setConsent(false); setExpanded(false); setError("");
  }
  async function transfer() {
    const recipient = members.find(m => m.id === target);
    if (pending.current || !current() || server?.owner_id !== userID || !recipient || !password || text !== "TRANSFER" || !consent) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const approved = await useConfirmStore.getState().open({ title: t("ownership.title"), message: t("ownership.finalConfirm", { server: server.name, target: recipient.display_name || recipient.username, id: recipient.id }), confirmLabel: t("ownership.transfer"), cancelLabel: t("sessions.cancel"), danger: true });
      if (!approved || !current()) return;
      const response = await transferServerOwnership(userID, serverID, recipient.id, password, code, text, current);
      if (!current()) return;
      if (!response.success || !response.data || response.data.id !== serverID || response.data.owner_id !== recipient.id) {
        const key = response.code === "MFA_REQUIRED" ? "sessions.factorRequired" : response.code === "MFA_INVALID" ? "mfa.invalid" : response.code === "MFA_RATE_LIMITED" ? "mfa.rateLimited" : "ownership.error";
        setError(t(key)); setServer(null); return;
      }
      setPassword(""); setCode(""); setText(""); setTarget(""); setConsent(false); setDone(true);
      useServerStore.getState().handleServerUpdate(response.data);
      void useMemberStore.getState().fetchMembers(serverID, true);
      onTransferred?.(response.data);
    } catch { if (current()) { setServer(null); setError(t("ownership.error")); } }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  if (done) return <p role="status">{t("ownership.success")}</p>;
  if (!expanded) return <button type="button" className="settings-btn" onClick={() => void load()}>{t("ownership.open")}</button>;
  const visibleMembers = members.filter(m => `${m.display_name || ""} ${m.username} ${m.id}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div aria-busy={busy} style={{ marginBlock: 12 }}>
    <h4>{t("ownership.title")}</h4>
    <p className="settings-hint">{t("ownership.warning")}</p>
    {server && <p style={{ overflowWrap: "anywhere" }}>{server.name} ({server.id})</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {busy && <p role="status">{t("loading")}</p>}
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void load()}>{t("ownership.refresh")}</button>
    <div className="settings-field"><label htmlFor={`${id}-search`} className="settings-label">{t("ownership.searchMembers")}</label><input id={`${id}-search`} className="settings-input" value={query} onChange={e => setQuery(e.target.value)} disabled={busy} /></div>
    <div className="settings-field"><label htmlFor={`${id}-target`} className="settings-label">{t("ownership.target")}</label><select id={`${id}-target`} className="settings-input" value={target} onChange={e => setTarget(e.target.value)} disabled={busy || !server}>
      <option value="">{t("ownership.choose")}</option>
      {members.filter(m => visibleMembers.includes(m) || m.id === target).map(m => <option key={m.id} value={m.id}>{m.display_name || m.username} — @{m.username} ({m.id})</option>)}
    </select><p className="settings-hint">{t("ownership.eligibility")}</p></div>
    <div className="settings-field"><label htmlFor={`${id}-password`} className="settings-label">{t("currentPassword")}</label><input id={`${id}-password`} type="password" autoComplete="current-password" className="settings-input" value={password} onChange={e => setPassword(e.target.value)} disabled={busy} /></div>
    <div className="settings-field"><label htmlFor={`${id}-code`} className="settings-label">{t("mfa.code")}</label><input id={`${id}-code`} autoComplete="one-time-code" className="settings-input" value={code} maxLength={64} onChange={e => setCode(e.target.value)} disabled={busy} /><p className="settings-hint">{t("sessions.factorHint")}</p></div>
    <div className="settings-field"><label htmlFor={`${id}-text`} className="settings-label">{t("ownership.type")}</label><input id={`${id}-text`} autoComplete="off" spellCheck={false} className="settings-input" value={text} onChange={e => setText(e.target.value)} disabled={busy} /></div>
    <label><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} disabled={busy} /> {t("ownership.consent")}</label>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}><button type="button" className="settings-btn settings-btn-danger" disabled={busy || !server || !target || !password || text !== "TRANSFER" || !consent} onClick={() => void transfer()}>{t("ownership.transfer")}</button><button type="button" className="settings-btn" disabled={busy} onClick={() => void cancel()}>{t("sessions.cancel")}</button></div>
  </div>;
}
