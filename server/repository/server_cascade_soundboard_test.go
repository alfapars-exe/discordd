package repository

import (
	"context"
	"database/sql"
	"slices"
	"testing"

	"github.com/argeinfina/hichat/database"
)

func seedSoundboardSound(t *testing.T, db *database.DB, id, serverID, fileURL string) {
	t.Helper()
	if _, err := db.Conn.Exec(
		`INSERT INTO soundboard_sounds (id, server_id, name, file_url, file_size, duration_ms, uploaded_by)
		 VALUES (?, ?, 'ding', ?, 1024, 500, ?)`,
		id, serverID, fileURL, dmAlice,
	); err != nil {
		t.Fatalf("seed soundboard sound %s: %v", id, err)
	}
}

// TestDeleteServerCascade_RemovesSoundboardSounds runs the cascade over a
// connection with foreign_keys OFF — the Turso condition — so the clips can
// only disappear through the explicit soundboard_sounds statement. The
// sibling server's clip must survive.
func TestDeleteServerCascade_RemovesSoundboardSounds(t *testing.T) {
	db, path := newTestDBWithPath(t)
	seedEmojiWorld(t, db)
	seedSoundboardSound(t, db, "sound-a", emojiSrvA, "/api/uploads/soundboard/aaaa_ding.ogg")
	seedSoundboardSound(t, db, "sound-b", emojiSrvB, "/api/uploads/soundboard/bbbb_ding.ogg")

	fkOff, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(0)&_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatalf("open fk-off conn: %v", err)
	}
	defer func() { _ = fkOff.Close() }()

	if err := deleteServerCascade(context.Background(), fkOff, emojiSrvA); err != nil {
		t.Fatalf("deleteServerCascade: %v", err)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = ?`, emojiSrvA); n != 0 {
		t.Errorf("%d soundboard_sounds rows survived the cascade, want 0", n)
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM soundboard_sounds WHERE server_id = ?`, emojiSrvB); n != 1 {
		t.Errorf("sibling server's soundboard rows = %d, want 1", n)
	}
}

// TestGetOwnedServerFileURLs_CollectsEveryOwnedServer — the user hard-delete
// path collects the files of every server the user owns (alice owns A and B)
// and none of servers owned by others (carol owns C).
func TestGetOwnedServerFileURLs_CollectsEveryOwnedServer(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	seedSoundboardSound(t, db, "sound-a", emojiSrvA, "/api/uploads/soundboard/aaaa_ding.ogg")
	seedSoundboardSound(t, db, "sound-b", emojiSrvB, "/api/uploads/soundboard/bbbb_ding.ogg")
	seedSoundboardSound(t, db, "sound-c", emojiSrvC, "/api/uploads/soundboard/cccc_ding.ogg")

	urls, err := NewSQLiteUserRepo(wrapForRepo(db)).GetOwnedServerFileURLs(context.Background(), dmAlice)
	if err != nil {
		t.Fatalf("GetOwnedServerFileURLs: %v", err)
	}
	slices.Sort(urls)
	want := []string{"/api/uploads/soundboard/aaaa_ding.ogg", "/api/uploads/soundboard/bbbb_ding.ogg"}
	if !slices.Equal(urls, want) {
		t.Errorf("urls = %v, want %v", urls, want)
	}
}

// TestGetFileURLsByServerID_IncludesSoundboardFiles — the delete path
// collects the server's soundboard clips (public by URL prefix, so a file
// left on disk would stay reachable) and only that server's.
func TestGetFileURLsByServerID_IncludesSoundboardFiles(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	seedSoundboardSound(t, db, "sound-a", emojiSrvA, "/api/uploads/soundboard/aaaa_ding.ogg")
	seedSoundboardSound(t, db, "sound-b", emojiSrvB, "/api/uploads/soundboard/bbbb_ding.ogg")

	urls, err := NewSQLiteServerRepo(wrapForRepo(db)).GetFileURLsByServerID(context.Background(), emojiSrvA)
	if err != nil {
		t.Fatalf("GetFileURLsByServerID: %v", err)
	}
	if !slices.Contains(urls, "/api/uploads/soundboard/aaaa_ding.ogg") {
		t.Errorf("urls = %v, want the server's soundboard clip", urls)
	}
	if slices.Contains(urls, "/api/uploads/soundboard/bbbb_ding.ogg") {
		t.Errorf("urls = %v, must not include another server's clip", urls)
	}
}
