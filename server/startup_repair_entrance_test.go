package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestRepairOrphanedEntranceSounds_RemovesRowsAndFiles — a clip whose user
// is gone (planted with foreign_keys OFF, the Turso condition) is removed on
// boot together with its file and the selections pointing at it. A row whose
// file_url does not match the generated shape is removed but its file is
// left alone; a live user's clip and file are kept.
func TestRepairOrphanedEntranceSounds_RemovesRowsAndFiles(t *testing.T) {
	db, path := newCensusDB(t)
	uploadDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(uploadDir, "entrance"), 0o750); err != nil {
		t.Fatal(err)
	}
	ghostFile := filepath.Join(uploadDir, "entrance", "aaaaaaaaaaaaaaaa.wav")
	liveFile := filepath.Join(uploadDir, "entrance", "bbbbbbbbbbbbbbbb.wav")
	oddFile := filepath.Join(uploadDir, "avatar.png") // reachable only via an off-pattern URL
	for _, f := range []string{ghostFile, liveFile, oddFile} {
		if err := os.WriteFile(f, []byte("RIFF"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	seedOrphans(t, path,
		`INSERT INTO users (id, username, password_hash) VALUES ('live-user', 'live', 'x')`,
		`INSERT INTO user_entrance_sounds (id, user_id, name, file_url, duration_ms, size)
			VALUES ('aaaaaaaaaaaaaaaa', 'ghost-user', 'g', '/api/uploads/entrance/aaaaaaaaaaaaaaaa.wav', 1000, 4)`,
		`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, sound_id)
			VALUES ('ghost-user', '', 'clip', 'aaaaaaaaaaaaaaaa')`,
		`INSERT INTO user_entrance_sounds (id, user_id, name, file_url, duration_ms, size)
			VALUES ('cccccccccccccccc', 'ghost-user', 'odd', '/api/uploads/entrance/../avatar.png', 1000, 4)`,
		`INSERT INTO user_entrance_sounds (id, user_id, name, file_url, duration_ms, size)
			VALUES ('bbbbbbbbbbbbbbbb', 'live-user', 'l', '/api/uploads/entrance/bbbbbbbbbbbbbbbb.wav', 1000, 4)`,
	)

	repairOrphanedEntranceSounds(db, uploadDir)

	q := func(query string) int {
		t.Helper()
		var n int
		if err := db.Conn.QueryRow(query).Scan(&n); err != nil {
			t.Fatalf("count %q: %v", query, err)
		}
		return n
	}
	if n := q(`SELECT COUNT(*) FROM user_entrance_sounds WHERE user_id = 'ghost-user'`); n != 0 {
		t.Errorf("%d orphaned clip rows survived the repair, want 0", n)
	}
	if n := q(`SELECT COUNT(*) FROM user_entrance_selection WHERE user_id = 'ghost-user'`); n != 0 {
		t.Errorf("%d selections of the orphaned clip survived, want 0", n)
	}
	if n := q(`SELECT COUNT(*) FROM user_entrance_sounds WHERE user_id = 'live-user'`); n != 1 {
		t.Errorf("live user's clip rows = %d, want 1", n)
	}
	if _, err := os.Stat(ghostFile); !os.IsNotExist(err) {
		t.Errorf("orphaned entrance file still on disk (stat err = %v)", err)
	}
	if _, err := os.Stat(oddFile); err != nil {
		t.Errorf("file behind an off-pattern URL was touched: %v", err)
	}
	if _, err := os.Stat(liveFile); err != nil {
		t.Errorf("live entrance file was removed: %v", err)
	}
}

// TestRepairOrphanedEntranceSounds_NoUploadDirKeepsFiles — without an upload
// dir nothing is deleted: the file stays and so does the row pointing at it.
func TestRepairOrphanedEntranceSounds_NoUploadDirKeepsFiles(t *testing.T) {
	db, path := newCensusDB(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "entrance", "aaaaaaaaaaaaaaaa.wav")
	if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("RIFF"), 0o600); err != nil {
		t.Fatal(err)
	}
	seedOrphans(t, path,
		`INSERT INTO user_entrance_sounds (id, user_id, name, file_url, duration_ms, size)
			VALUES ('aaaaaaaaaaaaaaaa', 'ghost-user', 'g', '/api/uploads/entrance/aaaaaaaaaaaaaaaa.wav', 1000, 4)`,
	)

	repairOrphanedEntranceSounds(db, "")

	var n int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM user_entrance_sounds`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 1 {
		t.Errorf("rows = %d, want 1 (no upload dir ⇒ keep the pointer)", n)
	}
	if _, err := os.Stat(file); err != nil {
		t.Errorf("file removed without an upload dir: %v", err)
	}
}

// TestRepairOrphanedServerData_PurgesEntranceRows — the generic row repair
// removes server/user/channel/clip-orphaned entrance rows and keeps live ones.
func TestRepairOrphanedServerData_PurgesEntranceRows(t *testing.T) {
	db, path := newCensusDB(t)
	seedOrphans(t, path,
		`INSERT INTO users (id, username, password_hash) VALUES ('live-user', 'live', 'x')`,
		`INSERT INTO servers (id, name, owner_id) VALUES ('live-server', 'Live', 'live-user')`,
		`INSERT INTO channels (id, name, type, server_id) VALUES ('live-voice', 'ses', 'voice', 'live-server')`,
		// selections: ghost server scope, ghost user, dangling clip, and one live
		`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, preset)
			VALUES ('live-user', 'ghost-server', 'preset', '{}')`,
		`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, preset)
			VALUES ('ghost-user', '', 'preset', '{}')`,
		`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, sound_id)
			VALUES ('live-user', 'live-server', 'clip', 'ffffffffffffffff')`,
		`INSERT INTO user_entrance_selection (user_id, scope_server_id, kind, preset)
			VALUES ('live-user', '', 'preset', '{}')`,
		`INSERT INTO server_entrance_settings (server_id) VALUES ('ghost-server')`,
		`INSERT INTO server_entrance_settings (server_id) VALUES ('live-server')`,
		`INSERT INTO channel_entrance_disabled (channel_id, server_id) VALUES ('ghost-channel', 'live-server')`,
		`INSERT INTO channel_entrance_disabled (channel_id, server_id) VALUES ('live-voice', 'live-server')`,
		`INSERT INTO server_entrance_mutes (server_id, user_id) VALUES ('ghost-server', 'live-user')`,
		`INSERT INTO server_entrance_mutes (server_id, user_id) VALUES ('live-server', 'ghost-user')`,
		`INSERT INTO server_entrance_mutes (server_id, user_id) VALUES ('live-server', 'live-user')`,
	)

	repairOrphanedServerData(db)

	for query, want := range map[string]int{
		`SELECT COUNT(*) FROM user_entrance_selection`:   1,
		`SELECT COUNT(*) FROM server_entrance_settings`:  1,
		`SELECT COUNT(*) FROM channel_entrance_disabled`: 1,
		`SELECT COUNT(*) FROM server_entrance_mutes`:     1,
	} {
		var n int
		if err := db.Conn.QueryRow(query).Scan(&n); err != nil {
			t.Fatalf("count %q: %v", query, err)
		}
		if n != want {
			t.Errorf("%q = %d, want %d", query, n, want)
		}
	}
}
