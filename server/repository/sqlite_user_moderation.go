// Platform ban/unban and account/message hard-deletion cascades.
package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/pkg"
)

func (r *sqliteUserRepo) PlatformBan(ctx context.Context, userID, reason, bannedBy string) error {
	// Bumping token_version here invalidates every outstanding access
	// token for this user in the same write. ValidateAccessToken's
	// version check + the new is_platform_banned check below it both
	// fire — defence in depth so a token escapes the ban only if BOTH
	// gates are silently bypassed.
	query := `
		UPDATE users
		SET is_platform_banned = 1,
			platform_ban_reason = ?,
			platform_banned_by = ?,
			platform_banned_at = CURRENT_TIMESTAMP,
			token_version = token_version + 1
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, reason, bannedBy, userID)
	if err != nil {
		return fmt.Errorf("failed to platform ban user: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

func (r *sqliteUserRepo) PlatformUnban(ctx context.Context, userID string) error {
	query := `
		UPDATE users
		SET is_platform_banned = 0,
			platform_ban_reason = '',
			platform_banned_by = '',
			platform_banned_at = NULL
		WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, userID)
	if err != nil {
		return fmt.Errorf("failed to platform unban user: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

// IsEmailPlatformBanned checks if the email belongs to a banned user.
// Used during registration to prevent new accounts with banned emails.
func (r *sqliteUserRepo) IsEmailPlatformBanned(ctx context.Context, email string) (bool, error) {
	query := `SELECT COUNT(*) FROM users WHERE email = ? AND is_platform_banned = 1`

	var count int
	err := r.db.QueryRowContext(ctx, query, email).Scan(&count)
	if err != nil {
		return false, fmt.Errorf("failed to check email platform ban: %w", err)
	}

	return count > 0, nil
}

// DeleteAllMessagesByUser deletes all server messages and DM messages for a user.
// Attachments are CASCADE-deleted with messages. Used for optional "delete messages" on platform ban.
func (r *sqliteUserRepo) DeleteAllMessagesByUser(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM messages WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user messages: %w", err)
	}

	_, err = r.db.ExecContext(ctx, `DELETE FROM dm_messages WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user DM messages: %w", err)
	}

	return nil
}

// HardDeleteUser permanently deletes the user and all CASCADE-linked data.
// reassignToUserID (the admin performing the deletion) receives ownership of
// records that have a NOT NULL, non-CASCADE FK to the deleted user and must
// survive the account (badge templates the user created, badge grants they
// made) — deleting those rows instead would silently take badges away from
// other users.
//
// CASCADE covers: user_roles, messages, sessions, dm_channels, dm_messages,
// message_mentions, reactions, friendships, server_members, channel_reads,
// password_reset_tokens, server_mutes, and the deleted user's own
// user_badges rows (user_badges.user_id ON DELETE CASCADE).
//
// Manual cleanup needed (all NOT NULL FKs to users with no CASCADE, so the
// final DELETE FROM users would otherwise fail the foreign-key check):
//   - bans: no FK, username stored as text — orphans are harmless
//   - servers.owner_id: no CASCADE — caller must clean up owned servers first,
//     and each owned server needs the SAME cascade sqliteServerRepo.Delete
//     uses (channels/categories/roles/invites/user_roles/bans have no FK to
//     servers either — see deleteServerCascade), not a bare
//     `DELETE FROM servers`, or those tables leak exactly like they did
//     before that fix.
//   - reports.reporter_id / reported_user_id: deleted outright (a report
//     with no reporter or no accused is meaningless). reports.resolved_by is
//     nullable, so it is cleared to NULL rather than reassigned — attributing
//     someone else's resolution to the admin running this delete would be
//     misleading.
//   - feedback_tickets.user_id / feedback_replies.user_id: deleted outright;
//     feedback_attachments CASCADEs from both (ticket_id and reply_id FKs).
//   - badges.created_by / user_badges.assigned_by: reassigned to
//     reassignToUserID (see above).
//
// Disk files (badge icons, feedback attachments, avatars, message
// attachments) are deliberately NOT touched here — this repo layer only
// owns DB rows. Orphaned files are harmless: media_access serves uploads by
// path with a fail-closed 404 when the owning DB row is gone (finding A-21),
// so an orphaned file is simply unreachable, not exposed.
func (r *sqliteUserRepo) HardDeleteUser(ctx context.Context, userID, reassignToUserID string) error {
	sqlDB := database.RawDB(r.db)
	if sqlDB == nil {
		// r.db is already a *sql.Tx — this repo instance was bound to an
		// existing transaction by its caller. Run the statements directly
		// against r.db and let the caller's own transaction provide the
		// atomicity (same pattern as sqliteServerRepo.RemoveMember).
		return r.hardDeleteUserStmts(ctx, r.db, userID, reassignToUserID)
	}

	return database.WithTx(ctx, sqlDB, func(tx *sql.Tx) error {
		return r.hardDeleteUserStmts(ctx, tx, userID, reassignToUserID)
	})
}

// hardDeleteUserStmts runs every statement HardDeleteUser needs against q —
// either the transaction HardDeleteUser opened, or the caller-supplied
// *sql.Tx when RawDB found none of its own to start. Everything here runs
// atomically: a crash partway through must never leave reports/feedback/
// badges referencing a user row that no longer exists.
func (r *sqliteUserRepo) hardDeleteUserStmts(ctx context.Context, q database.TxQuerier, userID, reassignToUserID string) error {
	// bans has no FK — manual cleanup
	if _, err := q.ExecContext(ctx, `DELETE FROM bans WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to clean up bans for user: %w", err)
	}

	// servers.owner_id has no CASCADE — delete each owned server through the
	// same cascade sqliteServerRepo.Delete uses, not a bare bulk delete.
	ownedIDs, err := ownedServerIDs(ctx, q, userID)
	if err != nil {
		return fmt.Errorf("failed to list owned servers: %w", err)
	}
	for _, serverID := range ownedIDs {
		if err := deleteServerCascade(ctx, q, serverID); err != nil {
			return fmt.Errorf("failed to delete owned server %s: %w", serverID, err)
		}
	}

	// reports: reporter_id / reported_user_id are NOT NULL FKs with no
	// CASCADE — delete every report on either side of the deleted user.
	if _, err := q.ExecContext(ctx,
		`DELETE FROM reports WHERE reporter_id = ? OR reported_user_id = ?`,
		userID, userID); err != nil {
		return fmt.Errorf("failed to delete reports for user: %w", err)
	}
	// resolved_by is nullable — null out any remaining report the deleted
	// user had resolved rather than reassigning it.
	if _, err := q.ExecContext(ctx,
		`UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?`,
		userID); err != nil {
		return fmt.Errorf("failed to clear resolved_by on reports: %w", err)
	}

	// feedback_tickets.user_id is NOT NULL with no CASCADE. Deleting the
	// ticket CASCADEs feedback_replies (ticket_id FK) and
	// feedback_attachments (ticket_id/reply_id FK) for it.
	if _, err := q.ExecContext(ctx, `DELETE FROM feedback_tickets WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete feedback tickets for user: %w", err)
	}
	// feedback_replies.user_id is NOT NULL with no CASCADE — covers replies
	// the deleted user left on someone else's ticket, which the delete above
	// doesn't reach. feedback_attachments.reply_id CASCADEs from this too.
	if _, err := q.ExecContext(ctx, `DELETE FROM feedback_replies WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete feedback replies for user: %w", err)
	}

	// badges.created_by and user_badges.assigned_by are NOT NULL FKs with no
	// CASCADE — reassign to the admin performing this deletion so the badge
	// (and any grants the user made) survive the account, matching the doc
	// comment above.
	if _, err := q.ExecContext(ctx,
		`UPDATE badges SET created_by = ? WHERE created_by = ?`,
		reassignToUserID, userID); err != nil {
		return fmt.Errorf("failed to reassign badges created by user: %w", err)
	}
	if _, err := q.ExecContext(ctx,
		`UPDATE user_badges SET assigned_by = ? WHERE assigned_by = ?`,
		reassignToUserID, userID); err != nil {
		return fmt.Errorf("failed to reassign badge assignments made by user: %w", err)
	}

	// Main delete — CASCADE handles all remaining related data.
	result, err := q.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to hard delete user: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

// ownedServerIDs lists the servers a user owns, for HardDeleteUser to
// cascade-delete individually before the bans/user row cleanup. Runs against
// q (the transaction HardDeleteUser is inside) rather than r.db directly, so
// the read is atomic with the deletes that follow it.
func ownedServerIDs(ctx context.Context, q database.TxQuerier, userID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id FROM servers WHERE owner_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query owned servers: %w", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("failed to scan owned server id: %w", err)
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
