import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getAuthGeneration } from "../../api/client";
import { getEmailVerification, requestEmailVerification, type EmailVerificationStatus } from "../../api/emailVerification";
import { useAuthStore } from "../../stores/authStore";

export default function EmailVerificationSettings({ userID }: { userID: string }) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<EmailVerificationStatus | null>(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [remaining, setRemaining] = useState(0), [generation] = useState(getAuthGeneration);
  const alive = useRef(true), revision = useRef(0), pending = useRef(false);
  const current = () => alive.current && getAuthGeneration() === generation && useAuthStore.getState().user?.id === userID;
  async function fetchStatus(own: number) {
    const response = await getEmailVerification(userID, current);
    if (!current() || own !== revision.current) return;
    if (response.success && response.data) { setStatus(response.data); setRemaining(response.data.retry_after); }
    else setError(t("verification.loadError"));
  }
  useEffect(() => {
    alive.current = true; const own = ++revision.current;
    void fetchStatus(own).catch(() => { if (current() && own === revision.current) setError(t("verification.loadError")); })
      .finally(() => { if (current() && own === revision.current) setBusy(false); });
    return () => { alive.current = false; };
    // The keyed owner/email and auth generation define this request lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userID, generation]);
  useEffect(() => {
    if (remaining <= 0) return;
    const interval = window.setInterval(() => setRemaining(value => Math.max(0, value - 1)), 1000);
    return () => window.clearInterval(interval);
  }, [remaining]);
  async function refresh() {
    if (pending.current || busy) return;
    pending.current = true; setBusy(true); setError("");
    try { await fetchStatus(++revision.current); }
    catch { if (current()) setError(t("verification.loadError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  async function request() {
    if (pending.current || busy || !status?.email || status.verified || !status.delivery_available || remaining > 0) return;
    pending.current = true; setBusy(true); setError(""); setMessage("");
    const own = ++revision.current;
    try {
      const response = await requestEmailVerification(userID, status.generation, current);
      if (!current()) return;
      if (response.success && response.data?.accepted) setMessage(t("verification.accepted"));
      else setError(t(response.code === "EMAIL_DELIVERY_UNAVAILABLE" ? "verification.unavailable" : response.code === "EMAIL_STATE_CHANGED" ? "verification.changed" : response.code === "EMAIL_VERIFICATION_COOLDOWN" ? "verification.cooldown" : "verification.sendError"));
      await fetchStatus(own);
    } catch { if (current()) setError(t("verification.sendError")); }
    finally { pending.current = false; if (current()) setBusy(false); }
  }
  return <section aria-labelledby="settings-security-email-verification" aria-busy={busy}>
    <h3 id="settings-security-email-verification" data-settings-section="email-verification" className="settings-section-subtitle">{t("verification.title")}</h3>
    <p className="settings-hint">{t("verification.description")}</p>
    {error && <p role="alert" className="auth-error">{error}</p>}
    {message && <p role="status">{message}</p>}
    {busy && <p role="status">{t("loading")}</p>}
    {status && <>
      <p style={{ overflowWrap: "anywhere" }}>{status.email ?? t("verification.noEmail")}</p>
      {status.email && <p>{t(status.verified ? "verification.verified" : "verification.unverified")}</p>}
      {!status.delivery_available && <p className="settings-hint">{t("verification.unavailable")}</p>}
      {remaining > 0 && <p role="status">{t("verification.retryAfter", { count: remaining })}</p>}
      <button type="button" className="settings-btn" disabled={busy || !status.email || status.verified || !status.delivery_available || remaining > 0} onClick={() => void request()}>{t("verification.send")}</button>
    </>}
    <button type="button" className="settings-btn" disabled={busy} onClick={() => void refresh()}>{t("verification.refresh")}</button>
  </section>;
}
