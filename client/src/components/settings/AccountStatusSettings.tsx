import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import { getAccountStatus, type AccountStatus } from "../../api/accountStatus";
import { useAuthStore } from "../../stores/authStore";
import { formatDateTime } from "../../utils/dateFormat";

export default function AccountStatusSettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(false);
  const [generation] = useState(getAuthGeneration);
  const alive = useRef(true), revision = useRef(0);
  const current = () => alive.current && getAuthGeneration() === generation && useAuthStore.getState().user?.id === userID;
  async function load(offset = 0) {
    const own = ++revision.current;
    setBusy(true); setError(false);
    await fetchStatus(offset, own);
  }
  async function fetchStatus(offset: number, own: number) {
    try {
      const response = await getAccountStatus(userID, offset, current);
      if (!current() || own !== revision.current) return;
      if (!response.success || !response.data) { setError(true); return; }
      const next = response.data;
      setStatus(previous => ({ ...next, restrictions: offset && previous
        ? [...previous.restrictions.filter(old => !next.restrictions.some(item => item.kind === old.kind && item.server_id === old.server_id)), ...next.restrictions]
        : next.restrictions }));
    } catch { if (current() && own === revision.current) setError(true); }
    finally { if (current() && own === revision.current) setBusy(false); }
  }
  useEffect(() => {
    alive.current = true; void fetchStatus(0, ++revision.current);
    return () => { alive.current = false; };
    // The keyed user and auth generation own the complete request lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userID, generation]);
  const date = (value: number) => formatDateTime(value * 1000);
  return <section aria-labelledby="settings-security-account-status" aria-busy={busy}>
    <div className="settings-divider" />
    <h3 id="settings-security-account-status" className="settings-section-subtitle" data-settings-section="account-status">{t("accountStatus.title")}</h3>
    <p className="settings-hint">{t("accountStatus.description")}</p>
    {busy && <p role="status">{t("loading")}</p>}
    {error && <p role="alert" className="auth-error">{t("accountStatus.loadError")}</p>}
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void load()}>{t("accountStatus.refresh")}</button>
    {status && <>
      <p>{t(status.platform_banned ? "accountStatus.platformBanned" : "accountStatus.platformAllowed")}</p>
      {status.platform_reason && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{status.platform_reason}</p>}
      <p className="settings-hint">{t("accountStatus.checked")}: {date(status.checked_at)}</p>
      <h4>{t("accountStatus.restrictions")}</h4>
      {!status.restrictions.length && <p>{t("accountStatus.none")}</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {status.restrictions.map(item => <li key={`${item.kind}:${item.server_id}`} style={{ padding: "16px 0", borderBottom: "1px solid var(--border-color, #555)", overflowWrap: "anywhere" }}>
          <h4>{item.server_name} · {t(item.kind === "ban" ? "accountStatus.ban" : "accountStatus.timeout")}</h4>
          <p style={{ whiteSpace: "pre-wrap" }}>{item.reason || t("accountStatus.noReason")}</p>
          <p className="settings-hint">{t("accountStatus.applied")}: {date(item.created_at)}</p>
          <p className="settings-hint">{t("accountStatus.until")}: {item.expires_at === null ? t("accountStatus.permanent") : date(item.expires_at)}</p>
        </li>)}
      </ul>
      {status.next_offset !== null && <button type="button" className="settings-btn" disabled={busy} onClick={() => void load(status.next_offset!)}>{t("accountStatus.more")}</button>}
    </>}
  </section>;
}
