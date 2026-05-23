/**
 * authErrors — translates raw backend auth error strings into i18n keys.
 *
 * Backend (server/services/auth_service.go) returns errors as wrapped
 * sentinel-prefixed messages like:
 *   "unauthorized: invalid username or password"
 *   "bad request: password must be at least 6 characters"
 *
 * Those strings ship straight to apiClient.error and on into the auth
 * stores. Showing them verbatim in the UI leaks an English-only,
 * developer-facing string into Turkish locales (see Login/Register/
 * ForgotPassword/ResetPassword pages). This helper does a regex pass
 * over the message and maps known patterns to existing i18n keys in
 * the `auth` namespace.
 *
 * Unmatched errors are returned as-is — so a brand-new backend error
 * won't disappear into silence; it just stays untranslated until we
 * add a pattern + key for it.
 */

import type { TFunction } from "i18next";

/**
 * Ordered list of (regex, i18n key) pairs. Order matters when a backend
 * message could match multiple patterns (most-specific first). Add new
 * entries here when the backend grows a new error string — no need to
 * touch the callers.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Login
  [/invalid username or password/i, "invalidCredentials"],
  [/invalid refresh token|refresh token expired/i, "sessionExpired"],

  // Register
  [/username.*already.*(taken|exists|in use)/i, "usernameTaken"],
  [/email.*already.*(taken|exists|in use|registered)/i, "emailTaken"],
  [/invalid email format/i, "invalidEmail"],

  // Password reset / change
  [/password must be at least \d+ characters/i, "passwordTooShort"],
  [/password is incorrect/i, "currentPasswordIncorrect"],
  [/invalid or expired (reset )?token|reset token has expired/i, "invalidOrExpiredToken"],
  [/password reset is not configured/i, "passwordResetNotConfigured"],

  // Generic transport
  [/network request failed|failed to fetch/i, "networkError"],
];

/**
 * Translate a raw backend error string into a user-facing localized message.
 * Returns null for null input (so callers can chain `localizeAuthError(error, t)`
 * directly into `{... && <div>...</div>}`).
 */
export function localizeAuthError(
  error: string | null | undefined,
  t: TFunction,
): string | null {
  if (!error) return null;
  for (const [pattern, key] of PATTERNS) {
    if (pattern.test(error)) {
      return t(key, { ns: "auth" });
    }
  }
  return error;
}
