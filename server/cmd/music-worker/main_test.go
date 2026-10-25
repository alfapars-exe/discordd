package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestReadWorkerTokenRequiresPrivateFileAndNeverReportsSecret(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "worker.token")
	t.Setenv("HICHAT_MUSIC_WORKER_TOKEN_FILE", path)
	for _, contents := range []string{"", "short-secret", strings.Repeat("s", 32) + "\ninjected-secret", strings.Repeat("s", 4097)} {
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := readWorkerToken()
		if err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid token accepted or leaked")
		}
	}
	secret := strings.Repeat("valid-token-", 6)
	if err := os.WriteFile(path, []byte(secret+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := readWorkerToken()
	if err != nil || got != secret {
		t.Fatal("valid tokenfile rejected")
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := readWorkerToken(); err == nil {
			t.Fatal("public-readable token accepted")
		}
		if err := os.Chmod(path, 0600); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(dir, "linked-token")
		if err := os.Symlink(path, link); err != nil {
			t.Fatal(err)
		}
		t.Setenv("HICHAT_MUSIC_WORKER_TOKEN_FILE", link)
		if _, err := readWorkerToken(); err == nil {
			t.Fatal("symlink token accepted")
		}
	}
}

func TestReadWorkerTokenDoesNotFallBackToEnvironmentSecret(t *testing.T) {
	t.Setenv("HICHAT_MUSIC_WORKER_TOKEN_FILE", "")
	t.Setenv("HICHAT_MUSIC_WORKER_TOKEN", strings.Repeat("environment-secret", 3))
	if _, err := readWorkerToken(); err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatal("ambient secret used or disclosed")
	}
}
