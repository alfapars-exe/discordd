package services

// Credential-management methods for authService: change password / change
// email, and the forgot/reset-password flow. Split out of auth_service.go
// (which keeps the session + token lifecycle). These remain methods on the
// same *authService type in the same package, so the AuthService interface,
// constructor, and wiring are unchanged. The password-reset constants
// (resetCooldown, resetTokenExpiry) stay in auth_service.go and remain
// package-visible to ForgotPassword below.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"golang.org/x/crypto/bcrypt"
)

// ChangePassword updates the user's password after verifying the current one.
//
// Verifying currentPassword (not just the JWT) protects against:
//   - Stolen access tokens — attacker with the JWT alone can't lock the user out
//   - Brief unattended-session takeover (shared device, kiosk, screen-share)
//   - XSS-exfiltrated tokens — the attacker still needs the password
//
// Re-asking for the password on top of an authenticated session is the
// industry standard (Discord, Slack, GitHub, Google all do this). The minor
// UX friction is worth the defense-in-depth.
func (s *authService) ChangePassword(ctx context.Context, userID, currentPassword, newPassword string) error {
	// Share the durable per-account security budget with MFA and session
	// revocation. An attacker holding a session token must not get unlimited
	// password guesses by switching between sensitive endpoints or instances.
	if s.mfa != nil {
		if err := s.mfa.attempt(ctx, userID); err != nil {
			return err
		}
	}
	if err := models.ValidateNewPassword(newPassword); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err)
	}
	if currentPassword == "" {
		return fmt.Errorf("%w: current password is required", pkg.ErrBadRequest)
	}

	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(currentPassword)); err != nil {
		s.logWarn(&userID, "password change attempted with wrong current password", nil)
		return fmt.Errorf("%w: current password is incorrect", pkg.ErrUnauthorized)
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	if s.authSessions != nil {
		if err := s.authSessions.UpdatePasswordAndRevoke(ctx, userID, user.PasswordHash, "", string(newHash), time.Now().Unix()); err != nil {
			return err
		}
		s.afterBoundSessionRevocation(userID)
		return nil
	}
	if err := s.userRepo.UpdatePassword(ctx, userID, string(newHash)); err != nil {
		return err
	}

	// Legacy constructors only (production returned through the atomic path).
	// Revoke every session and outstanding access token for this user (see
	// revokeAllSessions in auth_service.go). A password change is the
	// strongest signal the user wants to lock out all current sessions —
	// anything still using the old credentials (including the attacker
	// who triggered the change) gets booted, and any live WebSocket is
	// disconnected too. Best-effort by construction: if a sub-step fails,
	// the password is still changed (caller's primary intent) — failures
	// are logged inside revokeAllSessions, not surfaced here.
	//
	// Policy: password changes also end the caller's own session. Session-aware
	// production can identify it, but deliberately requires a fresh login.
	s.revokeAllSessions(ctx, userID)

	return nil
}

func (s *authService) ChangeEmail(ctx context.Context, userID, password, newEmail string) error {
	if s.mfa != nil {
		if err := s.mfa.attempt(ctx, userID); err != nil {
			return err
		}
	}
	user, err := s.userRepo.GetByID(ctx, userID)
	if err != nil {
		return err
	}

	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return fmt.Errorf("%w: password is incorrect", pkg.ErrUnauthorized)
	}

	if strings.TrimSpace(newEmail) == "" {
		return fmt.Errorf("%w: email cannot be removed", pkg.ErrBadRequest)
	}

	newEmail = strings.TrimSpace(newEmail)
	if !models.EmailRegex().MatchString(newEmail) {
		return fmt.Errorf("%w: invalid email format", pkg.ErrBadRequest)
	}

	if user.Email != nil && *user.Email == newEmail {
		return fmt.Errorf("%w: new email is the same as current email", pkg.ErrBadRequest)
	}

	return s.userRepo.UpdateEmail(ctx, userID, &newEmail)
}

