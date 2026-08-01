package services

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/testutil"
)

// Characterization for the credential-management flows (ChangeEmail,
// ForgotPassword, ResetPassword). ChangePassword is already covered by
// auth_service_test.go; these pin the remaining security invariants: password
// re-verification, email-enumeration protection, the reset cooldown, and
// one-time reset-token consumption.

func strptr(s string) *string { return &s }

// newAuthServiceForReset builds the full service with caller-controlled reset
// repo + email sender so the reset flow's collaborators are observable.
func newAuthServiceForReset(userRepo *testutil.MockUserRepo, resetRepo *testutil.MockResetRepo, email *testutil.MockEmailSender) AuthService {
	return NewAuthService(userRepo, &testutil.MockSessionRepo{}, resetRepo, &testutil.MockEventPublisher{}, email, testJWTSecret, 15, 7)
}

func TestChangeEmail(t *testing.T) {
	const pw = "correct-horse"
	hash := preHashPassword(t, pw)
	ctx := context.Background()

	t.Run("wrong password is rejected", func(t *testing.T) {
		ur := &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) {
			return &models.User{ID: "u1", PasswordHash: hash}, nil
		}}
		svc := newAuthServiceForReset(ur, &testutil.MockResetRepo{}, &testutil.MockEmailSender{})
		err := svc.ChangeEmail(ctx, "u1", "wrong", "new@example.com")
		if !errors.Is(err, pkg.ErrUnauthorized) {
			t.Errorf("err = %v, want ErrUnauthorized", err)
		}
	})

	t.Run("valid change persists the new email", func(t *testing.T) {
		var saved *string
		ur := &testutil.MockUserRepo{
			GetByIDFn:    func(context.Context, string) (*models.User, error) { return &models.User{ID: "u1", PasswordHash: hash}, nil },
			UpdateEmailFn: func(_ context.Context, _ string, email *string) error { saved = email; return nil },
		}
		svc := newAuthServiceForReset(ur, &testutil.MockResetRepo{}, &testutil.MockEmailSender{})
		if err := svc.ChangeEmail(ctx, "u1", pw, "new@example.com"); err != nil {
			t.Fatalf("ChangeEmail: %v", err)
		}
		if saved == nil || *saved != "new@example.com" {
			t.Errorf("UpdateEmail got %v, want new@example.com", saved)
		}
	})

	t.Run("invalid email format is rejected", func(t *testing.T) {
		ur := &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) {
			return &models.User{ID: "u1", PasswordHash: hash}, nil
		}}
		svc := newAuthServiceForReset(ur, &testutil.MockResetRepo{}, &testutil.MockEmailSender{})
		if err := svc.ChangeEmail(ctx, "u1", pw, "not-an-email"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("same email is rejected", func(t *testing.T) {
		ur := &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) {
			return &models.User{ID: "u1", PasswordHash: hash, Email: strptr("same@example.com")}, nil
		}}
		svc := newAuthServiceForReset(ur, &testutil.MockResetRepo{}, &testutil.MockEmailSender{})
		if err := svc.ChangeEmail(ctx, "u1", pw, "same@example.com"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("empty email removes an existing address", func(t *testing.T) {
		removed := false
		ur := &testutil.MockUserRepo{
			GetByIDFn: func(context.Context, string) (*models.User, error) {
				return &models.User{ID: "u1", PasswordHash: hash, Email: strptr("old@example.com")}, nil
			},
			UpdateEmailFn: func(_ context.Context, _ string, email *string) error {
				if email != nil {
					t.Errorf("expected nil email for removal, got %v", *email)
				}
				removed = true
				return nil
			},
		}
		svc := newAuthServiceForReset(ur, &testutil.MockResetRepo{}, &testutil.MockEmailSender{})
		if err := svc.ChangeEmail(ctx, "u1", pw, "  "); err != nil {
			t.Fatalf("ChangeEmail: %v", err)
		}
		if !removed {
			t.Error("expected UpdateEmail(nil) to be called")
		}
	})

	t.Run("empty email with no address on file is rejected", func(t *testing.T) {
		ur := &testutil.MockUserRepo{GetByIDFn: func(context.Context, string) (*models.User, error) {
			return &models.User{ID: "u1", PasswordHash: hash, Email: nil}, nil
		}}
		svc := newAuthServiceForReset(ur, &testutil.MockResetRepo{}, &testutil.MockEmailSender{})
		if err := svc.ChangeEmail(ctx, "u1", pw, ""); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})
}

func TestForgotPassword(t *testing.T) {
	ctx := context.Background()

	t.Run("unknown email does not leak existence and creates no token", func(t *testing.T) {
		created := false
		ur := &testutil.MockUserRepo{GetByEmailFn: func(context.Context, string) (*models.User, error) {
			return nil, pkg.ErrNotFound
		}}
		reset := &testutil.MockResetRepo{CreateFn: func(context.Context, *models.PasswordResetToken) error {
			created = true
			return nil
		}}
		svc := newAuthServiceForReset(ur, reset, &testutil.MockEmailSender{})

		remaining, err := svc.ForgotPassword(ctx, "ghost@example.com")
		if err != nil {
			t.Fatalf("ForgotPassword should not error for an unknown email: %v", err)
		}
		if remaining != 0 {
			t.Errorf("remaining = %d, want 0", remaining)
		}
		if created {
			t.Error("no reset token must be created for an unknown email")
		}
	})

	t.Run("recent request is rate-limited by cooldown", func(t *testing.T) {
		created := false
		ur := &testutil.MockUserRepo{GetByEmailFn: func(context.Context, string) (*models.User, error) {
			return &models.User{ID: "u1", Email: strptr("u@example.com")}, nil
		}}
		reset := &testutil.MockResetRepo{
			GetLatestByUserIDFn: func(context.Context, string) (*models.PasswordResetToken, error) {
				return &models.PasswordResetToken{CreatedAt: time.Now().Add(-5 * time.Second)}, nil
			},
			CreateFn: func(context.Context, *models.PasswordResetToken) error { created = true; return nil },
		}
		svc := newAuthServiceForReset(ur, reset, &testutil.MockEmailSender{})

		remaining, err := svc.ForgotPassword(ctx, "u@example.com")
		if err != nil {
			t.Fatalf("ForgotPassword: %v", err)
		}
		if remaining <= 0 {
			t.Errorf("remaining = %d, want a positive cooldown", remaining)
		}
		if created {
			t.Error("a token must not be created while the cooldown is active")
		}
	})

	t.Run("valid request stores a token and sends the email", func(t *testing.T) {
		var createdHash string
		var sentTo, sentToken string
		ur := &testutil.MockUserRepo{GetByEmailFn: func(context.Context, string) (*models.User, error) {
			return &models.User{ID: "u1", Email: strptr("u@example.com")}, nil
		}}
		reset := &testutil.MockResetRepo{
			// No prior token: the real repo signals this with ErrNotFound, and
			// ForgotPassword only reads lastToken.CreatedAt when err == nil.
			GetLatestByUserIDFn: func(context.Context, string) (*models.PasswordResetToken, error) {
				return nil, pkg.ErrNotFound
			},
			CreateFn: func(_ context.Context, tok *models.PasswordResetToken) error {
				createdHash = tok.TokenHash
				return nil
			},
		}
		email := &testutil.MockEmailSender{SendPasswordResetFn: func(_ context.Context, to, token string) error {
			sentTo, sentToken = to, token
			return nil
		}}
		svc := newAuthServiceForReset(ur, reset, email)

		if _, err := svc.ForgotPassword(ctx, "u@example.com"); err != nil {
			t.Fatalf("ForgotPassword: %v", err)
		}
		if createdHash == "" {
			t.Error("expected a reset token to be stored")
		}
		if sentTo != "u@example.com" || sentToken == "" {
			t.Errorf("email send got to=%q token=%q, want the address and a plaintext token", sentTo, sentToken)
		}
		// The DB stores the hash, never the plaintext token that was emailed.
		if createdHash == sentToken {
			t.Error("stored token hash must not equal the plaintext token that was emailed")
		}
	})
}

func TestResetPassword(t *testing.T) {
	ctx := context.Background()

	t.Run("short password is rejected", func(t *testing.T) {
		svc := newAuthServiceForReset(&testutil.MockUserRepo{}, &testutil.MockResetRepo{}, &testutil.MockEmailSender{})
		if err := svc.ResetPassword(ctx, "sometoken", "short"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("unknown token is rejected", func(t *testing.T) {
		reset := &testutil.MockResetRepo{GetByTokenHashFn: func(context.Context, string) (*models.PasswordResetToken, error) {
			return nil, pkg.ErrNotFound
		}}
		svc := newAuthServiceForReset(&testutil.MockUserRepo{}, reset, &testutil.MockEmailSender{})
		if err := svc.ResetPassword(ctx, "bogus", "long-enough-password"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
	})

	t.Run("expired token is rejected and deleted", func(t *testing.T) {
		deleted := false
		reset := &testutil.MockResetRepo{
			GetByTokenHashFn: func(context.Context, string) (*models.PasswordResetToken, error) {
				return &models.PasswordResetToken{ID: "t1", UserID: "u1", ExpiresAt: time.Now().Add(-time.Minute)}, nil
			},
			DeleteByIDFn: func(context.Context, string) error { deleted = true; return nil },
		}
		svc := newAuthServiceForReset(&testutil.MockUserRepo{}, reset, &testutil.MockEmailSender{})
		if err := svc.ResetPassword(ctx, "expired", "long-enough-password"); !errors.Is(err, pkg.ErrBadRequest) {
			t.Errorf("err = %v, want ErrBadRequest", err)
		}
		if !deleted {
			t.Error("an expired token must be deleted")
		}
	})

	t.Run("valid token updates the password and clears all tokens", func(t *testing.T) {
		var newHash string
		var clearedUser string
		ur := &testutil.MockUserRepo{UpdatePasswordFn: func(_ context.Context, _ string, hash string) error {
			newHash = hash
			return nil
		}}
		reset := &testutil.MockResetRepo{
			GetByTokenHashFn: func(context.Context, string) (*models.PasswordResetToken, error) {
				return &models.PasswordResetToken{ID: "t1", UserID: "u1", ExpiresAt: time.Now().Add(time.Minute)}, nil
			},
			DeleteByUserIDFn: func(_ context.Context, userID string) error { clearedUser = userID; return nil },
		}
		svc := newAuthServiceForReset(ur, reset, &testutil.MockEmailSender{})
		if err := svc.ResetPassword(ctx, "valid", "long-enough-password"); err != nil {
			t.Fatalf("ResetPassword: %v", err)
		}
		if newHash == "" || newHash == "long-enough-password" {
			t.Errorf("password must be stored as a bcrypt hash, got %q", newHash)
		}
		if clearedUser != "u1" {
			t.Errorf("all tokens for the user must be cleared, DeleteByUserID got %q", clearedUser)
		}
	})
}

// TestResetPassword_RevokesAllSessions pins the ResetPassword half of H-06:
// account recovery must invalidate every existing session for the token's
// owner (session rows, token_version, the HTTP auth cache, and any live
// WebSocket/voice connection), not leave them alive as before. Unlike
// ChangePassword, there is no "caller's own session" to spare — see the
// design note in auth_password.go. An expired/invalid token must touch none
// of the revocation collaborators.
//
// DeleteByUserID is asserted at TWO calls — see the BULGU 2 comment on
// revokeAllSessions in auth_service.go and the matching note on
// TestChangePassword_RevokesAllSessions.
func TestResetPassword_RevokesAllSessions(t *testing.T) {
	ctx := context.Background()

	t.Run("success revokes every session for the token's owner", func(t *testing.T) {
		userRepo := &testutil.MockUserRepo{}
		resetRepo := &testutil.MockResetRepo{
			GetByTokenHashFn: func(context.Context, string) (*models.PasswordResetToken, error) {
				return &models.PasswordResetToken{ID: "t1", UserID: "u1", ExpiresAt: time.Now().Add(time.Minute)}, nil
			},
		}
		svc, spy := newRevokeHarness(userRepo, &testutil.MockSessionRepo{}, resetRepo)

		if err := svc.ResetPassword(ctx, "valid", "long-enough-password"); err != nil {
			t.Fatalf("ResetPassword: %v", err)
		}

		assertRevocationFired(t, spy, "u1")
	})

	t.Run("expired token touches none of the revocation collaborators", func(t *testing.T) {
		userRepo := &testutil.MockUserRepo{}
		resetRepo := &testutil.MockResetRepo{
			GetByTokenHashFn: func(context.Context, string) (*models.PasswordResetToken, error) {
				return &models.PasswordResetToken{ID: "t1", UserID: "u1", ExpiresAt: time.Now().Add(-time.Minute)}, nil
			},
		}
		svc, spy := newRevokeHarness(userRepo, &testutil.MockSessionRepo{}, resetRepo)

		err := svc.ResetPassword(ctx, "expired", "long-enough-password")
		if !errors.Is(err, pkg.ErrBadRequest) {
			t.Fatalf("err = %v, want ErrBadRequest", err)
		}
		assertRevocationUntouched(t, spy, "on an expired reset token")
	})
}
