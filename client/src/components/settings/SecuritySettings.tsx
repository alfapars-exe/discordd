/** SecuritySettings — Email change/remove (with password verification) and password change. */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useToastStore } from "../../stores/toastStore";
import { useAuthStore } from "../../stores/authStore";
import * as authApi from "../../api/auth";
import { useSettingsDraft } from "./settingsWorkspaceContext";
import { newPasswordError } from "../../utils/passwordPolicy";
import type { User } from "../../types";
import DeviceHandoffSettings from "./DeviceHandoffSettings";
import MFASettings from "./MFASettings";
import SessionSettings from "./SessionSettings";
import AccountStatusSettings from "./AccountStatusSettings";
import AccountLifecycleSettings from "./AccountLifecycleSettings";
import AccountDeletionSettings from "./AccountDeletionSettings";
import EmailVerificationSettings from "./EmailVerificationSettings";
import PrivacyConsentSettings from "./PrivacyConsentSettings";
import LinkedGameSettings from "./LinkedGameSettings";
import DataExportSettings from "./DataExportSettings";

function SecuritySettings() {
  const user = useAuthStore((s) => s.user);
  // Private credential drafts must not survive an account switch.
  return user ? <SecurityForm key={user.id} user={user} /> : null;
}

function SecurityForm({ user }: { user: User }) {
  const { t } = useTranslation("settings");
  const addToast = useToastStore((s) => s.addToast);
  const updateUser = useAuthStore((s) => s.updateUser);
  const alive = useRef(true);
  const requestPending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const isCurrent = () => alive.current && useAuthStore.getState().user?.id === user.id;

  // ─── Email State ───
  const [newEmail, setNewEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [isEmailSaving, setIsEmailSaving] = useState(false);

  // ─── Password State ───
  // Current password IS required — the server (POST /api/users/me/password)
  // 400s without it. It defends against a stolen JWT (XSS exfil, unattended
  // session) the same way the email-change flow already does above.
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  useSettingsDraft(!!(newEmail || emailPassword || currentPassword || newPassword || confirmPassword) || isSaving || isEmailSaving);

  // ─── Email Handlers ───
  const canSubmitEmail = emailPassword.length > 0 && !isEmailSaving && !isSaving;

  async function handleEmailSubmit(targetEmail: string) {
    if (!canSubmitEmail || requestPending.current) return;

    // Client-side: empty = remove, otherwise validate format
    const trimmedEmail = targetEmail.trim();
    if (trimmedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      addToast("error", t("emailInvalid"));
      return;
    }

    requestPending.current = true;
    setIsEmailSaving(true);
    try {
      const res = await authApi.changeEmail(emailPassword, trimmedEmail, user.id);
      if (!isCurrent()) return;
      if (res.success) {
        const resultEmail = res.data?.email ?? null;
        updateUser({ email: resultEmail });
        addToast("success", trimmedEmail ? t("emailChanged") : t("emailRemoved"));
        setNewEmail("");
        setEmailPassword("");
      } else {
        const errMsg = res.error ?? "";
        if (res.code === "ACCOUNT_MISMATCH") {
          addToast("error", t("securityAccountChanged"));
        } else if (errMsg.includes("incorrect") || errMsg.includes("unauthorized")) {
          addToast("error", t("wrongCurrentPassword"));
        } else if (errMsg.includes("already in use") || errMsg.includes("already exists")) {
          addToast("error", t("emailAlreadyExists"));
        } else if (errMsg.includes("invalid email")) {
          addToast("error", t("emailInvalid"));
        } else if (errMsg.includes("same as current")) {
          addToast("error", t("emailSameAsCurrent"));
        } else {
          addToast("error", t("emailChangeError"));
        }
      }
    } catch {
      if (isCurrent()) addToast("error", t("emailChangeError"));
    } finally {
      requestPending.current = false;
      if (isCurrent()) setIsEmailSaving(false);
    }
  }

  // ─── Password Handlers ───
  const canSubmitPassword =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    confirmPassword.length > 0 &&
    !isSaving && !isEmailSaving;

  async function handlePasswordSubmit() {
    if (!canSubmitPassword || requestPending.current) return;

    const policyError = newPasswordError(newPassword);
    if (policyError) {
      addToast("error", t(policyError));
      return;
    }

    if (newPassword !== confirmPassword) {
      addToast("error", t("passwordMismatch"));
      return;
    }

    requestPending.current = true;
    setIsSaving(true);
    try {
      const res = await authApi.changePassword(currentPassword, newPassword, user.id);
      if (!isCurrent()) return;
      if (res.success) {
        addToast("success", t("passwordChanged"));
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        // The server revokes every session, including this one. Clear only
        // this account's local session; never revoke a shared cookie again.
        void useAuthStore.getState().logout({ localOnly: true, expectedUserId: user.id });
      } else {
        const errMsg = res.error ?? "";
        if (res.code === "ACCOUNT_MISMATCH") {
          addToast("error", t("securityAccountChanged"));
        } else if (errMsg.includes("incorrect") || errMsg.includes("unauthorized")) {
          addToast("error", t("wrongCurrentPassword"));
        } else if (errMsg.includes("at least 8")) {
          addToast("error", t("passwordTooShort"));
        } else if (errMsg.includes("at most 72")) {
          addToast("error", t("passwordTooLong"));
        } else {
          addToast("error", t("passwordChangeError"));
        }
      }
    } catch {
      if (isCurrent()) addToast("error", t("passwordChangeError"));
    } finally {
      requestPending.current = false;
      if (isCurrent()) setIsSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">{t("security")}</h2>

      {/* ═══ Email Section ═══ */}
      <h3 className="settings-section-subtitle" data-settings-section="email">{t("emailSection")}</h3>

      {/* Current email display */}
      <div className="settings-field">
        <label className="settings-label">{t("currentEmail")}</label>
        <p className="settings-value">
          {user?.email ?? t("noEmail")}
        </p>
      </div>

      {/* New email */}
      <div className="settings-field">
        <label htmlFor="newEmail" className="settings-label">
          {t("newEmail")}
        </label>
        <input
          id="newEmail"
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder={t("emailPlaceholder")}
          className="settings-input"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      {/* Password verification */}
      <div className="settings-field">
        <label htmlFor="emailPassword" className="settings-label">
          {t("currentPassword")}
        </label>
        <input
          id="emailPassword"
          type="password"
          value={emailPassword}
          onChange={(e) => setEmailPassword(e.target.value)}
          placeholder={t("emailPasswordPlaceholder")}
          className="settings-input"
          autoComplete="off"
          data-1p-ignore
          data-lpignore="true"
        />
        <p className="settings-hint">{t("emailPasswordRequired")}</p>
      </div>

      {/* Email actions */}
      <div className="settings-btn-row">
        <button
          onClick={() => { void handleEmailSubmit(newEmail); }}
          disabled={!canSubmitEmail || !newEmail.trim()}
          className="settings-btn"
        >
          {isEmailSaving ? t("changeEmail") + "..." : t("changeEmail")}
        </button>
      </div>

      {/* ═══ Separator ═══ */}
      <div className="settings-divider" />

      {/* ═══ Password Section ═══ */}
      <h3 className="settings-section-subtitle" data-settings-section="password">{t("changePassword")}</h3>

      {/* Current Password — required by the server to defend against a
          stolen JWT (see the comment on the state above). */}
      <div className="settings-field">
        <label htmlFor="currentPasswordForChange" className="settings-label">
          {t("currentPassword")}
        </label>
        <input
          id="currentPasswordForChange"
          type="password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          placeholder={t("currentPasswordPlaceholder")}
          className="settings-input"
          autoComplete="current-password"
          data-1p-ignore
          data-lpignore="true"
        />
      </div>

      {/* New Password */}
      <div className="settings-field">
        <label htmlFor="newPassword" className="settings-label">
          {t("newPassword")}
        </label>
        <input
          id="newPassword"
          type="password"
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          placeholder={t("newPasswordPlaceholder")}
          className="settings-input"
          autoComplete="new-password"
        />
      </div>

      {/* Confirm New Password */}
      <div className="settings-field">
        <label htmlFor="confirmNewPassword" className="settings-label">
          {t("confirmNewPassword")}
        </label>
        <input
          id="confirmNewPassword"
          type="password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder={t("confirmNewPasswordPlaceholder")}
          className="settings-input"
          autoComplete="new-password"
        />
      </div>

      {/* Submit */}
      <div style={{ marginTop: 16 }}>
        <button
          onClick={handlePasswordSubmit}
          disabled={!canSubmitPassword}
          className="settings-btn"
        >
          {isSaving ? t("changePassword") + "..." : t("changePassword")}
        </button>
      </div>
      <EmailVerificationSettings key={`${user.id}:${user.email ?? ""}`} userID={user.id} />
      <MFASettings key={`mfa:${user.id}`} userID={user.id} />
      <SessionSettings key={`sessions:${user.id}`} userID={user.id} />
      <AccountStatusSettings key={`status:${user.id}`} userID={user.id} />
      <AccountLifecycleSettings key={`lifecycle:${user.id}`} userID={user.id} />
      <PrivacyConsentSettings />
      <div className="settings-divider" />
      <LinkedGameSettings />
      <DataExportSettings key={`export:${user.id}`} userID={user.id} />
      <DeviceHandoffSettings key={`handoff:${user.id}`} ownerId={user.id} />
      <AccountDeletionSettings key={`delete:${user.id}`} userID={user.id} />
    </div>
  );
}

export default SecuritySettings;
