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
	// Bookmarks (saved_messages, migration 083) of these messages — by any
	// user — go first: their cascade is unenforced on Turso, and the
	// subqueries identify rows through the messages about to be deleted.
	if _, err := r.db.ExecContext(ctx,
		`DELETE FROM saved_messages WHERE message_id IN (SELECT id FROM messages WHERE user_id = ?)`, userID); err != nil {
		return fmt.Errorf("failed to delete saved references to user messages: %w", err)
	}
	if _, err := r.db.ExecContext(ctx,
		`DELETE FROM saved_messages WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE user_id = ?)`, userID); err != nil {
		return fmt.Errorf("failed to delete saved references to user DM messages: %w", err)
	}

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
//   - server_emojis.created_by / server_stickers.created_by: cleared to
//     NULL, not reassigned — the creator alone controls the copyable
//     licence. Emojis and stickers of servers the user owned go with those
//     servers' cascade.
//   - user_equipped / user_cosmetic_plain_servers / user_cosmetics.user_id:
//     deleted; user_cosmetics.granted_by and cosmetic_items.created_by are
//     cleared to NULL (grants to others and server items survive).
//   - server_events.creator_id, server_event_rsvps.user_id, and
//     server_event_deliveries.user_id: manually cascade authored events and
//     their attendees, then remove this user's attendance from other events.
//
// Disk files are deliberately NOT touched here — this repo layer only owns
// DB rows. Most orphaned files are unreachable (media_access fails closed
// with 404 when the owning row is gone, finding A-21), but soundboard/ and
// badges/ files are public by URL prefix and stay reachable. The files of
// owned servers (soundboard clips included) and the user's own entrance
// clips are therefore collected with GetOwnedServerFileURLs before this runs
// and removed by the service after it commits.
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
	// A self-deleted identity anchors other participants' retained history.
	// Refuse before any cleanup; the database DELETE trigger is a second gate.
	var retained bool
	if err := q.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NOT NULL)`, userID).Scan(&retained); err != nil {
		return err
	}
	if retained {
		return pkg.ErrForbidden
	}
	// libSQL may not enforce foreign keys; delete MFA secrets explicitly.
	if _, err := q.ExecContext(ctx, `DELETE FROM account_email_tokens WHERE user_id=?`, userID); err != nil {
		return fmt.Errorf("failed to remove email verification data: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM email_unsubscribe_tokens WHERE user_id=?`, userID); err != nil {
		return fmt.Errorf("failed to remove email unsubscribe tokens: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM account_lifecycle WHERE user_id=?`, userID); err != nil {
		return fmt.Errorf("failed to remove account lifecycle: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM account_mfa WHERE user_id=?`, userID); err != nil {
		return fmt.Errorf("failed to remove account security data: %w", err)
	}
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

	// Event tables declare ON DELETE CASCADE to users/events, but those
	// constraints are not enforced on the production libSQL/Turso path. First
	// remove all descendants of events authored by this user, then the events,
	// then this user's attendance/delivery rows on events owned by others.
	if _, err := q.ExecContext(ctx, `DELETE FROM server_event_deliveries WHERE event_id IN (
		SELECT id FROM server_events WHERE creator_id = ?)`, userID); err != nil {
		return fmt.Errorf("failed to delete deliveries for authored server events: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM server_event_rsvps WHERE event_id IN (
		SELECT id FROM server_events WHERE creator_id = ?)`, userID); err != nil {
		return fmt.Errorf("failed to delete RSVPs for authored server events: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM server_events WHERE creator_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete server events created by user: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM server_event_deliveries WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete server event deliveries for user: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM server_event_rsvps WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete server event RSVPs for user: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM stream_start_deliveries WHERE recipient_id=? OR actor_id=?`, userID, userID); err != nil {
		return fmt.Errorf("failed to delete stream notification decisions for user: %w", err)
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

	// dm_reads / notifications (migrations 081/082) declare ON DELETE
	// CASCADE to users, but the production libSQL/Turso connection never
	// enforces foreign keys, so remove them explicitly — both the rows the
	// user owns and the ones that name them as the actor.
	if _, err := q.ExecContext(ctx, `DELETE FROM dm_reads WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete DM read states for user: %w", err)
	}
	if _, err := q.ExecContext(ctx,
		`DELETE FROM notifications WHERE user_id = ? OR actor_id = ?`,
		userID, userID); err != nil {
		return fmt.Errorf("failed to delete notifications for user: %w", err)
	}
	// saved_messages / user_notes (migrations 083/084): same unenforced
	if _, err := q.ExecContext(ctx, `DELETE FROM private_media_labels WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete private media labels: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM spam_inbox WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete spam decisions for user: %w", err)
	}
	// cascade to users. Notes are removed on both sides — the ones the user
	// wrote and the ones others wrote about them.
	if _, err := q.ExecContext(ctx, `DELETE FROM saved_messages WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete saved messages for user: %w", err)
	}
	if _, err := q.ExecContext(ctx,
		`DELETE FROM user_notes WHERE owner_user_id = ? OR target_user_id = ?`,
		userID, userID); err != nil {
		return fmt.Errorf("failed to delete user notes for user: %w", err)
	}
	// server_emojis.created_by (migration 086) is nullable with ON DELETE
	// SET NULL, unenforced on Turso — clear it explicitly. Not reassigned:
	// created_by decides who may change the emoji's copyable licence, which
	// must not pass to the admin running this delete.
	if _, err := q.ExecContext(ctx,
		`UPDATE server_emojis SET created_by = NULL WHERE created_by = ?`,
		userID); err != nil {
		return fmt.Errorf("failed to clear created_by on server emojis: %w", err)
	}
	// server_stickers.created_by (migration 087): same rule as emojis.
	if _, err := q.ExecContext(ctx,
		`UPDATE server_stickers SET created_by = NULL WHERE created_by = ?`,
		userID); err != nil {
		return fmt.Errorf("failed to clear created_by on server stickers: %w", err)
	}
	// Entrance sounds (migration 088): selections, server-side mutes of the
	// user and the user's own clips — unenforced cascades on Turso. The clip
	// files were collected by GetOwnedServerFileURLs before this runs.
	if _, err := q.ExecContext(ctx, `DELETE FROM user_entrance_selection WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete entrance selections for user: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM server_entrance_mutes WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete entrance mutes for user: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM user_entrance_sounds WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete entrance sounds for user: %w", err)
	}
	// Cosmetics (migration 089): the user's slots, plain switches and the
	// grants they received go - unenforced cascades on Turso. user_cosmetics
	// names two users, so grants they made to others survive with
	// granted_by cleared, and items they created survive with created_by
	// cleared (the item belongs to its server).
	if _, err := q.ExecContext(ctx, `DELETE FROM user_equipped WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete equipped cosmetics for user: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM user_cosmetic_plain_servers WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete cosmetic plain servers for user: %w", err)
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM user_cosmetics WHERE user_id = ?`, userID); err != nil {
		return fmt.Errorf("failed to delete cosmetic grants for user: %w", err)
	}
	if _, err := q.ExecContext(ctx,
		`UPDATE user_cosmetics SET granted_by = NULL WHERE granted_by = ?`, userID); err != nil {
		return fmt.Errorf("failed to clear granted_by on cosmetic grants: %w", err)
	}
	if _, err := q.ExecContext(ctx,
		`UPDATE cosmetic_items SET created_by = NULL WHERE created_by = ?`, userID); err != nil {
		return fmt.Errorf("failed to clear created_by on cosmetic items: %w", err)
	}

	// Main delete — CASCADE handles all remaining related data.
	if _, err := q.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=?`, userID); err != nil {
		return err
	}
	if _, err := q.ExecContext(ctx, `DELETE FROM auth_sessions WHERE user_id=?`, userID); err != nil {
		return err
	}
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

// GetOwnedServerFileURLs collects the upload file_urls of every server the
// user owns, using the same query as GetFileURLsByServerID, plus the user's
// own entrance-sound clips (migration 088).
func (r *sqliteUserRepo) GetOwnedServerFileURLs(ctx context.Context, userID string) ([]string, error) {
	ids, err := ownedServerIDs(ctx, r.db, userID)
	if err != nil {
		return nil, err
	}
	var urls []string
	for _, id := range ids {
		serverURLs, err := serverFileURLs(ctx, r.db, id)
		if err != nil {
			return nil, err
		}
		urls = append(urls, serverURLs...)
	}
	rows, err := r.db.QueryContext(ctx, `SELECT file_url FROM user_entrance_sounds WHERE user_id = ?`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to query entrance sound urls: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, fmt.Errorf("failed to scan entrance sound url: %w", err)
		}
		urls = append(urls, u)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate entrance sound urls: %w", err)
	}
	return urls, nil
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
