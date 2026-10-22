package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/argeinfina/hichat/database"
)

func countCosmetics(t *testing.T, db *database.DB, query string) int {
	t.Helper()
	var n int
	if err := db.Conn.QueryRow(query).Scan(&n); err != nil {
		t.Fatalf("count %q: %v", query, err)
	}
	return n
}

func writeCosmeticFiles(t *testing.T, files ...string) {
	t.Helper()
	for _, f := range files {
		if err := os.MkdirAll(filepath.Dir(f), 0o750); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f, []byte("PNG"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// TestRepairOrphanedCosmetics_RemovesRowsAndFiles - server items whose
// server is gone (planted with foreign_keys OFF, the Turso condition) are
// removed on boot with their files and the slots/grants pointing at them.
// An off-pattern URL loses its row but its file is left alone; a live
// server's item, its file and the built-in catalog are kept. Slots, grants
// and plain switches of a gone user, item or scope server are purged.
func TestRepairOrphanedCosmetics_RemovesRowsAndFiles(t *testing.T) {
	db, path := newCensusDB(t)
	uploadDir := t.TempDir()
	ghostPNG := filepath.Join(uploadDir, "cosmetics", "aaaaaaaaaaaaaaaa.png")
	ghostGIF := filepath.Join(uploadDir, "cosmetics", "aaaaaaaaaaaaaaaa.gif")
	livePNG := filepath.Join(uploadDir, "cosmetics", "bbbbbbbbbbbbbbbb.png")
	oddFile := filepath.Join(uploadDir, "avatar.png") // reachable only via an off-pattern URL
	writeCosmeticFiles(t, ghostPNG, ghostGIF, livePNG, oddFile)

	seedOrphans(t, path,
		`INSERT INTO users (id, username, password_hash) VALUES ('live-user', 'live', 'x')`,
		`INSERT INTO servers (id, name, owner_id) VALUES ('live-server', 'Live', 'live-user')`,
		// orphaned raster frame with both files + a slot and a grant on it
		`INSERT INTO cosmetic_items (id, server_id, type, format, name, file_url, animated_url, animated, availability)
			VALUES ('aaaaaaaaaaaaaaaa', 'ghost-server', 'avatar_frame', 'raster', 'g',
				'/api/uploads/cosmetics/aaaaaaaaaaaaaaaa.png', '/api/uploads/cosmetics/aaaaaaaaaaaaaaaa.gif', 1, 'granted')`,
		`INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
			VALUES ('live-user', 'live-server', 'avatar_frame', 'aaaaaaaaaaaaaaaa', 'raster', '{}')`,
		`INSERT INTO user_cosmetics (user_id, item_id, server_id, reason)
			VALUES ('live-user', 'aaaaaaaaaaaaaaaa', 'live-server', 'r')`,
		// orphaned item with an off-pattern URL
		`INSERT INTO cosmetic_items (id, server_id, type, format, name, file_url)
			VALUES ('cccccccccccccccc', 'ghost-server', 'avatar_frame', 'raster', 'odd', '/api/uploads/cosmetics/../avatar.png')`,
		// orphaned token item (no file)
		`INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json)
			VALUES ('dddddddddddddddd', 'ghost-server', 'nameplate', 'css', 'plate', '{}')`,
		// live server's item
		`INSERT INTO cosmetic_items (id, server_id, type, format, name, file_url)
			VALUES ('bbbbbbbbbbbbbbbb', 'live-server', 'avatar_frame', 'raster', 'l', '/api/uploads/cosmetics/bbbbbbbbbbbbbbbb.png')`,
		// dependent orphans: gone user, gone item, gone scope server; one live slot
		`INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
			VALUES ('ghost-user', '', 'avatar_frame', 'b_frame_aurora', 'svg', '{}')`,
		`INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
			VALUES ('live-user', '', 'nameplate', 'ffffffffffffffff', 'css', '{}')`,
		`INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
			VALUES ('live-user', 'ghost-server', 'avatar_frame', 'b_frame_aurora', 'svg', '{}')`,
		`INSERT INTO user_equipped (user_id, scope_server_id, type, item_id, format, asset_snapshot)
			VALUES ('live-user', '', 'avatar_frame', 'b_frame_aurora', 'svg', '{}')`,
		`INSERT INTO user_cosmetics (user_id, item_id, server_id, reason)
			VALUES ('ghost-user', 'bbbbbbbbbbbbbbbb', 'live-server', 'r')`,
		`INSERT INTO user_cosmetics (user_id, item_id, server_id, reason)
			VALUES ('live-user', 'bbbbbbbbbbbbbbbb', 'live-server', 'r')`,
		`INSERT INTO user_cosmetic_plain_servers (user_id, server_id) VALUES ('ghost-user', 'live-server')`,
		`INSERT INTO user_cosmetic_plain_servers (user_id, server_id) VALUES ('live-user', 'ghost-server')`,
		`INSERT INTO user_cosmetic_plain_servers (user_id, server_id) VALUES ('live-user', 'live-server')`,
	)

	repairOrphanedCosmetics(db, uploadDir)

	for q, want := range map[string]int{
		`SELECT COUNT(*) FROM cosmetic_items WHERE server_id = 'ghost-server'`:                                                   0,
		`SELECT COUNT(*) FROM cosmetic_items WHERE server_id = 'live-server'`:                                                    1,
		`SELECT COUNT(*) FROM cosmetic_items WHERE server_id IS NULL`:                                                            30,
		`SELECT COUNT(*) FROM user_equipped`:                                                                                     1,
		`SELECT COUNT(*) FROM user_equipped WHERE user_id = 'live-user' AND scope_server_id = '' AND item_id = 'b_frame_aurora'`: 1,
		`SELECT COUNT(*) FROM user_cosmetics`:                                                                                    1,
		`SELECT COUNT(*) FROM user_cosmetics WHERE user_id = 'live-user' AND item_id = 'bbbbbbbbbbbbbbbb'`:                       1,
		`SELECT COUNT(*) FROM user_cosmetic_plain_servers`:                                                                       1,
		`SELECT COUNT(*) FROM user_cosmetic_plain_servers WHERE user_id = 'live-user' AND server_id = 'live-server'`:             1,
	} {
		if n := countCosmetics(t, db, q); n != want {
			t.Errorf("%s = %d after repair, want %d", q, n, want)
		}
	}
	for _, gone := range []string{ghostPNG, ghostGIF} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("orphaned cosmetic file %s still on disk (stat err = %v)", gone, err)
		}
	}
	if _, err := os.Stat(oddFile); err != nil {
		t.Errorf("file behind an off-pattern URL was touched: %v", err)
	}
	if _, err := os.Stat(livePNG); err != nil {
		t.Errorf("live cosmetic file was removed: %v", err)
	}
}

// TestRepairOrphanedCosmetics_NoUploadDirKeepsFiles - without an upload dir
// no file is deleted, and an orphaned item that has a file keeps its row
// (the pointer stays until a run that can remove the file). A file-less
// orphaned item is still removed.
func TestRepairOrphanedCosmetics_NoUploadDirKeepsFiles(t *testing.T) {
	db, path := newCensusDB(t)
	dir := t.TempDir()
	file := filepath.Join(dir, "cosmetics", "aaaaaaaaaaaaaaaa.png")
	writeCosmeticFiles(t, file)
	seedOrphans(t, path,
		`INSERT INTO cosmetic_items (id, server_id, type, format, name, file_url)
			VALUES ('aaaaaaaaaaaaaaaa', 'ghost-server', 'avatar_frame', 'raster', 'g', '/api/uploads/cosmetics/aaaaaaaaaaaaaaaa.png')`,
		`INSERT INTO cosmetic_items (id, server_id, type, format, name, asset_json)
			VALUES ('dddddddddddddddd', 'ghost-server', 'nameplate', 'css', 'plate', '{}')`,
	)

	repairOrphanedCosmetics(db, "")

	if n := countCosmetics(t, db, `SELECT COUNT(*) FROM cosmetic_items WHERE id = 'aaaaaaaaaaaaaaaa'`); n != 1 {
		t.Errorf("orphaned raster item rows = %d, want 1 (no upload dir: keep the pointer)", n)
	}
	if n := countCosmetics(t, db, `SELECT COUNT(*) FROM cosmetic_items WHERE id = 'dddddddddddddddd'`); n != 0 {
		t.Errorf("orphaned token item rows = %d, want 0", n)
	}
	if n := countCosmetics(t, db, `SELECT COUNT(*) FROM cosmetic_items WHERE server_id IS NULL`); n != 30 {
		t.Errorf("built-in items = %d, want 30", n)
	}
	if _, err := os.Stat(file); err != nil {
		t.Errorf("file removed without an upload dir: %v", err)
	}
}
