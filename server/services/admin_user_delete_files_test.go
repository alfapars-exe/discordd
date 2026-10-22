package services

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/testutil"
)

// TestHardDeleteUser_RemovesOwnedServerFilesAfterCommit — the files of the
// servers a deleted user owned are collected before the delete (the cascade
// removes their rows) and removed only after the delete succeeded.
func TestHardDeleteUser_RemovesOwnedServerFilesAfterCommit(t *testing.T) {
	uploadDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(uploadDir, "soundboard"), 0o750); err != nil {
		t.Fatal(err)
	}
	clip := filepath.Join(uploadDir, "soundboard", "aaaa_ding.ogg")
	if err := os.WriteFile(clip, []byte("OggS"), 0o600); err != nil {
		t.Fatal(err)
	}

	ur := userReturning(&models.User{ID: "t"})
	collectedBeforeDelete := false
	deleted := false
	ur.GetOwnedServerFileURLsFn = func(context.Context, string) ([]string, error) {
		collectedBeforeDelete = !deleted
		return []string{"/api/uploads/soundboard/aaaa_ding.ogg"}, nil
	}
	ur.HardDeleteUserFn = func(context.Context, string, string) error {
		if _, err := os.Stat(clip); err != nil {
			t.Error("file was removed before the delete committed")
		}
		deleted = true
		return nil
	}
	h := newAdminHarness(ur, &testutil.MockEmailSender{})
	h.svc.SetUploadDir(uploadDir)

	if err := h.svc.HardDeleteUser(context.Background(), "admin", "t", ""); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}
	if !collectedBeforeDelete {
		t.Error("owned-server files must be collected before the delete")
	}
	if _, err := os.Stat(clip); !os.IsNotExist(err) {
		t.Errorf("owned server's soundboard file still on disk (stat err = %v)", err)
	}
}

// TestHardDeleteUser_FailedDeleteKeepsFiles — if the delete fails the rows
// still point at the files, so nothing is removed.
func TestHardDeleteUser_FailedDeleteKeepsFiles(t *testing.T) {
	uploadDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(uploadDir, "soundboard"), 0o750); err != nil {
		t.Fatal(err)
	}
	clip := filepath.Join(uploadDir, "soundboard", "aaaa_ding.ogg")
	if err := os.WriteFile(clip, []byte("OggS"), 0o600); err != nil {
		t.Fatal(err)
	}

	ur := userReturning(&models.User{ID: "t"})
	ur.GetOwnedServerFileURLsFn = func(context.Context, string) ([]string, error) {
		return []string{"/api/uploads/soundboard/aaaa_ding.ogg"}, nil
	}
	ur.HardDeleteUserFn = func(context.Context, string, string) error { return errors.New("db down") }
	h := newAdminHarness(ur, &testutil.MockEmailSender{})
	h.svc.SetUploadDir(uploadDir)

	if err := h.svc.HardDeleteUser(context.Background(), "admin", "t", ""); err == nil {
		t.Fatal("want the delete error")
	}
	if _, err := os.Stat(clip); err != nil {
		t.Errorf("file removed although the delete failed: %v", err)
	}
}
