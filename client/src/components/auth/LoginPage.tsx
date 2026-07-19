/** LoginPage — User login page. i18n: "auth" namespace. */

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuthStore } from "../../stores/authStore";
import { isElectron, isNativeApp } from "../../utils/constants";
import { detectOS, shouldShowDownloadPrompt } from "../../utils/detectOS";
import { localizeAuthError } from "../../utils/authErrors";
import { useServerWakeUp } from "../../hooks/useServerWakeUp";

function LoginPage() {
  // ─── Hooks ───
  const { t } = useTranslation("auth");
  const login = useAuthStore((s) => s.login);
  const isLoading = useAuthStore((s) => s.isLoading);
  const error = useAuthStore((s) => s.error);
  const clearError = useAuthStore((s) => s.clearError);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Submit anındaki credentials'ı retry için sakla — kullanıcı bekleme
  // sırasında input'a dokunsa bile retry orijinal değerlerle yapılır.
  const lastSubmitRef = useRef<{ username: string; password: string } | null>(null);

  // HF Space cold-start desteği — 503 alındığında otomatik "uyanıyor" UX'i.
  // Probe başarılı olunca son submit'i tekrar denemek için onReady kullanıyoruz.
  const wakeUp = useServerWakeUp({
    error,
    onReady: () => {
      const saved = lastSubmitRef.current;
      if (saved) {
        clearError();
        void attemptLogin(saved.username, saved.password);
      }
    },
  });

  // Load saved credentials from Electron safeStorage on mount
  useEffect(() => {
    if (!isElectron()) return;
    window.electronAPI?.loadCredentials().then((cred) => {
      if (cred) {
        setUsername(cred.username);
        setPassword(cred.password);
        setRememberMe(true);
      }
    });
  }, []);

  // ─── Handlers ───
  async function attemptLogin(u: string, p: string) {
    const success = await login(u, p);
    if (success) {
      wakeUp.reset();
      // Electron: save or clear credentials
      if (isElectron()) {
        if (rememberMe) {
          window.electronAPI?.saveCredentials(u, p);
        } else {
          window.electronAPI?.clearCredentials();
        }
      }
      // Redirect to returnUrl (e.g. invite link) or /channels
      const returnUrl = searchParams.get("returnUrl");
      navigate(returnUrl ?? "/channels");
    } else {
      // Retry başarısızsa (örn. wake-up sonrası server yine 503 döndü) wake-up
      // state'ini sıfırla — bir sonraki render watchError'u idle'dan tetikler
      // ve döngü yeniden başlar. Aksi halde "ready" state'inde takılırdık.
      if (wakeUp.state.phase === "ready") wakeUp.reset();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    // "failed" banner'ından çıkıp yeniden denerken loop'u sıfırla.
    if (wakeUp.state.phase === "failed") wakeUp.reset();
    lastSubmitRef.current = { username, password };
    await attemptLogin(username, password);
  }

  function handleInputChange() {
    if (error) clearError();
    // Kullanıcı tekrar etkileşim ediyorsa wake-up döngüsü sıfırlansın —
    // "failed" durumundaki banner'dan çıkıp normal akışa dönsün.
    if (wakeUp.state.phase !== "idle") wakeUp.reset();
  }

  // ─── Render ───
  return (
    <main className="auth-page">
      <div className="auth-card">
        {/* Header */}
        <h1 className="auth-title">{t("welcomeBack")}</h1>
        <p className="auth-subtitle">{t("excitedToSeeYou")}</p>

        {/* Error / Wake-up Banner — üç mod:
            1) Wake-up devam ediyor → "Sunucu uyanıyor (X/Y)..." (info ton)
            2) Wake-up başarısız    → "Sunucu yanıt vermiyor..." (error ton)
            3) Normal hata          → localize edilmiş auth error
            Sentinel match olunca raw error banner gösterilmez — wake-up UI
            zaten kullanıcıya neler olduğunu anlatıyor. */}
        {wakeUp.state.phase === "waking" && (
          <div className="auth-error" role="status">
            {t("serverWakingUpAttempt", {
              attempt: wakeUp.state.attempt,
              max: wakeUp.state.max,
            })}
          </div>
        )}
        {wakeUp.state.phase === "failed" && (
          <div className="auth-error">{t("serverWakeFailed")}</div>
        )}
        {wakeUp.state.phase !== "waking" &&
          wakeUp.state.phase !== "failed" &&
          error && <div className="auth-error">{localizeAuthError(error, t)}</div>}

        {/* Form */}
        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="username" className="auth-label">
              {t("username")}
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
                handleInputChange();
              }}
              required
              autoFocus
              className="auth-input"
            />
          </div>

          <div className="auth-field">
            <label htmlFor="password" className="auth-label">
              {t("password")}
            </label>
            <div className="auth-field-password">
              <input
                id="password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  handleInputChange();
                }}
                required
                className="auth-input"
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setShowPassword(!showPassword)}
                aria-label={t(showPassword ? "hidePassword" : "showPassword")}
              >
                {showPassword ? (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                  </svg>
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Electron: Remember me checkbox */}
          {isElectron() && (
            <label className="auth-remember">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
              />
              <span>{t("rememberMe")}</span>
            </label>
          )}

          <button
            type="submit"
            disabled={isLoading || wakeUp.state.phase === "waking"}
            className="auth-btn"
          >
            {isLoading || wakeUp.state.phase === "waking"
              ? t("loggingIn")
              : t("login")}
          </button>
        </form>

        {/* Forgot Password Link */}
        <p className="auth-link" style={{ marginTop: "12px" }}>
          <Link to="/forgot-password">{t("forgotPassword")}</Link>
        </p>

        {/* Footer Link */}
        <p className="auth-link">
          {t("needAccount")}{" "}
          <Link to={searchParams.get("returnUrl") ? `/register?returnUrl=${searchParams.get("returnUrl")}` : "/register"}>{t("registerLink")}</Link>
        </p>

        {/* Desktop download hint — only on web browsers with desktop OS */}
        {shouldShowDownloadPrompt() && (() => {
          const { url, i18nKey } = detectOS();
          return (
            <a href={url} className="auth-download-link" target="_blank" rel="noopener noreferrer">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t(i18nKey)}
            </a>
          );
        })()}

        {!isNativeApp() && (
          <Link to="/" className="auth-home-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {t("backToHome")}
          </Link>
        )}
      </div>
    </main>
  );
}

export default LoginPage;
