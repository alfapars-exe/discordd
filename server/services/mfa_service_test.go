package services

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	crypt "github.com/argeinfina/hichat/pkg/crypto"
	"github.com/argeinfina/hichat/repository"
)

type mfaHarness struct {
	db   *database.DB
	svc  *MFAService
	auth AuthService
	user *models.User
	now  int64
}

func newMFAHarness(t *testing.T) *mfaHarness {
	t.Helper()
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		t.Fatal(err)
	}
	db, err := database.New(filepath.Join(t.TempDir(), "mfa.db"), migrations)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	users := repository.NewSQLiteUserRepo(db.Conn)
	user := &models.User{Username: "mfa_test", PasswordHash: preHashPassword(t, "current-password"), Status: models.UserStatusOffline}
	if err := users.Create(context.Background(), user); err != nil {
		t.Fatal(err)
	}
	svc := NewMFAService(repository.NewSQLiteMFARepo(db.Conn), users, []byte(strings.Repeat("k", 32)))
	h := &mfaHarness{db: db, svc: svc, user: user, now: 1800000000}
	svc.now = func() time.Time { return time.Unix(h.now, 0) }
	h.auth = NewAuthService(users, repository.NewSQLiteSessionRepo(db.Conn), nil, nil, nil, testJWTSecret, 15, 7, WithMFA(svc))
	return h
}
func (h *mfaHarness) enroll(t *testing.T) (*models.MFASetup, []string) {
	t.Helper()
	setup, err := h.svc.Begin(context.Background(), h.user.ID, "current-password")
	if err != nil {
		t.Fatal(err)
	}
	code, _ := crypt.TOTP(setup.Secret, h.now/30, 6)
	codes, err := h.svc.Confirm(context.Background(), h.user.ID, setup.SetupID, code)
	if err != nil {
		t.Fatal(err)
	}
	return setup, codes
}

func TestMFAServiceEnrollmentLoginReplayAndRecovery(t *testing.T) {
	h := newMFAHarness(t)
	ctx := context.Background()
	setup, codes := h.enroll(t)
	var stored string
	if err := h.db.Conn.QueryRow(`SELECT secret||recovery_hashes FROM account_mfa WHERE user_id=?`, h.user.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, setup.Secret) || strings.Contains(stored, strings.ReplaceAll(codes[0], "-", "")) {
		t.Fatal("plaintext secret/recovery stored")
	}
	if len(codes) != 10 {
		t.Fatal("expected ten recovery codes")
	}
	login := func(code string) error {
		_, err := h.auth.Login(ctx, &models.LoginRequest{Username: h.user.Username, Password: "current-password", MFACode: code})
		return err
	}
	if err := login(""); !errors.Is(err, ErrMFARequired) {
		t.Fatalf("missing factor=%v", err)
	}
	var sessions int
	_ = h.db.Conn.QueryRow(`SELECT count(*) FROM sessions WHERE user_id=?`, h.user.ID).Scan(&sessions)
	if sessions != 0 {
		t.Fatal("session issued before second factor")
	}
	code, _ := crypt.TOTP(setup.Secret, h.now/30, 6)
	if err := login(code); !errors.Is(err, ErrMFAInvalid) {
		t.Fatalf("enrollment replay=%v", err)
	}
	h.now += 300
	code, _ = crypt.TOTP(setup.Secret, h.now/30, 6)
	if err := login(code); err != nil {
		t.Fatal(err)
	}
	if err := login(code); !errors.Is(err, ErrMFAInvalid) {
		t.Fatalf("login replay=%v", err)
	}
	if err := login(codes[0]); err != nil {
		t.Fatal(err)
	}
	if err := login(codes[0]); !errors.Is(err, ErrMFAInvalid) {
		t.Fatalf("recovery reuse=%v", err)
	}
	status, err := h.svc.Status(ctx, h.user.ID)
	if err != nil || !status.Enabled || status.RecoveryRemaining != 9 {
		t.Fatalf("status=%+v %v", status, err)
	}
	encoded, _ := json.Marshal(status)
	if strings.Contains(string(encoded), "secret") {
		t.Fatal("status leaks secret")
	}
}

func TestMFAServiceRotationDisableAndPasswordVerification(t *testing.T) {
	h := newMFAHarness(t)
	ctx := context.Background()
	_, codes := h.enroll(t)
	h.now += 300
	if _, err := h.svc.Regenerate(ctx, h.user.ID, "wrong", codes[0]); err == nil {
		t.Fatal("wrong password accepted")
	}
	updated, err := h.svc.Regenerate(ctx, h.user.ID, "current-password", codes[0])
	if err != nil || len(updated) != 10 {
		t.Fatalf("rotation=%v", err)
	}
	if err := h.svc.CheckLogin(ctx, h.user.ID, codes[1]); !errors.Is(err, ErrMFAInvalid) {
		t.Fatal("old recovery still valid")
	}
	if err := h.svc.Disable(ctx, h.user.ID, "current-password", updated[0]); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.CheckLogin(ctx, h.user.ID, ""); err != nil {
		t.Fatalf("disabled MFA blocks login: %v", err)
	}
	status, err := h.svc.Status(ctx, h.user.ID)
	if err != nil || status.Enabled || status.RecoveryRemaining != 0 {
		t.Fatalf("status=%+v %v", status, err)
	}
}

func TestMFAServiceSetupExpiryRateLimitAndAccountBoundEncryption(t *testing.T) {
	h := newMFAHarness(t)
	ctx := context.Background()
	setup, err := h.svc.Begin(ctx, h.user.ID, "current-password")
	if err != nil {
		t.Fatal(err)
	}
	h.now += 601
	code, _ := crypt.TOTP(setup.Secret, h.now/30, 6)
	if _, err := h.svc.Confirm(ctx, h.user.ID, setup.SetupID, code); !errors.Is(err, ErrMFAInvalid) {
		t.Fatalf("expired setup=%v", err)
	}
	for i := 0; i < 4; i++ {
		_, _ = h.svc.Begin(ctx, h.user.ID, "wrong")
	}
	if _, err := h.svc.Begin(ctx, h.user.ID, "current-password"); !errors.Is(err, ErrMFARateLimited) {
		t.Fatalf("limit=%v", err)
	}
	// A ciphertext copied to another account cannot decrypt with its key.
	encrypted, err := crypt.Encrypt(setup.Secret, h.svc.accountKey(h.user.ID))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := crypt.Decrypt(encrypted, h.svc.accountKey("different-account")); err == nil {
		t.Fatal("cross-account secret swap accepted")
	}
}
