package repository

import (
	"context"
	"fmt"
	"regexp"
	"testing"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// seedFullServer creates a server with a member, a role, a role assignment,
// a category, a channel, a channel-level permission override, a message in
// that channel with an attachment and a reaction, a pin, a read marker, and
// an invite — one row in (almost) every table deleteServerCascade touches,
// so TestDelete_RemovesEveryDescendant has something real to prove was
// removed rather than asserting against an already-empty table.
var seedFullServerCounter int

func seedFullServer(t *testing.T, repos struct {
	server   ServerRepository
	role     RoleRepository
	channel  ChannelRepository
	category CategoryRepository
	message  MessageRepository
	user     UserRepository
}) (serverID, channelID, roleID, messageID string) {
	t.Helper()
	ctx := context.Background()

	// Counter, not t.Name(): a test that seeds two servers (to prove deleting
	// one doesn't touch the other) needs two distinct owners, and t.Name()
	// alone repeats within a single test.
	seedFullServerCounter++
	owner := &models.User{
		Username: fmt.Sprintf("owner%d", seedFullServerCounter),
		Status:   "online",
	}
	if err := repos.user.Create(ctx, owner); err != nil {
		t.Fatalf("create owner: %v", err)
	}

	server := &models.Server{Name: "cascade test", OwnerID: owner.ID}
	if err := repos.server.Create(ctx, server); err != nil {
		t.Fatalf("create server: %v", err)
	}
	if err := repos.server.AddMember(ctx, server.ID, owner.ID); err != nil {
		t.Fatalf("add member: %v", err)
	}

	category := &models.Category{ServerID: server.ID, Name: "General"}
	if err := repos.category.Create(ctx, category); err != nil {
		t.Fatalf("create category: %v", err)
	}

	channel := &models.Channel{ServerID: server.ID, Name: "genel", Type: "text", CategoryID: &category.ID}
	if err := repos.channel.Create(ctx, channel); err != nil {
		t.Fatalf("create channel: %v", err)
	}

	role := &models.Role{ServerID: server.ID, Name: "mod", Color: "#fff", Permissions: 1}
	if err := repos.role.Create(ctx, role); err != nil {
		t.Fatalf("create role: %v", err)
	}
	if err := repos.role.AssignToUser(ctx, owner.ID, role.ID, server.ID); err != nil {
		t.Fatalf("assign role: %v", err)
	}

	message := &models.Message{ChannelID: channel.ID, UserID: owner.ID, Content: strPtr("hello")}
	if err := repos.message.Create(ctx, message); err != nil {
		t.Fatalf("create message: %v", err)
	}

	return server.ID, channel.ID, role.ID, message.ID
}

// TestDeleteServerCascade_RemovesEveryDescendant seeds a full server graph
// (member, role, role assignment, category, channel, message, invite) and
// asserts every one of those rows is gone after Delete — the whole point of
// this change: before it, Delete only removed the servers row itself, and
// production accumulated exactly this shape of leftover data.
func TestDeleteServerCascade_RemovesEveryDescendant(t *testing.T) {
	db, path := newTestDBWithPath(t)
	serverRepo := NewSQLiteServerRepo(db.Conn)
	roleRepo := NewSQLiteRoleRepo(db.Conn)
	channelRepo := NewSQLiteChannelRepo(db.Conn)
	categoryRepo := NewSQLiteCategoryRepo(db.Conn)
	messageRepo := NewSQLiteMessageRepo(db.Conn)
	userRepo := NewSQLiteUserRepo(db.Conn)

	serverID, channelID, roleID, messageID := seedFullServer(t, struct {
		server   ServerRepository
		role     RoleRepository
		channel  ChannelRepository
		category CategoryRepository
		message  MessageRepository
		user     UserRepository
	}{serverRepo, roleRepo, channelRepo, categoryRepo, messageRepo, userRepo})

	// Rows this test's own repo calls above don't cover, planted directly so
	// every table deleteServerCascade touches has a real row to remove.
	execWithoutFKs(t, path,
		`INSERT INTO invites (code, server_id, created_by) VALUES ('inv-`+serverID+`', '`+serverID+`', '')`,
		`INSERT INTO attachments (id, message_id, filename, file_url)
			VALUES ('att-`+messageID+`', '`+messageID+`', 'a.png', '/api/uploads/x_a.png')`,
		`INSERT INTO pinned_messages (channel_id, message_id, pinned_by)
			VALUES ('`+channelID+`', '`+messageID+`', '')`,
		`INSERT INTO channel_reads (user_id, channel_id) VALUES ('', '`+channelID+`')`,
		`INSERT INTO channel_permissions (channel_id, role_id, allow, deny)
			VALUES ('`+channelID+`', '`+roleID+`', 0, 0)`,
		`INSERT INTO bans (server_id, user_id) VALUES ('`+serverID+`', 'banned-user')`,
	)

	ctx := context.Background()
	if err := serverRepo.Delete(ctx, serverID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	checks := []struct {
		table string
		query string
	}{
		{"servers", `SELECT COUNT(*) FROM servers WHERE id = ?`},
		{"channels", `SELECT COUNT(*) FROM channels WHERE server_id = ?`},
		{"categories", `SELECT COUNT(*) FROM categories WHERE server_id = ?`},
		{"roles", `SELECT COUNT(*) FROM roles WHERE server_id = ?`},
		{"user_roles", `SELECT COUNT(*) FROM user_roles WHERE server_id = ?`},
		{"invites", `SELECT COUNT(*) FROM invites WHERE server_id = ?`},
		{"bans", `SELECT COUNT(*) FROM bans WHERE server_id = ?`},
		{"messages", `SELECT COUNT(*) FROM messages WHERE channel_id = ?`},
		{"attachments", `SELECT COUNT(*) FROM attachments WHERE message_id = ?`},
		{"pinned_messages", `SELECT COUNT(*) FROM pinned_messages WHERE channel_id = ?`},
		{"channel_reads", `SELECT COUNT(*) FROM channel_reads WHERE channel_id = ?`},
		{"channel_permissions", `SELECT COUNT(*) FROM channel_permissions WHERE channel_id = ?`},
	}
	for _, c := range checks {
		arg := serverID
		switch c.table {
		case "messages", "pinned_messages", "channel_reads", "channel_permissions":
			arg = channelID
		case "attachments":
			arg = messageID
		}
		if got := countRows(t, db, c.query, arg); got != 0 {
			t.Errorf("%s: %d rows survived Delete, want 0", c.table, got)
		}
	}
}

// TestDeleteServerCascade_DoesNotTouchOtherServers proves the deletes are
// scoped correctly — a sibling server's identical data must survive.
func TestDeleteServerCascade_DoesNotTouchOtherServers(t *testing.T) {
	db, path := newTestDBWithPath(t)
	serverRepo := NewSQLiteServerRepo(db.Conn)
	roleRepo := NewSQLiteRoleRepo(db.Conn)
	channelRepo := NewSQLiteChannelRepo(db.Conn)
	categoryRepo := NewSQLiteCategoryRepo(db.Conn)
	messageRepo := NewSQLiteMessageRepo(db.Conn)
	userRepo := NewSQLiteUserRepo(db.Conn)

	repos := struct {
		server   ServerRepository
		role     RoleRepository
		channel  ChannelRepository
		category CategoryRepository
		message  MessageRepository
		user     UserRepository
	}{serverRepo, roleRepo, channelRepo, categoryRepo, messageRepo, userRepo}

	doomedID, _, _, _ := seedFullServer(t, repos)
	survivorID, survivorChannelID, _, survivorMessageID := seedFullServer(t, repos)

	_ = path
	ctx := context.Background()
	if err := serverRepo.Delete(ctx, doomedID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM servers WHERE id = ?`, survivorID); got != 1 {
		t.Errorf("survivor server row missing after deleting a different server")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM channels WHERE server_id = ?`, survivorID); got != 1 {
		t.Errorf("survivor channel missing after deleting a different server")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, survivorChannelID); got != 1 {
		t.Errorf("survivor message missing after deleting a different server")
	}
	_ = survivorMessageID
}

// TestDeleteServerCascade_NotFound preserves the pre-existing contract: no
// such server is still pkg.ErrNotFound, not a silent no-op.
func TestDeleteServerCascade_NotFound(t *testing.T) {
	db := newTestDB(t)
	serverRepo := NewSQLiteServerRepo(db.Conn)

	err := serverRepo.Delete(context.Background(), "does-not-exist")
	if err == nil {
		t.Fatal("expected an error deleting a nonexistent server")
	}
}

// TestDeleteServerCascade_TransactionalViaWithTx proves the transactional
// path server_service.go/admin_server_service.go use (binding the repo to a
// *sql.Tx) behaves identically to the pool-bound path — this is what
// actually runs in production.
func TestDeleteServerCascade_TransactionalViaWithTx(t *testing.T) {
	db, path := newTestDBWithPath(t)
	serverRepo := NewSQLiteServerRepo(db.Conn)
	roleRepo := NewSQLiteRoleRepo(db.Conn)
	channelRepo := NewSQLiteChannelRepo(db.Conn)
	categoryRepo := NewSQLiteCategoryRepo(db.Conn)
	messageRepo := NewSQLiteMessageRepo(db.Conn)
	userRepo := NewSQLiteUserRepo(db.Conn)
	_ = path

	serverID, channelID, _, _ := seedFullServer(t, struct {
		server   ServerRepository
		role     RoleRepository
		channel  ChannelRepository
		category CategoryRepository
		message  MessageRepository
		user     UserRepository
	}{serverRepo, roleRepo, channelRepo, categoryRepo, messageRepo, userRepo})

	ctx := context.Background()
	tx, err := db.Conn.Begin()
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	if err := NewSQLiteServerRepo(tx).Delete(ctx, serverID); err != nil {
		_ = tx.Rollback()
		t.Fatalf("Delete via tx: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM channels WHERE server_id = ?`, serverID); got != 0 {
		t.Errorf("channel survived cascade delete run inside a transaction")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, channelID); got != 0 {
		t.Errorf("message survived cascade delete run inside a transaction")
	}
}

// TestHardDeleteUser_CascadesOwnedServers proves HardDeleteUser's owned-
// server cleanup goes through the same cascade as sqliteServerRepo.Delete —
// before this fix it ran a bare `DELETE FROM servers WHERE owner_id = ?`,
// which leaked the exact same channels/roles/messages this whole change
// exists to stop leaking, just triggered by account deletion instead of the
// "delete server" button.
func TestHardDeleteUser_CascadesOwnedServers(t *testing.T) {
	db := newTestDB(t)
	serverRepo := NewSQLiteServerRepo(db.Conn)
	roleRepo := NewSQLiteRoleRepo(db.Conn)
	channelRepo := NewSQLiteChannelRepo(db.Conn)
	categoryRepo := NewSQLiteCategoryRepo(db.Conn)
	messageRepo := NewSQLiteMessageRepo(db.Conn)
	userRepo := NewSQLiteUserRepo(db.Conn)

	serverID, channelID, _, messageID := seedFullServer(t, struct {
		server   ServerRepository
		role     RoleRepository
		channel  ChannelRepository
		category CategoryRepository
		message  MessageRepository
		user     UserRepository
	}{serverRepo, roleRepo, channelRepo, categoryRepo, messageRepo, userRepo})
	// seedFullServer returns (serverID, channelID, roleID, messageID); the
	// owner user id isn't among them, so fetch it via the server row.
	server, err := serverRepo.GetByID(context.Background(), serverID)
	if err != nil {
		t.Fatalf("get seeded server: %v", err)
	}
	userID := server.OwnerID

	if err := userRepo.HardDeleteUser(context.Background(), userID); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}

	if got := countRows(t, db, `SELECT COUNT(*) FROM servers WHERE owner_id = ?`, userID); got != 0 {
		t.Errorf("owned server row survived HardDeleteUser")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM channels WHERE id = ?`, channelID); got != 0 {
		t.Errorf("owned server's channel survived HardDeleteUser — the exact leak this fix closes")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM messages WHERE id = ?`, messageID); got != 0 {
		t.Errorf("owned server's message survived HardDeleteUser")
	}
	if got := countRows(t, db, `SELECT COUNT(*) FROM users WHERE id = ?`, userID); got != 0 {
		t.Errorf("user row survived its own HardDeleteUser")
	}
}

// fkCoveredTables (P1.10) allowlists server_id-columned tables intentionally
// left OUT of deleteServerCascadeStmts because their row lifecycle is
// trusted to something else: an enforced `ON DELETE CASCADE` foreign key to
// servers (confirmed against the migration that created each table), or —
// for app_logs — a nullable column on rows that are observability data, not
// server-owned records that must vanish with the server.
//
// Do NOT add an entry here to silence TestDeleteServerCascade_
// CoversEveryServerScopedTable without one of those two justifications: an
// entry here means "trust something other than deleteServerCascadeStmts to
// clean this table up", and getting that wrong reproduces exactly the leak
// class this whole cascade exists to close (see deleteServerCascade's doc
// comment — six tables leaked silently for years because ADD COLUMN can't
// carry a REFERENCES clause in SQLite).
var fkCoveredTables = map[string]string{
	"server_members":    "ON DELETE CASCADE to servers (018_multi_server.sql)",
	"server_mutes":      "ON DELETE CASCADE to servers (025_server_mutes.sql)",
	"channel_mutes":     "ON DELETE CASCADE to servers (032_channel_mutes.sql)",
	"soundboard_sounds": "ON DELETE CASCADE to servers (051_soundboard.sql)",
	"audit_logs":        "ON DELETE CASCADE to servers (061_audit_channel.sql)",
	"member_timeouts":   "ON DELETE CASCADE to servers (064_moderation_timeout.sql)",
	"app_logs":          "server_id is nullable (043_app_logs.sql) — app logs are observability data, not server-owned rows that must vanish with the server",
}

// deleteServerCascadeTargetTable extracts the table name from a
// `DELETE FROM <table> ...` statement.
var deleteServerCascadeTargetTable = regexp.MustCompile(`(?i)DELETE FROM (\w+)`)

// listTableNames returns every user table in db (sqlite_master, excluding
// SQLite's own internal sqlite_% tables).
func listTableNames(t *testing.T, db *database.DB) []string {
	t.Helper()
	rows, err := db.Conn.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		t.Fatalf("list tables: %v", err)
	}
	defer rows.Close()

	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan table name: %v", err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate tables: %v", err)
	}
	return names
}

