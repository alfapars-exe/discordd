package services

import (
	"context"
	"errors"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/repository"
	"github.com/argeinfina/hichat/testutil"
	"testing"
)

func TestAccountAnonymizationRequiresPasswordFactorAndRevokes(t *testing.T) {
	h, s, hub := boundAuthHarness(t)
	invalidator := &adminInvalStub{}
	voice := &testutil.MockVoiceDisconnecter{}
	s.SetUserCacheInvalidator(invalidator)
	s.SetVoiceDisconnecter(voice)
	disconnected := ""
	hub.DisconnectUserFn = func(id string) { disconnected = id }
	s.accountAnonymization = repository.NewSQLiteAccountAnonymizationRepo(h.db.Conn)
	ctx := context.Background()
	login := sessionLogin(t, s, h.user.Username)
	_, codes := h.enroll(t)
	if err := s.DeleteAccount(ctx, h.user.ID, login.SessionID, "wrong-password", ""); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("wrong password accepted", err)
	}
	if err := s.DeleteAccount(ctx, h.user.ID, login.SessionID, "current-password", ""); !errors.Is(err, ErrMFARequired) {
		t.Fatal("missing factor accepted", err)
	}
	h.now += 301 // Do not weaken the shared durable attempt budget for fixtures.
	if err := s.DeleteAccount(ctx, h.user.ID, login.SessionID, "current-password", codes[0]); err != nil {
		t.Fatal(err)
	}
	if disconnected != h.user.ID || len(invalidator.invalidated) != 1 || invalidator.invalidated[0] != h.user.ID || len(voice.DisconnectedIDs) != 1 || voice.DisconnectedIDs[0] != h.user.ID {
		t.Fatal("runtime revocation incomplete", disconnected, invalidator.invalidated, voice.DisconnectedIDs)
	}
	if err := s.ValidateSession(ctx, h.user.ID, login.SessionID); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("deleted session remained active", err)
	}
	if _, err := s.RefreshToken(ctx, login.RefreshToken); err == nil {
		t.Fatal("deleted refresh remained active")
	}
	if _, err := s.Login(ctx, &models.LoginRequest{Username: h.user.Username, Password: "current-password", Reactivate: true}); err == nil {
		t.Fatal("deleted account restored")
	}
	var hash string
	if err := h.db.Conn.QueryRow(`SELECT password_hash FROM users WHERE id=?`, h.user.ID).Scan(&hash); err != nil || hash != "!deleted!" {
		t.Fatal("identity not replaced", hash, err)
	}
}

func TestAccountAnonymizationFailureDoesNotRevoke(t *testing.T) {
	h, s, _ := boundAuthHarness(t)
	s.accountAnonymization = repository.NewSQLiteAccountAnonymizationRepo(h.db.Conn)
	ctx := context.Background()
	login := sessionLogin(t, s, h.user.Username)
	if _, err := h.db.Conn.Exec(`CREATE TRIGGER deny_delete BEFORE UPDATE OF deleted_at ON users BEGIN SELECT RAISE(ABORT,'fixture failure'); END`); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteAccount(ctx, h.user.ID, login.SessionID, "current-password", ""); err == nil {
		t.Fatal("failed transition reported success")
	}
	if err := s.ValidateSession(ctx, h.user.ID, login.SessionID); err != nil {
		t.Fatal("failed transition revoked caller", err)
	}
}

type anonymizationTransition func(context.Context, string, string, string, string, int64) error

func (f anonymizationTransition) Anonymize(ctx context.Context, owner, sid, hash, mfa string, now int64) error {
	return f(ctx, owner, sid, hash, mfa, now)
}

func TestAccountAnonymizationRejectsFactorChangedAfterProof(t *testing.T) {
	h, s, _ := boundAuthHarness(t)
	ctx := context.Background()
	login := sessionLogin(t, s, h.user.Username)
	repo := repository.NewSQLiteAccountAnonymizationRepo(h.db.Conn)
	s.accountAnonymization = anonymizationTransition(func(ctx context.Context, owner, sid, hash, mfa string, now int64) error {
		// Simulate a concurrent MFA enrollment after password/no-factor proof.
		if _, err := h.db.Conn.Exec(`UPDATE account_mfa SET secret='changed-security-fixture' WHERE user_id=?`, owner); err != nil {
			return err
		}
		return repo.Anonymize(ctx, owner, sid, hash, mfa, now)
	})
	if err := s.DeleteAccount(ctx, h.user.ID, login.SessionID, "current-password", ""); !errors.Is(err, pkg.ErrUnauthorized) {
		t.Fatal("security change ignored", err)
	}
	if err := s.ValidateSession(ctx, h.user.ID, login.SessionID); err != nil {
		t.Fatal("security race revoked caller", err)
	}
}
