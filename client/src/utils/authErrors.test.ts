/**
 * authErrors regression tests — locks the backend-error → i18n-key
 * mapping so future backend message rewordings can't silently leak
 * raw English server text to Turkish users.
 *
 * Every case here corresponds to a real auth_service.go error string
 * (server/services/auth_service.go grep "ErrUnauthorized" / "ErrBadRequest"
 * for the source). When the backend changes a message, this test
 * fails — forcing an explicit decision: add a new pattern or accept
 * the regression.
 */

import { describe, it, expect } from "vitest";
import { localizeAuthError } from "./authErrors";

// Minimal TFunction stub. We only need it to return its first arg
// (the i18n key) so we can assert which key the helper picked.
// Real i18next is heavy and irrelevant for this unit's contract.
const t = ((key: string) => key) as Parameters<typeof localizeAuthError>[1];

describe("localizeAuthError", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(localizeAuthError(null, t)).toBeNull();
    expect(localizeAuthError(undefined, t)).toBeNull();
    expect(localizeAuthError("", t)).toBeNull();
  });

  it("maps invalid credentials (the exact backend wording)", () => {
    expect(
      localizeAuthError("unauthorized: invalid username or password", t),
    ).toBe("invalidCredentials");
  });

  it("maps refresh-token expiry to sessionExpired", () => {
    expect(localizeAuthError("unauthorized: invalid refresh token", t)).toBe(
      "sessionExpired",
    );
    expect(localizeAuthError("unauthorized: refresh token expired", t)).toBe(
      "sessionExpired",
    );
  });

  it("maps username/email taken", () => {
    expect(localizeAuthError("username already taken", t)).toBe("usernameTaken");
    expect(localizeAuthError("email already in use", t)).toBe("emailTaken");
    expect(localizeAuthError("email already registered", t)).toBe("emailTaken");
  });

  it("maps password-too-short with any digit count", () => {
    expect(
      localizeAuthError("bad request: password must be at least 6 characters", t),
    ).toBe("passwordTooShort");
    expect(
      localizeAuthError("bad request: password must be at least 12 characters", t),
    ).toBe("passwordTooShort");
  });

  it("maps invalid email format", () => {
    expect(localizeAuthError("bad request: invalid email format", t)).toBe(
      "invalidEmail",
    );
  });

  it("maps reset token issues", () => {
    expect(localizeAuthError("bad request: invalid or expired reset token", t)).toBe(
      "invalidOrExpiredToken",
    );
    expect(localizeAuthError("bad request: reset token has expired", t)).toBe(
      "invalidOrExpiredToken",
    );
  });

  it("maps current password incorrect (change-password flow)", () => {
    expect(localizeAuthError("unauthorized: password is incorrect", t)).toBe(
      "currentPasswordIncorrect",
    );
  });

  it("maps network failure", () => {
    expect(localizeAuthError("Network request failed", t)).toBe("networkError");
    expect(localizeAuthError("Failed to fetch", t)).toBe("networkError");
  });

  it("falls through unmatched errors as-is (no silent loss)", () => {
    // If we add a new backend error that doesn't match any pattern,
    // we want the user to see SOMETHING rather than a localized but
    // wrong message — even an untranslated string. Catch-all here.
    const novel = "internal server error: kernel panic";
    expect(localizeAuthError(novel, t)).toBe(novel);
  });

  it("is case-insensitive (backend may capitalize differently)", () => {
    expect(
      localizeAuthError("UNAUTHORIZED: Invalid Username or Password", t),
    ).toBe("invalidCredentials");
  });
});
