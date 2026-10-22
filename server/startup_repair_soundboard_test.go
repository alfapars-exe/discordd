package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRepairOrphanedSoundboard_RemovesRowsAndFiles — a clip whose server is
// gone (planted with foreign_keys OFF, the Turso condition) is removed on
// boot together with its file, because soundboard files are public by URL
// prefix and the row is the only pointer to them. A live server's clip and
// file are kept.
func TestRepairOrphanedSoundboard_RemovesRowsAndFiles(t *testing.T) {
	db, path := newCensusDB(t)
	uploadDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(uploadDir, "soundboard"), 0o750); err != nil {
		t.Fatal(err)
	}
	ghostFile := filepath.Join(uploadDir, "soundboard", "g_ding.ogg")
	liveFile := filepath.Join(uploadDir, "soundboard", "l_ding.ogg")
	for _, f := range []string{ghostFile, liveFile} {
		if err := os.WriteFile(f, []byte("OggS"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	seedOrphans(t, path,
		`INSERT INTO servers (id, name, owner_id) VALUES ('live-server', 'Live', 'live-owner')`,
		`INSERT INTO soundboard_sounds (id, server_id, name, file_url, file_size, duration_ms, uploaded_by)
			VALUES ('sound-ghost', 'ghost-server', 'ding', '/api/uploads/soundboard/g_ding.ogg', 1, 1, 'someone')`,
		`INSERT INTO soundboard_sounds (id, server_id, name, file_url, file_size, duration_ms, uploaded_by)
			VALUES ('sound-live', 'live-server', 'ding', '/api/uploads/soundboard/l_ding.ogg', 1, 1, 'someone')`,
	)

	repairOrphanedSoundboard(db, uploadDir)

	var n int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = 'ghost-server'`).Scan(&n); err != nil {
		t.Fatalf("count orphans: %v", err)
	}
	if n != 0 {
		t.Errorf("%d orphaned soundboard_sounds rows survived the repair, want 0", n)
	}
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = 'live-server'`).Scan(&n); err != nil {
		t.Fatalf("count live: %v", err)
	}
	if n != 1 {
		t.Errorf("live server's soundboard rows = %d, want 1", n)
	}
	if _, err := os.Stat(ghostFile); !os.IsNotExist(err) {
		t.Errorf("orphaned soundboard file still on disk (stat err = %v)", err)
	}
	if _, err := os.Stat(liveFile); err != nil {
		t.Errorf("live soundboard file was removed: %v", err)
	}
}

// TestRepairOrphanedSoundboard_NoUploadDirKeepsPointers — without an upload
// dir the files cannot be removed, so the rows must stay as their pointers.
func TestRepairOrphanedSoundboard_NoUploadDirKeepsPointers(t *testing.T) {
	db, path := newCensusDB(t)
	seedOrphans(t, path,
		`INSERT INTO soundboard_sounds (id, server_id, name, file_url, file_size, duration_ms, uploaded_by)
			VALUES ('sound-ghost', 'ghost-server', 'ding', '/api/uploads/soundboard/g_ding.ogg', 1, 1, 'someone')`,
	)

	repairOrphanedSoundboard(db, "")

	var n int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = 'ghost-server'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("rows = %d, want 1 (no upload dir ⇒ keep the pointer)", n)
	}
}

// TestRepairOrphanedServerData_LeavesSoundboardToItsFileAwareRepair — the
// generic row-only repair must not touch soundboard rows.
func TestRepairOrphanedServerData_LeavesSoundboardToItsFileAwareRepair(t *testing.T) {
	db, path := newCensusDB(t)
	seedOrphans(t, path,
		`INSERT INTO soundboard_sounds (id, server_id, name, file_url, file_size, duration_ms, uploaded_by)
			VALUES ('sound-ghost', 'ghost-server', 'ding', '/api/uploads/soundboard/g_ding.ogg', 1, 1, 'someone')`,
	)

	repairOrphanedServerData(db)

	var n int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = 'ghost-server'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("rows = %d, want 1 (generic repair must not delete soundboard rows)", n)
	}
}
