package services

import (
	"context"
	"github.com/argeinfina/hichat/repository"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAccountAssetCleanupActualFilesReferencesAndRetirement(t *testing.T) {
	h := newMFAHarness(t)
	dir := t.TempDir()
	ctx := context.Background()
	now := time.Now()
	for _, name := range []string{"private.png", "profile.png", "shared.bin"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("fixture"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := h.db.Conn.Exec(`INSERT INTO account_asset_cleanup(file_url,requested_at) VALUES(?,?)`, "/api/uploads/"+name, now.Unix()); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.db.Conn.Exec(`UPDATE users SET avatar_url='/api/uploads/profile.png' WHERE id=?`, h.user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Conn.Exec(`INSERT INTO users(id,username,password_hash) VALUES('survivor','cleanuptest','hash')`); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Conn.Exec(`INSERT INTO dm_channels(id,user1_id,user2_id) VALUES('cleanup-dm',?,'survivor')`, h.user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Conn.Exec(`INSERT INTO dm_messages(id,dm_channel_id,user_id,content) VALUES('cleanup-message','cleanup-dm',?,'ciphertext')`, h.user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Conn.Exec(`INSERT INTO dm_attachments(id,dm_message_id,filename,file_url) VALUES('cleanup-file','cleanup-message','file','/api/uploads/SHARED.bin')`); err != nil {
		t.Fatal(err)
	}
	worker := NewAccountAssetCleanup(repository.NewSQLiteAccountAssetCleanupRepo(h.db.Conn), dir)
	result, err := worker.RunOnce(ctx, now)
	if err != nil || result.Removed != 1 || result.Referenced != 2 {
		t.Fatalf("result %+v %v", result, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "private.png")); !os.IsNotExist(err) {
		t.Fatal("private file survived", err)
	}
	for _, name := range []string{"profile.png", "shared.bin"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Fatal("shared file removed", name, err)
		}
	}
	if _, err := h.db.Conn.Exec(`UPDATE users SET avatar_url='/api/uploads/PRIVATE.png' WHERE id=?`, h.user.ID); err == nil {
		t.Fatal("retired URL reattached")
	}
	if _, err := h.db.Conn.Exec(`UPDATE users SET avatar_url=NULL WHERE id=?`, h.user.ID); err != nil {
		t.Fatal(err)
	}
	result, err = worker.RunOnce(ctx, now.Add(61*time.Second))
	if err != nil || result.Removed != 1 || result.Referenced != 1 {
		t.Fatalf("retry %+v %v", result, err)
	}
}

func TestAccountAssetCleanupDurableFailureRetryAndUnsafePaths(t *testing.T) {
	h := newMFAHarness(t)
	dir := t.TempDir()
	now := time.Now()
	ctx := context.Background()
	// A directory at a file path is not recursively removed or reported done.
	if err := os.Mkdir(filepath.Join(dir, "retry.bin"), 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := h.db.Conn.Exec(`INSERT INTO account_asset_cleanup(file_url,requested_at) VALUES('/api/uploads/retry.bin',?)`, now.Unix()); err != nil {
		t.Fatal(err)
	}
	worker := NewAccountAssetCleanup(repository.NewSQLiteAccountAssetCleanupRepo(h.db.Conn), dir)
	first, err := worker.RunOnce(ctx, now)
	if err != nil || first.Retry != 1 {
		t.Fatalf("first %+v %v", first, err)
	}
	var retired, completed int
	if err := h.db.Conn.QueryRow(`SELECT retired_at IS NOT NULL,completed_at IS NOT NULL FROM account_asset_cleanup`).Scan(&retired, &completed); err != nil || retired != 1 || completed != 0 {
		t.Fatal(retired, completed, err)
	}
	if _, err := h.db.Conn.Exec(`UPDATE users SET avatar_url='/api/uploads/retry.bin' WHERE id=?`, h.user.ID); err == nil {
		t.Fatal("failed removal lost retirement")
	}
	if err := os.Remove(filepath.Join(dir, "retry.bin")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "retry.bin"), []byte("retry"), 0600); err != nil {
		t.Fatal(err)
	}
	// New worker instance reads durable work, not an in-memory retry list.
	worker = NewAccountAssetCleanup(repository.NewSQLiteAccountAssetCleanupRepo(h.db.Conn), dir)
	next, err := worker.RunOnce(ctx, now.Add(61*time.Second))
	if err != nil || next.Removed != 1 {
		t.Fatalf("next %+v %v", next, err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	for _, url := range []string{"/api/uploads/../outside", "/api/uploads/%2e%2e/outside", "/api/uploads/a\\outside", "/api/uploads/x:stream", "/api/uploads/", "/api/uploads/.", "/api/uploads/a//b", "https://example.invalid/file"} {
		if removeAccountAsset(root, url) == nil {
			t.Fatalf("unsafe URL accepted %q", url)
		}
	}
}

func TestAccountAssetCleanupRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.bin")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(dir, "link.bin")); err != nil {
		t.Skipf("symlink creation unavailable on this host: %v", err)
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if err := removeAccountAsset(root, "/api/uploads/link.bin"); err == nil {
		t.Fatal("symlink accepted")
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("outside file touched", err)
	}
}
