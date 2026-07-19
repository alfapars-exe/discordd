package main

import (
	"context"
	"testing"
)

// TestRepairOrphanedServerData_PurgesEveryOrphanedTable seeds one orphan row
// per table the census in maintenance.go tracks (same seeding shape as
// TestCensusOrphans_DetectsSeededOrphans) and asserts repairOrphanedServerData
// removes all of them in one pass — this is the one-time backfill for damage
// that predates the transactional cascade delete fix (see
// repository.deleteServerCascade).
func TestRepairOrphanedServerData_PurgesEveryOrphanedTable(t *testing.T) {
	db, path := newCensusDB(t)

	seedOrphans(t, path,
		`INSERT INTO user_roles (user_id, role_id, server_id)
			VALUES ('ghost-user', 'ghost-role', 'ghost-server')`,
		`INSERT INTO channels (id, name, type, server_id)
			VALUES ('orphan-channel', 'genel', 'text', 'ghost-server')`,
		`INSERT INTO invites (code, server_id)
			VALUES ('orphan-invite', 'ghost-server')`,
		`INSERT INTO categories (id, name, server_id)
			VALUES ('orphan-category', 'Metin', 'ghost-server')`,
		`INSERT INTO roles (id, name, server_id)
			VALUES ('orphan-role', 'ghost-role-name', 'ghost-server')`,
		`INSERT INTO bans (server_id, user_id)
			VALUES ('ghost-server', 'ghost-banned-user')`,
		// message + its own attachment/reaction/pin/read/permission, all
		// hanging off the same orphaned channel — proves the deep cascade,
		// not just the six FK-less tables directly on servers.
		`INSERT INTO messages (id, channel_id, user_id, content)
			VALUES ('orphan-message', 'orphan-channel', 'ghost-user-2', 'hello from nowhere')`,
		`INSERT INTO attachments (id, message_id, filename, file_url)
			VALUES ('orphan-attachment', 'orphan-message', 'a.png', '/api/uploads/deadbeef_a.png')`,
		`INSERT INTO reactions (message_id, user_id, emoji)
			VALUES ('orphan-message', 'ghost-user-2', 'thumbsup')`,
		`INSERT INTO pinned_messages (channel_id, message_id, pinned_by)
			VALUES ('orphan-channel', 'orphan-message', 'ghost-user-2')`,
		`INSERT INTO channel_reads (user_id, channel_id)
			VALUES ('ghost-user-2', 'orphan-channel')`,
		`INSERT INTO channel_permissions (channel_id, role_id, allow, deny)
			VALUES ('orphan-channel', 'orphan-role', 0, 0)`,
	)

	repairOrphanedServerData(db)

	tables := []struct {
		name  string
		query string
	}{
		{"user_roles", `SELECT COUNT(*) FROM user_roles WHERE server_id = 'ghost-server'`},
		{"channels", `SELECT COUNT(*) FROM channels WHERE server_id = 'ghost-server'`},
		{"invites", `SELECT COUNT(*) FROM invites WHERE server_id = 'ghost-server'`},
		{"categories", `SELECT COUNT(*) FROM categories WHERE server_id = 'ghost-server'`},
		{"roles", `SELECT COUNT(*) FROM roles WHERE server_id = 'ghost-server'`},
		{"bans", `SELECT COUNT(*) FROM bans WHERE server_id = 'ghost-server'`},
		{"messages", `SELECT COUNT(*) FROM messages WHERE id = 'orphan-message'`},
		{"attachments", `SELECT COUNT(*) FROM attachments WHERE id = 'orphan-attachment'`},
		{"reactions", `SELECT COUNT(*) FROM reactions WHERE message_id = 'orphan-message'`},
		{"pinned_messages", `SELECT COUNT(*) FROM pinned_messages WHERE message_id = 'orphan-message'`},
		{"channel_reads", `SELECT COUNT(*) FROM channel_reads WHERE channel_id = 'orphan-channel'`},
		{"channel_permissions", `SELECT COUNT(*) FROM channel_permissions WHERE channel_id = 'orphan-channel'`},
	}
	for _, tc := range tables {
		var n int
		if err := db.Conn.QueryRowContext(context.Background(), tc.query).Scan(&n); err != nil {
			t.Fatalf("count %s: %v", tc.name, err)
		}
		if n != 0 {
			t.Errorf("%s: %d orphaned row(s) survived repairOrphanedServerData, want 0", tc.name, n)
		}
	}
}

// TestRepairOrphanedServerData_IsIdempotent proves a second run on an
// already-clean database is a silent no-op — this runs on every boot, so it
// must not error or misbehave once there's nothing left to repair.
func TestRepairOrphanedServerData_IsIdempotent(t *testing.T) {
	db, path := newCensusDB(t)
	seedOrphans(t, path,
		`INSERT INTO channels (id, name, type, server_id)
			VALUES ('orphan-channel', 'genel', 'text', 'ghost-server')`,
	)

	repairOrphanedServerData(db) // first pass: cleans it up
	repairOrphanedServerData(db) // second pass: nothing left, must not error

	var n int
	if err := db.Conn.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM channels WHERE server_id = 'ghost-server'`).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != 0 {
		t.Errorf("channels: %d rows, want 0", n)
	}
}

// TestRepairOrphanedServerData_DoesNotTouchHealthyData proves the repair
// only removes rows whose server is actually gone — a real server with real
// children must survive untouched.
func TestRepairOrphanedServerData_DoesNotTouchHealthyData(t *testing.T) {
	db, path := newCensusDB(t)
	seedOrphans(t, path,
		`INSERT INTO servers (id, name, owner_id) VALUES ('real-server', 'Real', 'real-owner')`,
		`INSERT INTO channels (id, name, type, server_id) VALUES ('real-channel', 'genel', 'text', 'real-server')`,
		`INSERT INTO roles (id, name, server_id) VALUES ('real-role', 'mod', 'real-server')`,
	)

	repairOrphanedServerData(db)

	var n int
	if err := db.Conn.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM channels WHERE id = 'real-channel'`).Scan(&n); err != nil {
		t.Fatalf("count channels: %v", err)
	}
	if n != 1 {
		t.Errorf("real channel was removed by repairOrphanedServerData (got %d, want 1)", n)
	}
	if err := db.Conn.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM roles WHERE id = 'real-role'`).Scan(&n); err != nil {
		t.Fatalf("count roles: %v", err)
	}
	if n != 1 {
		t.Errorf("real role was removed by repairOrphanedServerData (got %d, want 1)", n)
	}
}
