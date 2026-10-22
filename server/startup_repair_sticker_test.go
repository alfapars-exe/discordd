package main

import "testing"

// TestRepairOrphanedServerData_PurgesOrphanedServerStickers — a sticker row
// whose server is gone (planted with foreign_keys OFF, the Turso condition)
// is removed on boot; a live server's sticker is kept.
func TestRepairOrphanedServerData_PurgesOrphanedServerStickers(t *testing.T) {
	db, path := newCensusDB(t)

	seedOrphans(t, path,
		`INSERT INTO servers (id, name, owner_id) VALUES ('live-server', 'Live', 'live-owner')`,
		`INSERT INTO server_stickers (id, server_id, name, display_name, file_url)
			VALUES ('aaaaaaaaaaaaaaa1', 'ghost-server', 'kedi', 'Kedi', '/api/uploads/stickers/aaaaaaaaaaaaaaa1.png')`,
		`INSERT INTO server_stickers (id, server_id, name, display_name, file_url)
			VALUES ('aaaaaaaaaaaaaaa2', 'live-server', 'kedi', 'Kedi', '/api/uploads/stickers/aaaaaaaaaaaaaaa2.png')`,
	)

	repairOrphanedServerData(db)

	var n int
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM server_stickers WHERE server_id = 'ghost-server'`).Scan(&n); err != nil {
		t.Fatalf("count orphans: %v", err)
	}
	if n != 0 {
		t.Errorf("%d orphaned server_stickers rows survived the repair, want 0", n)
	}
	if err := db.Conn.QueryRow(`SELECT COUNT(*) FROM server_stickers WHERE server_id = 'live-server'`).Scan(&n); err != nil {
		t.Fatalf("count live: %v", err)
	}
	if n != 1 {
		t.Errorf("live server's sticker rows = %d, want 1", n)
	}
}
