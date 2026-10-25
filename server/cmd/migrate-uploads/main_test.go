package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationPreservesConflictsAndExtraFiles(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	write := func(root, name, data string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(root, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(src, "existing", "source")
	write(src, "missing", "new")
	write(dst, "existing", "different")
	write(dst, "extra", "keep")
	r, err := migrate(src, dst, true)
	if err == nil || len(r.Conflicts) != 1 || r.Copied != 0 {
		t.Fatalf("conflict not blocked: %+v %v", r, err)
	}
	if _, err := os.Stat(filepath.Join(dst, "missing")); !os.IsNotExist(err) {
		t.Fatal("copied despite conflicts")
	}
	write(dst, "existing", "source")
	r, err = migrate(src, dst, true)
	if err != nil || !r.Verified || r.Copied != 1 {
		t.Fatalf("copy failed: %+v %v", r, err)
	}
	if b, err := os.ReadFile(filepath.Join(dst, "extra")); err != nil || string(b) != "keep" {
		t.Fatal("extra file changed")
	}
	if err := copyExclusive(filepath.Join(src, "missing"), filepath.Join(dst, "existing")); err == nil {
		t.Fatal("overwrite allowed")
	}
}

func TestEmptySourceIsNeverSuccess(t *testing.T) {
	if r, err := migrate(t.TempDir(), t.TempDir(), true); err == nil || r.Verified {
		t.Fatal("empty mount accepted")
	}
}