// ForgotPassword sends a reset email. Token stored as SHA256 hash in DB.
// Email enumeration protection: returns success even if email not found.
func (s *authService) ForgotPassword(ctx context.Context, identifier string) (int, error) {
	if s.emailSender == nil || s.resetRepo == nil {
		return 0, fmt.Errorf("%w: password reset is not configured on this server", pkg.ErrBadRequest)
	}

	identifier = strings.TrimSpace(identifier)
	user, err := s.userRepo.GetByEmail(ctx, identifier)
	if errors.Is(err, pkg.ErrNotFound) || user == nil {
		user, err = s.userRepo.GetByUsername(ctx, identifier)
	}
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return 0, nil
		}
		return 0, fmt.Errorf("failed to look up user: %w", err)
	}
	if user.Email == nil || strings.TrimSpace(*user.Email) == "" {
		return 0, nil
	}
	emailAddr := strings.TrimSpace(*user.Email)

	// Cooldown check
	lastToken, err := s.resetRepo.GetLatestByUserID(ctx, user.ID)
	if err == nil {
		elapsed := time.Since(lastToken.CreatedAt)
		if elapsed < resetCooldown {
			remaining := int((resetCooldown - elapsed).Seconds())
			if remaining < 1 {
				remaining = 1
			}
			return remaining, nil
		}
	}

	// Clean up old tokens for this user
	if delErr := s.resetRepo.DeleteByUserID(ctx, user.ID); delErr != nil {
		authLogger.Warn("failed to delete old reset tokens", "user_id", user.ID, "err", pkg.ErrText(delErr))
	}

	// Opportunistic cleanup of all expired tokens
	if delErr := s.resetRepo.DeleteExpired(ctx); delErr != nil {
		authLogger.Warn("failed to delete expired reset tokens", "err", pkg.ErrText(delErr))
	}

	// Generate token (32 bytes = 64 hex chars)
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return 0, fmt.Errorf("failed to generate reset token: %w", err)
	}
	plainToken := hex.EncodeToString(tokenBytes)

	// Store SHA256 hash in DB
	hashBytes := sha256.Sum256([]byte(plainToken))
	tokenHash := hex.EncodeToString(hashBytes[:])

	resetToken := &models.PasswordResetToken{
		UserID:    user.ID,
		TokenHash: tokenHash,
		ExpiresAt: time.Now().Add(resetTokenExpiry),
	}
	if err := s.resetRepo.Create(ctx, resetToken); err != nil {
		return 0, fmt.Errorf("failed to store reset token: %w", err)
	}

	// Send email with plaintext token
	if err := s.emailSender.SendPasswordReset(ctx, emailAddr, plainToken); err != nil {
		return 0, fmt.Errorf("failed to send reset email: %w", err)
	}

	authLogger.Info("password reset email sent", "user_id", user.ID)
	return 0, nil
}

// ResetPassword validates the token, updates the password, and deletes all tokens for the user.
func (s *authService) ResetPassword(ctx context.Context, token, newPassword string) error {
	if s.resetRepo == nil {
		return fmt.Errorf("%w: password reset is not configured on this server", pkg.ErrBadRequest)
	}

	if err := models.ValidateNewPassword(newPassword); err != nil {
		return fmt.Errorf("%w: %s", pkg.ErrBadRequest, err)
	}

	hashBytes := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hashBytes[:])

	resetToken, err := s.resetRepo.GetByTokenHash(ctx, tokenHash)
	if err != nil {
		if errors.Is(err, pkg.ErrNotFound) {
			return fmt.Errorf("%w: invalid or expired reset token", pkg.ErrBadRequest)
		}
		return fmt.Errorf("failed to look up reset token: %w", err)
	}

	if time.Now().After(resetToken.ExpiresAt) {
		if delErr := s.resetRepo.DeleteByID(ctx, resetToken.ID); delErr != nil {
			authLogger.Warn("failed to delete expired reset token", "token_id", resetToken.ID, "err", pkg.ErrText(delErr))
		}
		return fmt.Errorf("%w: reset token has expired", pkg.ErrBadRequest)
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(newPassword), 12)
	if err != nil {
		return fmt.Errorf("failed to hash new password: %w", err)
	}

	if s.authSessions != nil {
		if err := s.authSessions.UpdatePasswordAndRevoke(ctx, resetToken.UserID, "", tokenHash, string(newHash), time.Now().Unix()); err != nil {
			return err
		}
		s.afterBoundSessionRevocation(resetToken.UserID)
		return nil
	}
	if err := s.userRepo.UpdatePassword(ctx, resetToken.UserID, string(newHash)); err != nil {
		return fmt.Errorf("failed to update password: %w", err)
	}

	// Legacy constructors only (production returned through the atomic path).
	// Revoke every session and outstanding access token for this user (see
	// revokeAllSessions in auth_service.go). ResetPassword is
	// unauthenticated account recovery, so — unlike ChangePassword —
	// there's no "caller's own session" to weigh against dropping
	// everything: the anonymous requester proved control of the account
	// via the emailed token, and every pre-existing session (including a
	// possible attacker's) must die. Best-effort: failures are logged
	// inside revokeAllSessions.
	s.revokeAllSessions(ctx, resetToken.UserID)

	// Delete all tokens for this user (one-time use)
	if err := s.resetRepo.DeleteByUserID(ctx, resetToken.UserID); err != nil {
		authLogger.Warn("failed to delete reset tokens after use", "user_id", resetToken.UserID, "err", pkg.ErrText(err))
	}

	authLogger.Info("password reset completed", "user_id", resetToken.UserID)
	return nil
}
