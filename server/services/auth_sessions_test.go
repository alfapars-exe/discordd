package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
)

func TestAuthSessionsCredentialWritesRevokeAtomically(t *testing.T) {
	for _, reset := range []bool{false, true} {
		t.Run(map[bool]string{false: "change", true: "reset"}[reset], func(t *testing.T) {
			h, s, _ := boundAuthHarness(t)
			ctx := context.Background()
			login := sessionLogin(t, s, h.user.Username)
			apply := func() error { return s.ChangePassword(ctx, h.user.ID, "current-password", "new-password-2026") }
			if reset {
				s.resetRepo = repository.NewSQLiteResetTokenRepo(h.db.Conn)
				sum := sha256.Sum256([]byte("fixture-reset"))
				if err := s.resetRepo.Create(ctx, &models.PasswordResetToken{UserID: h.user.ID, TokenHash: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
					t.Fatal(err)
				}
				apply = func() error { return s.ResetPassword(ctx, "fixture-reset", "new-password-2026") }
			}
			if _, err := h.db.Conn.Exec(`CREATE TRIGGER fail_credential_revoke BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
				t.Fatal(err)
			}
			if err := apply(); err == nil {
				t.Fatal("partial credential change reported success")
			}
			if err := s.ValidateSession(ctx, h.user.ID, login.SessionID); err != nil {
				t.Fatal("failed credential write revoked session", err)
			}
			if _, err := h.db.Conn.Exec(`DROP TRIGGER fail_credential_revoke`); err != nil {
				t.Fatal(err)
			}
			if err := apply(); err != nil {
				t.Fatal("retry after rollback", err)
			}
			if err := s.ValidateSession(ctx, h.user.ID, login.SessionID); !errors.Is(err, pkg.ErrUnauthorized) {
				t.Fatal("password write retained old sign-in", err)
			}
			if _, err := s.Login(ctx, &models.LoginRequest{Username: h.user.Username, Password: "current-password"}); err == nil {
				t.Fatal("old password retained")
			}
			if _, err := s.Login(ctx, &models.LoginRequest{Username: h.user.Username, Password: "new-password-2026"}); err != nil {
				t.Fatal("new password rejected", err)
			}
			if reset {
				if err := apply(); err == nil {
					t.Fatal("reset proof reused")
				}
			}
		})
	}
}

type sessionCaptureHub struct {
	*testutil.MockEventPublisher
	ended []string
}

func (h *sessionCaptureHub) DisconnectSession(owner, id string) {
	h.ended = append(h.ended, owner+":"+id)
}
func boundAuthHarness(t *testing.T) (*mfaHarness, *authService, *sessionCaptureHub) {
	t.Helper()
	h := newMFAHarness(t)
	users := repository.NewSQLiteUserRepo(h.db.Conn)
	hub := &sessionCaptureHub{MockEventPublisher: &testutil.MockEventPublisher{}}
	svc := NewAuthService(users, repository.NewSQLiteSessionRepo(h.db.Conn), nil, hub, nil, testJWTSecret, 15, 7, WithAuthSessions(repository.NewSQLiteAuthSessionRepo(h.db.Conn)), WithMFA(h.svc)).(*authService)
	return h, svc, hub
}
func sessionLogin(t *testing.T, s *authService, name string) *AuthTokens {
	t.Helper()
	tokens, err := s.Login(WithSessionMetadata(context.Background(), "web", "Fixture Browser"), &models.LoginRequest{Username: name, Password: "current-password"})
	if err != nil {
		t.Fatal(err)
	}
	return tokens
}

func TestSensitiveCredentialActionsShareDurableAttemptBudget(t *testing.T) {
	for _, test := range []struct {
		name string
		try  func(*authService, string) error
	}{
		{name: "password", try: func(s *authService, userID string) error {
			return s.ChangePassword(context.Background(), userID, "wrong-password", "new-password-2026")
		}},
		{name: "email", try: func(s *authService, userID string) error {
			return s.ChangeEmail(context.Background(), userID, "wrong-password", "new@example.com")
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			h, service, _ := boundAuthHarness(t)
			for attempt := 0; attempt < 5; attempt++ {
				if err := test.try(service, h.user.ID); !errors.Is(err, pkg.ErrUnauthorized) {
					t.Fatalf("attempt %d = %v, want unauthorized", attempt+1, err)
				}
			}
			if err := test.try(service, h.user.ID); !errors.Is(err, ErrMFARateLimited) {
				t.Fatalf("sixth attempt = %v, want durable rate limit", err)
			}
		})
	}
}

func TestAuthSessionsStableRefreshAndSelectiveRevocation(t *testing.T) {
	h, s, hub := boundAuthHarness(t)
	ctx := context.Background()
	a := sessionLogin(t, s, h.user.Username)
	b := sessionLogin(t, s, h.user.Username)
	claims, err := s.ValidateAccessToken(a.AccessToken)
	if err != nil || claims.SessionID == "" || claims.SessionID != a.SessionID {
		t.Fatalf("sid binding=%+v %v", claims, err)
	}
	rotated, err := s.RefreshToken(WithExpectedAuthSession(ctx, a.SessionID), a.RefreshToken)
	if err != nil || rotated.SessionID != a.SessionID {
		t.Fatalf("refresh identity=%v", err)
	}
	if err := s.ValidateSession(ctx, h.user.ID, a.SessionID); err != nil {
		t.Fatal("old access session invalidated by rotation")
	}
	if _, err := s.RefreshToken(ctx, a.RefreshToken); !errors.Is(err, ErrRefreshSuperseded) {
		t.Fatalf("concurrent duplicate=%v", err)
	}
	if err := s.ValidateSession(ctx, h.user.ID, a.SessionID); err != nil {
		t.Fatal("bounded duplicate revoked every sign-in")
	}
	list, err := s.ListSessions(ctx, h.user.ID, a.SessionID)
	if err != nil || len(list) != 2 {
		t.Fatalf("list=%v %v", list, err)
	}
	for _, session := range list {
		if session.Current != (session.ID == a.SessionID) {
			t.Fatal("wrong current marker")
		}
	}
	if err := s.RevokeSession(ctx, h.user.ID, a.SessionID, b.SessionID, "wrong", ""); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("wrong password allowed revoke")
	}
	if err := s.RevokeSession(ctx, h.user.ID, a.SessionID, b.SessionID, "current-password", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.ValidateSession(ctx, h.user.ID, b.SessionID); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("revoked access still valid")
	}
	if _, err := s.RefreshToken(ctx, b.RefreshToken); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("revoked refresh still valid")
	}
	if err := s.ValidateSession(ctx, h.user.ID, a.SessionID); err != nil {
		t.Fatal("current session wrongly ended")
	}
	if len(hub.ended) != 1 || !strings.HasSuffix(hub.ended[0], ":"+b.SessionID) {
		t.Fatalf("disconnects=%v", hub.ended)
	}
}

func TestAuthSessionsOtherSessionCookieDoesNotChangeBinding(t *testing.T) {
	h, s, _ := boundAuthHarness(t)
	ctx := context.Background()
	a := sessionLogin(t, s, h.user.Username)
	b := sessionLogin(t, s, h.user.Username)
	if _, err := s.RefreshToken(WithExpectedAuthSession(ctx, a.SessionID), b.RefreshToken); !errors.Is(err, ErrAuthSessionMismatch) {
		t.Fatalf("mismatch=%v", err)
	}
	if err := s.EndSession(ctx, h.user.ID, a.SessionID); err != nil {
		t.Fatal(err)
	}
	if err := s.ValidateSession(ctx, h.user.ID, b.SessionID); err != nil {
		t.Fatal("other sign-in lost access")
	}
	if _, err := s.RefreshToken(WithExpectedAuthSession(ctx, b.SessionID), b.RefreshToken); err != nil {
		t.Fatal("other refresh cookie was consumed")
	}
}

func TestAuthSessionsRegistrationAtomicBindingAndUpgrade(t *testing.T) {
	h, s, _ := boundAuthHarness(t)
	ctx := context.Background()
	tokens, err := s.Register(ctx, &models.CreateUserRequest{Username: "bound_registration", Password: "new-password", Email: "bound@example.com"})
	if err != nil || tokens.SessionID == "" {
		t.Fatalf("register=%v", err)
	}
	if err := s.ValidateSession(ctx, tokens.User.ID, tokens.SessionID); err != nil {
		t.Fatal(err)
	}
	legacy := NewAuthService(repository.NewSQLiteUserRepo(h.db.Conn), repository.NewSQLiteSessionRepo(h.db.Conn), nil, nil, nil, testJWTSecret, 15, 7)
	old, err := legacy.Login(ctx, &models.LoginRequest{Username: h.user.Username, Password: "current-password"})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ValidateSession(ctx, h.user.ID, ""); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("unbound old access bypassed upgrade")
	}
	upgraded, err := s.RefreshToken(ctx, old.RefreshToken)
	if err != nil || upgraded.SessionID == "" {
		t.Fatalf("legacy upgrade=%v", err)
	}
	if err := s.ValidateSession(ctx, h.user.ID, upgraded.SessionID); err != nil {
		t.Fatal(err)
	}
}
