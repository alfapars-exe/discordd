package services

import (
	"context"
	"errors"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
	"github.com/argeinfina/hichat/pkg/crypto"
)

// fakeBackupRepo is an in-memory E2EEKeyBackupRepository for testing the
// service-level integrity check without a database.
type fakeBackupRepo struct {
	stored *models.E2EEKeyBackup
}

func (f *fakeBackupRepo) Upsert(_ context.Context, userID string, req *models.CreateKeyBackupRequest, backupHMAC string) error {
	f.stored = &models.E2EEKeyBackup{
		UserID:        userID,
		Version:       req.Version,
		Algorithm:     req.Algorithm,
		EncryptedData: req.EncryptedData,
		Nonce:         req.Nonce,
		Salt:          req.Salt,
		BackupHMAC:    backupHMAC,
	}
	return nil
}

func (f *fakeBackupRepo) GetByUser(_ context.Context, _ string) (*models.E2EEKeyBackup, error) {
	return f.stored, nil
}

func (f *fakeBackupRepo) Delete(_ context.Context, _ string) error {
	f.stored = nil
	return nil
}

func TestKeyBackup_RoundTripAndTamperDetection(t *testing.T) {
	repo := &fakeBackupRepo{}
	key := crypto.DeriveBackupHMACKey([]byte("test-master-key-0123456789abcdef"))
	svc := NewE2EEService(repo, nil, nil, nil, nil, nil, nil, key)
	ctx := context.Background()

	req := &models.CreateKeyBackupRequest{
		Version: 1, Algorithm: "aes-256-gcm",
		EncryptedData: "cipher", Nonce: "nonce", Salt: "salt",
	}
	if err := svc.UpsertKeyBackup(ctx, "user-1", req); err != nil {
		t.Fatalf("upsert: %v", err)
	}
	if repo.stored.BackupHMAC == "" {
		t.Fatal("expected the server to stamp a backup HMAC on upsert")
	}

	// Untampered round-trip returns the backup.
	got, err := svc.GetKeyBackup(ctx, "user-1")
	if err != nil {
		t.Fatalf("get (untampered): %v", err)
	}
	if got == nil || got.EncryptedData != "cipher" {
		t.Fatal("expected the untampered backup to be returned")
	}

	// Tamper the at-rest blob while keeping the old HMAC → must be rejected.
	repo.stored.EncryptedData = "tampered-cipher"
	if _, err := svc.GetKeyBackup(ctx, "user-1"); err == nil {
		t.Fatal("expected an integrity error for a tampered backup, got nil")
	} else if !errors.Is(err, pkg.ErrInternal) {
		t.Fatalf("expected pkg.ErrInternal, got %v", err)
	}

	// Legacy row with no HMAC is returned as-is (no false positive).
	repo.stored.BackupHMAC = ""
	repo.stored.EncryptedData = "legacy-cipher"
	got, err = svc.GetKeyBackup(ctx, "user-1")
	if err != nil {
		t.Fatalf("legacy (no-HMAC) backup should be returned, got: %v", err)
	}
	if got == nil || got.EncryptedData != "legacy-cipher" {
		t.Fatal("expected the legacy backup to be returned unchanged")
	}
}
