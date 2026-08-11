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

// TestBootstrapPlatformAdmin_PromotesWhenNoAdminExists proves the operator
// workflow this bootstrap exists for still works: a fresh install with
// PLATFORM_ADMIN_USERNAME set and the user already registered gets promoted
// on the next boot (the H-07 fix must not break the intended path).
func TestBootstrapPlatformAdmin_PromotesWhenNoAdminExists(t *testing.T) {
	db, _ := newCensusDB(t)
	if _, err := db.Conn.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password_hash) VALUES ('u-alice', 'alice', 'x')`); err != nil {
		t.Fatalf("seed alice: %v", err)
	}

	bootstrapPlatformAdmin(db, "alice")

	var isAdmin int
	if err := db.Conn.QueryRowContext(context.Background(),
		`SELECT is_platform_admin FROM users WHERE username = 'alice'`).Scan(&isAdmin); err != nil {
		t.Fatalf("query alice: %v", err)
	}
	if isAdmin != 1 {
		t.Errorf("alice.is_platform_admin = %d, want 1 (bootstrap must still promote when there is no existing admin)", isAdmin)
	}
}

// TestBootstrapPlatformAdmin_DoesNotPromoteWhenAdminAlreadyExists is the H-07
// regression test: once any admin exists on the platform, the configured
// username must never be promoted again — this closes the "first person to
// claim the configured username becomes admin" land-grab. If the
// `AND NOT EXISTS (SELECT 1 FROM users WHERE is_platform_admin = 1)` guard is
// removed from the UPDATE in bootstrapPlatformAdmin, this test goes red.
func TestBootstrapPlatformAdmin_DoesNotPromoteWhenAdminAlreadyExists(t *testing.T) {
	db, _ := newCensusDB(t)
	ctx := context.Background()
	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash, is_platform_admin) VALUES ('u-root', 'root-admin', 'x', 1)`); err != nil {
		t.Fatalf("seed existing admin: %v", err)
	}
	if _, err := db.Conn.ExecContext(ctx,
		`INSERT INTO users (id, username, password_hash) VALUES ('u-alice', 'alice', 'x')`); err != nil {
		t.Fatalf("seed alice: %v", err)
	}

	bootstrapPlatformAdmin(db, "alice")

	var isAdmin int
	if err := db.Conn.QueryRowContext(ctx,
		`SELECT is_platform_admin FROM users WHERE username = 'alice'`).Scan(&isAdmin); err != nil {
		t.Fatalf("query alice: %v", err)
	}
	if isAdmin != 0 {
		t.Errorf("alice.is_platform_admin = %d, want 0 (an admin already exists; bootstrap must not grant a second one via username land-grab)", isAdmin)
	}
}

// TestBootstrapPlatformAdmin_UnknownUsernameIsNoop proves the configured
// username not existing yet (e.g. before the operator has registered) is
// handled without error or panic — the pre-existing "ignores users who don't
// exist yet" contract survives the H-07 predicate changes.
func TestBootstrapPlatformAdmin_UnknownUsernameIsNoop(t *testing.T) {
	db, _ := newCensusDB(t)

	bootstrapPlatformAdmin(db, "ghost-user-does-not-exist")

	var count int
	if err := db.Conn.QueryRowContext(context.Background(),
		`SELECT COUNT(*) FROM users WHERE is_platform_admin = 1`).Scan(&count); err != nil {
		t.Fatalf("count admins: %v", err)
	}
	if count != 0 {
		t.Errorf("admin count = %d, want 0 (unknown username must not create or promote any row)", count)
	}
}

// TestBootstrapPlatformAdmin_EmptyUsernameIsNoop proves the `username == ""`
// early return still short-circuits before the UPDATE runs at all. This is
// checked by seeding a real user row with an empty username: because no
// admin exists yet, the UPDATE predicate alone (is_platform_admin=0,
// is_bot=0, NOT EXISTS admin) would otherwise match and wrongly promote that
// row — only the early return keeps it untouched.
func TestBootstrapPlatformAdmin_EmptyUsernameIsNoop(t *testing.T) {
	db, _ := newCensusDB(t)
	if _, err := db.Conn.ExecContext(context.Background(),
		`INSERT INTO users (id, username, password_hash) VALUES ('u-empty', '', 'x')`); err != nil {
		t.Fatalf("seed empty-username user: %v", err)
	}

	bootstrapPlatformAdmin(db, "")

	var isAdmin int
	if err := db.Conn.QueryRowContext(context.Background(),
		`SELECT is_platform_admin FROM users WHERE id = 'u-empty'`).Scan(&isAdmin); err != nil {
		t.Fatalf("query: %v", err)
	}
	if isAdmin != 0 {
		t.Errorf(`empty-username row was promoted (is_platform_admin=%d); the username=="" early return must run before any query`, isAdmin)
	}
}
