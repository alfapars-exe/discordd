package services

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
)

func TestAccountLifecycleExplicitRestoreAndMFA(t *testing.T) {
	h, s, _ := boundAuthHarness(t)
	s.accountLifecycle = repository.NewSQLiteAccountLifecycleRepo(h.db.Conn)
	ctx := context.Background()
	login := sessionLogin(t, s, h.user.Username)
	_, codes := h.enroll(t)
	if err := s.DisableAccount(ctx, h.user.ID, login.SessionID, "current-password", ""); !errors.Is(err, ErrMFARequired) {
		t.Fatalf("factor required %v", err)
	}
	if err := s.DisableAccount(ctx, h.user.ID, login.SessionID, "current-password", codes[0]); err != nil {
		t.Fatal(err)
	}
	// Keep the existing shared security-attempt budget intact: the enrollment
	// and disable probes used this window; restoration occurs in a new one.
	h.now += 301
	req := &models.LoginRequest{Username: h.user.Username, Password: "current-password"}
	if _, err := s.Login(ctx, req); !errors.Is(err, ErrAccountDisabled) {
		t.Fatalf("ordinary login restored account %v", err)
	}
	if _, err := s.RefreshToken(ctx, login.RefreshToken); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatalf("old refresh restored %v", err)
	}
	req.Reactivate = true
	if _, err := s.Login(ctx, req); !errors.Is(err, ErrMFARequired) {
		t.Fatalf("restore ignored second factor %v", err)
	}
	req.MFACode = codes[0]
	if _, err := s.Login(ctx, req); !errors.Is(err, ErrMFAInvalid) {
		t.Fatal("disable proof reused for restore", err)
	}
	req.MFACode = codes[1]
	restored, err := s.Login(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if restored.SessionID == login.SessionID {
		t.Fatal("restored old sign-in identity")
	}
	if err := s.ValidateSession(ctx, h.user.ID, restored.SessionID); err != nil {
		t.Fatal(err)
	}
	if err := s.ValidateSession(ctx, h.user.ID, login.SessionID); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("old access resurrected", err)
	}
	if restored.User.PasswordHash != "" {
		t.Fatal("restore exposed password hash")
	}
}

func TestAccountLifecyclePasswordRecoveryDoesNotRestore(t *testing.T) {
	h, s, _ := boundAuthHarness(t)
	s.accountLifecycle = repository.NewSQLiteAccountLifecycleRepo(h.db.Conn)
	ctx := context.Background()
	login := sessionLogin(t, s, h.user.Username)
	if err := s.DisableAccount(ctx, h.user.ID, login.SessionID, "current-password", ""); err != nil {
		t.Fatal(err)
	}
	s.resetRepo = repository.NewSQLiteResetTokenRepo(h.db.Conn)
	sum := sha256.Sum256([]byte("disabled-reset"))
	if err := s.resetRepo.Create(ctx, &models.PasswordResetToken{UserID: h.user.ID, TokenHash: hex.EncodeToString(sum[:]), ExpiresAt: time.Now().Add(time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if err := s.ResetPassword(ctx, "disabled-reset", "recovered-password"); err != nil {
		t.Fatal(err)
	}
	state, err := s.accountLifecycle.Get(ctx, h.user.ID)
	if err != nil || state.DisabledAt == nil {
		t.Fatal("password recovery restored account", err)
	}
	req := &models.LoginRequest{Username: h.user.Username, Password: "recovered-password"}
	if _, err := s.Login(ctx, req); !errors.Is(err, ErrAccountDisabled) {
		t.Fatal("ordinary recovered login restored account", err)
	}
	req.Reactivate = true
	if _, err := s.Login(ctx, req); err != nil {
		t.Fatal("explicit recovered restore failed", err)
	}
}
