import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import { listGameApplicationGrants, revokeGameApplicationGrant, updateGameApplicationGrant, type GameApplicationGrant } from "../../api/gameApplications";
import { useAuthStore } from "../../stores/authStore";
import { useConfirmStore } from "../../stores/confirmStore";
import { useSettingsDraft } from "./settingsWorkspaceContext";

export default function LinkedGameSettings() {
  const { t } = useTranslation("settings");
  const owner = useAuthStore(state => state.user?.id) ?? "";
  const [generation] = useState(getAuthGeneration);
  const alive = useRef(false), pending = useRef(false), revision = useRef(0);
  const [grants, setGrants] = useState<GameApplicationGrant[]>([]);
  const [applicationID, setApplicationID] = useState("");
  const [busy, setBusy] = useState(true), [error, setError] = useState("");
  const current = () => alive.current && !!owner && getAuthGeneration() === generation && useAuthStore.getState().user?.id === owner;
  useSettingsDraft(!!applicationID);

  async function load() {
    const own = ++revision.current;
    const result = await listGameApplicationGrants(current);
    if (!current() || revision.current !== own) return false;
    if (!result.success || !result.data) { setError(t("linkedGames.loadError")); return false; }
    setGrants(result.data.grants ?? []);
    return true;
  }
  useEffect(() => {
    alive.current = true;
    const own = ++revision.current;
    void listGameApplicationGrants(current).then(result => {
      if (!current() || revision.current !== own) return;
      if (!result.success || !result.data) { setError(t("linkedGames.loadError")); return; }
      setGrants(result.data.grants ?? []);
    }).catch(() => { if (current() && revision.current === own) setError(t("linkedGames.loadError")); })
      .finally(() => { if (current() && revision.current === own) setBusy(false); });
    return () => { alive.current = false; };
    // The mounted panel's account and authentication generation own all requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner, generation]);

  async function refresh() {
    if (pending.current || !current()) return;
    pending.current = true; setBusy(true); setError("");
    try { await load(); }
    catch { if (current()) setError(t("linkedGames.loadError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  async function change(grant: GameApplicationGrant | undefined, enabled: boolean, revoke = false) {
    if (pending.current || !current()) return;
    const id = grant?.application_id ?? applicationID.trim();
    if (!id) return;
    if (revoke || !grant || grant.revoked_at) {
      const approved = await useConfirmStore.getState().open({
        title: t(revoke ? "linkedGames.revoke" : "linkedGames.authorize"),
        message: t(revoke ? "linkedGames.revokeConfirm" : "linkedGames.authorizeConfirm", { name: grant?.application_name || id }),
        confirmLabel: t(revoke ? "linkedGames.revoke" : "linkedGames.authorize"), cancelLabel: t("sessions.cancel"), danger: revoke,
      });
      if (!approved || pending.current || !current()) return;
    }
    pending.current = true; setBusy(true); setError("");
    try {
      const result = revoke
        ? await revokeGameApplicationGrant(id, grant!.revision, current)
        : await updateGameApplicationGrant(id, grant?.revision ?? 0, enabled, current);
      if (!current()) return;
      if (!result.success || !result.data || result.data.application_id !== id || !Number.isSafeInteger(result.data.revision) || result.data.revision <= (grant?.revision ?? 0)
        || (revoke ? !result.data.revoked_at || result.data.messaging_enabled : !!result.data.revoked_at || result.data.messaging_enabled !== enabled)) {
        setError(t(result.code === "CONFLICT" ? "linkedGames.conflict" : "linkedGames.saveError"));
        // Refresh to make an explicit retry use the current server revision.
        await load();
        return;
      }
      const saved = result.data;
      setGrants(items => [...items.filter(item => item.application_id !== id), saved]);
      if (!grant) setApplicationID("");
    } catch { if (current()) setError(t("linkedGames.saveError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }

  return <section aria-labelledby="settings-linked-games" aria-busy={busy}>
    <h3 id="settings-linked-games" className="settings-section-subtitle" data-settings-section="linked-games">{t("linkedGames.title")}</h3>
    <p className="settings-hint">{t("linkedGames.description")}</p>
    {error && <p role="alert">{error}</p>}
    {!busy && grants.length === 0 && !error && <p>{t("linkedGames.empty")}</p>}
    <ul style={{ listStyle: "none", padding: 0 }}>{grants.map(grant => <li key={grant.application_id} style={{ borderBottom: "1px solid var(--border-color)", padding: "16px 0", overflowWrap: "anywhere" }}>
      <strong>{grant.application_name || grant.application_username}</strong>
      <p className="settings-hint">@{grant.application_username} · {grant.application_id}</p>
      {grant.revoked_at ? <><p>{t("linkedGames.revoked")}</p><button type="button" className="settings-btn" disabled={busy} onClick={() => void change(grant, true)}>{t("linkedGames.authorize")}</button></> : <>
        <label className="settings-toggle-row"><span>{t("linkedGames.allowMessages", { name: grant.application_name })}</span><input type="checkbox" role="switch" checked={grant.messaging_enabled} disabled={busy} onChange={event => void change(grant, event.target.checked)} /></label>
        <button type="button" className="settings-btn settings-btn-danger" disabled={busy} onClick={() => void change(grant, false, true)}>{t("linkedGames.revoke")}</button>
      </>}
    </li>)}</ul>
    <label className="settings-field"><span>{t("linkedGames.applicationID")}</span><input className="settings-input" autoComplete="off" maxLength={128} value={applicationID} disabled={busy} onChange={event => setApplicationID(event.target.value)} /></label>
    <button type="button" className="settings-btn" disabled={busy || !applicationID.trim()} onClick={() => void change(undefined, true)}>{t("linkedGames.authorize")}</button>{" "}
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void refresh()}>{t("applications.refresh")}</button>
  </section>;
}
