/**
 * ForgotPasswordPage — Request password reset email.
 * i18n: "auth" namespace.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import * as authApi from "../../api/auth";
import { localizeAuthError } from "../../utils/authErrors";

function ForgotPasswordPage() {
  // ─── Hooks ───
  const { t } = useTranslation("auth");

  const [identifier, setIdentifier] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isSent, setIsSent] = useState(false);

  // ─── Handlers ───
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    const res = await authApi.forgotPassword(identifier);
    setIsLoading(false);

    if (res.error) {
      setError(res.error);
      return;
    }

    setIsSent(true);
  }

  // ─── Render: Success ───
  if (isSent) {
    return (
      <main className="auth-page">
        <div className="auth-card">
          <h1 className="auth-title">{t("resetLinkSent")}</h1>
          <p className="auth-subtitle">{t("resetLinkSentSubtitle")}</p>
          <p className="auth-link">
            <Link to="/login">{t("backToLogin")}</Link>
          </p>
        </div>
      </main>
    );
  }

  // ─── Render: Form ───
  return (
    <main className="auth-page">
      <div className="auth-card">
        <h1 className="auth-title">{t("forgotPasswordTitle")}</h1>
        <p className="auth-subtitle">{t("forgotPasswordSubtitle")}</p>

        {error && <div className="auth-error" role="alert">{localizeAuthError(error, t)}</div>}

        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="identifier" className="auth-label">
              {t("usernameOrEmail")}
            </label>
            <input
              id="identifier"
              type="text"
              value={identifier}
              onChange={(e) => {
                setIdentifier(e.target.value);
                if (error) setError("");
              }}
              placeholder={t("usernameOrEmailPlaceholder")}
              readOnly={isLoading}
              required
              autoFocus
              className="auth-input"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="auth-btn"
          >
            {isLoading ? t("sending") : t("sendResetLink")}
          </button>
        </form>

        <p className="auth-link">
          <Link to="/login">{t("backToLogin")}</Link>
        </p>
      </div>
    </main>
  );
}

export default ForgotPasswordPage;
