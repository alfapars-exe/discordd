package services

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/config"
)

func TestBackupEmptyOrPartialMountNeverDeletesRemoteFiles(t *testing.T) {
	for _, partial := range []bool{false, true} {
		dir := t.TempDir()
		if partial {
			if err := os.WriteFile(filepath.Join(dir, "one-file"), []byte("partial mount"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		svc, fake := newTestBackupService(t, config.BackupConfig{HFBucket: "test/backup"})
		if err := svc.hfSyncDir(dir, "uploads"); err != nil {
			t.Fatal(err)
		}
		if len(fake.calls) != 1 {
			t.Fatalf("expected one sync, got %d", len(fake.calls))
		}
		for _, arg := range fake.calls[0].args {
			if arg == "--delete" {
				t.Fatal("backup may not delete remote recovery objects")
			}
		}
	}
}