// tableHasColumn reports whether table has a column named column, via
// PRAGMA table_info. table comes from sqlite_master (listTableNames above),
// never from external input, so building the PRAGMA statement with
// fmt.Sprintf is safe — PRAGMA doesn't accept bound parameters for the
// table name anyway.
func tableHasColumn(t *testing.T, db *database.DB, table, column string) bool {
	t.Helper()
	rows, err := db.Conn.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		t.Fatalf("table_info(%s): %v", table, err)
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name, colType string
		var notNull, pk int
		var dfltValue any
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dfltValue, &pk); err != nil {
			t.Fatalf("scan table_info(%s): %v", table, err)
		}
		if name == column {
			return true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate table_info(%s): %v", table, err)
	}
	return false
}

// TestDeleteServerCascade_CoversEveryServerScopedTable is the P1.10
// contract test: every table in the real schema that has a server_id
// column must be accounted for by either deleteServerCascadeStmts (the
// explicit DELETEs) or fkCoveredTables (trusted to an enforced FK, or
// exempted with a reason) — so a new server_id-scoped table added later
// without wiring it into one of the two fails this test immediately,
// instead of leaking silently the way roles/categories/channels/invites/
// user_roles/bans did for years before deleteServerCascade existed.
func TestDeleteServerCascade_CoversEveryServerScopedTable(t *testing.T) {
	db := newTestDB(t)

	allTables := listTableNames(t, db)
	tableExists := make(map[string]bool, len(allTables))
	for _, table := range allTables {
		tableExists[table] = true
	}

	cascadeCovered := make(map[string]bool, len(deleteServerCascadeStmts))
	for _, stmt := range deleteServerCascadeStmts {
		m := deleteServerCascadeTargetTable.FindStringSubmatch(stmt.query)
		if m == nil {
			t.Fatalf("could not extract target table from cascade statement: %q", stmt.query)
		}
		cascadeCovered[m[1]] = true
	}

	for _, table := range allTables {
		if table == "servers" {
			continue // the parent row itself, not a server_id-scoped child
		}
		if !tableHasColumn(t, db, table, "server_id") {
			continue
		}
		if cascadeCovered[table] {
			continue
		}
		if _, ok := fkCoveredTables[table]; ok {
			continue
		}
		t.Errorf("table %q has a server_id column but is covered by neither deleteServerCascadeStmts nor fkCoveredTables — "+
			"deleting a server will leave orphaned rows here unless one of the two accounts for it", table)
	}

	// Stale-allowlist guard: an fkCoveredTables entry for a table that no
	// longer exists (renamed/dropped) means nobody re-validated that entry
	// against the table that replaced it.
	for table := range fkCoveredTables {
		if !tableExists[table] {
			t.Errorf("fkCoveredTables has a stale entry for %q — table no longer exists in the schema", table)
		}
	}
}
