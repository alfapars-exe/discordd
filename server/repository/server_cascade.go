package repository

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

// deleteServerCascadeStmts removes every row scoped to one server, deepest
// first, ending with the servers row itself.
//
// Why this exists: channels, categories, roles, invites, user_roles, and
// bans all received their server_id column via a bare
// `ALTER TABLE ... ADD COLUMN server_id ...` in migration 018 — SQLite
// cannot combine ADD COLUMN with a REFERENCES clause, so that migration's
// own comment documents omitting it. None of those six tables has an
// enforced foreign key to servers, so deleting only the servers row (what
// sqliteServerRepo.Delete did before this) leaves them all behind. This is
// exactly the "orphaned rows detected" warning the maintenance census logs
// at every boot for channels/categories/user_roles — roles/invites/bans
// leak identically, the census just never probed them.
//
// Rows further down (messages, attachments, reactions, ...) DO carry a real
// `REFERENCES ... ON DELETE CASCADE` to channels/roles, so in principle
// deleting an orphaned channels row would pull them along automatically.
// This code deletes them explicitly anyway rather than trusting that: the
// migration runner strips every PRAGMA statement because the remote
// libSQL/Turso connection this database now runs on rejects them with
// HTTP 400 (see database/integrity.go) — that is the exact mechanism a
// table rebuild would need to safely manage `ON DELETE CASCADE` during a
// migration, so nothing in this codebase has verified cascade fires
// reliably here. The explicit statements below are correct regardless.
//
// Query the argument count from each statement is fixed by hand, not
// derived, so a future edit that adds an "OR role_id IN (...)" clause but
// forgets to add the matching arg is a compile error at the call sites
// below, not a runtime placeholder-mismatch.
var deleteServerCascadeStmts = []struct {
	query string
	args  func(serverID string) []any
}{
	{
		query: `DELETE FROM attachments WHERE message_id IN (
			SELECT id FROM messages WHERE channel_id IN (
				SELECT id FROM channels WHERE server_id = ?))`,
		args: func(id string) []any { return []any{id} },
	},
	{
		query: `DELETE FROM reactions WHERE message_id IN (
			SELECT id FROM messages WHERE channel_id IN (
				SELECT id FROM channels WHERE server_id = ?))`,
		args: func(id string) []any { return []any{id} },
	},
	{
		query: `DELETE FROM message_mentions WHERE message_id IN (
			SELECT id FROM messages WHERE channel_id IN (
				SELECT id FROM channels WHERE server_id = ?))`,
		args: func(id string) []any { return []any{id} },
	},
	{
		query: `DELETE FROM message_role_mentions
			WHERE message_id IN (
				SELECT id FROM messages WHERE channel_id IN (
					SELECT id FROM channels WHERE server_id = ?))
			   OR role_id IN (SELECT id FROM roles WHERE server_id = ?)`,
		args: func(id string) []any { return []any{id, id} },
	},
	{
		query: `DELETE FROM pinned_messages WHERE channel_id IN (
			SELECT id FROM channels WHERE server_id = ?)`,
		args: func(id string) []any { return []any{id} },
	},
	{
		// Must run after every statement above that identifies its rows via
		// messages — once this runs, that lookup path is gone.
		query: `DELETE FROM messages WHERE channel_id IN (
			SELECT id FROM channels WHERE server_id = ?)`,
		args: func(id string) []any { return []any{id} },
	},
	{
		query: `DELETE FROM channel_permissions
			WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)
			   OR role_id IN (SELECT id FROM roles WHERE server_id = ?)`,
		args: func(id string) []any { return []any{id, id} },
	},
	{
		query: `DELETE FROM channel_reads WHERE channel_id IN (
			SELECT id FROM channels WHERE server_id = ?)`,
		args: func(id string) []any { return []any{id} },
	},
	{
		query: `DELETE FROM channel_group_sessions WHERE channel_id IN (
			SELECT id FROM channels WHERE server_id = ?)`,
		args: func(id string) []any { return []any{id} },
	},
	{
		// Parents, deleted last — after every statement above that
		// identifies its rows by joining through channels or roles.
		query: `DELETE FROM channels WHERE server_id = ?`,
		args:  func(id string) []any { return []any{id} },
	},
	{
		query: `DELETE FROM user_roles WHERE server_id = ?`,
		args:  func(id string) []any { return []any{id} },
	},
	{
		// After user_roles / channel_permissions / message_role_mentions,
		// which reference role_id.
		query: `DELETE FROM roles WHERE server_id = ?`,
		args:  func(id string) []any { return []any{id} },
	},
	{
		query: `DELETE FROM categories WHERE server_id = ?`,
		args:  func(id string) []any { return []any{id} },
	},
	{
		query: `DELETE FROM invites WHERE server_id = ?`,
		args:  func(id string) []any { return []any{id} },
	},
	{
		// (server_id, user_id) primary key, no FK on either column.
		query: `DELETE FROM bans WHERE server_id = ?`,
		args:  func(id string) []any { return []any{id} },
	},
	{
		// The server row itself, last — everything above joins through it.
		query: `DELETE FROM servers WHERE id = ?`,
		args:  func(id string) []any { return []any{id} },
	},
}

// deleteServerCascade removes serverID and every row scoped to it, returning
// pkg.ErrNotFound if no server with that ID existed — matching the contract
// the bare `DELETE FROM servers` call had before this. Tables with a real
// enforced foreign key to servers (server_members, server_mutes, and others
// confirmed at audit time) are intentionally left to that constraint — this
// function only covers the tables proven to lack one; see
// deleteServerCascadeStmts.
//
// q may be a *sql.DB or a *sql.Tx (database.TxQuerier covers both). Callers
// that need the whole operation to be atomic should bind q to a transaction
// (see server_service.go / admin_server_service.go DeleteServer, which
// follow the same database.WithTx pattern already used for CreateServer).
func deleteServerCascade(ctx context.Context, q database.TxQuerier, serverID string) error {
	last := len(deleteServerCascadeStmts) - 1
	for i, stmt := range deleteServerCascadeStmts {
		result, err := q.ExecContext(ctx, stmt.query, stmt.args(serverID)...)
		if err != nil {
			return fmt.Errorf("server cascade delete failed: %w", err)
		}
		if i == last {
			affected, raErr := result.RowsAffected()
			if raErr != nil {
				return fmt.Errorf("failed to check rows affected: %w", raErr)
			}
			if affected == 0 {
				return pkg.ErrNotFound
			}
		}
	}
	return nil
}
