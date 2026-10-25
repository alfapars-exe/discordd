import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { verifyEmail } from "../../api/emailVerification";

export default function VerifyEmailPage() {
  const location = useLocation(), navigate = useNavigate(), { t } = useTranslation("auth");
  const [token, setToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get("token") ?? "");
  const [busy, setBusy] = useState(false), [success, setSuccess] = useState(false), [error, setError] = useState("");
  const alive = useRef(true), pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    // Fragments never reach the HTTP server/referrer; also remove this proof
    // from the visible/history URL while keeping it only in component memory.
    if (location.hash) void navigate({ pathname: location.pathname, search: location.search, hash: "" }, { replace: true });
    return () => { alive.current = false; };
    // The initial proof belongs to this mounted confirmation page only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function confirm() {
    if (pending.current || !/^[a-f0-9]{64}$/i.test(token)) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const response = await verifyEmail(token);
      if (!alive.current) return;
      if (response.success && response.data?.verified) { setSuccess(true); setToken(""); }
      else setError(t(response.code === "EMAIL_VERIFICATION_INVALID" ? "verificationInvalid" : response.code === "EMAIL_VERIFICATION_RATE_LIMITED" ? "verificationRateLimited" : "verificationError"));
    } catch { if (alive.current) setError(t("verificationError")); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return <main className="auth-page"><div className="auth-card">
    <h1 className="auth-title">{t("verificationTitle")}</h1>
    {success ? <p role="status">{t("verificationSuccess")}</p> : <>
      <p className="auth-subtitle">{t("verificationDescription")}</p>
      {error && <p role="alert" className="auth-error">{error}</p>}
      {!/^[a-f0-9]{64}$/i.test(token) ? <p role="alert" className="auth-error">{t("verificationInvalid")}</p>
        : <button type="button" className="auth-btn" disabled={busy} onClick={() => void confirm()}>{t(busy ? "verificationWorking" : "verificationConfirm")}</button>}
    </>}
    <p className="auth-link"><Link to="/login">{t("goToLogin")}</Link></p>
  </div></main>;
}
