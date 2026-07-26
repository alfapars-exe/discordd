// Platform ban/unban and account/message hard-deletion cascades.
package repository

import (
	"context"
	"fmt"

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
//
// CASCADE covers: user_roles, messages, sessions, dm_channels, dm_messages,
// message_mentions, reactions, friendships, server_members, channel_reads,
// password_reset_tokens, server_mutes.
//
// Manual cleanup needed:
//   - bans: no FK, username stored as text — orphans are harmless
//   - servers.owner_id: no CASCADE — caller must clean up owned servers first,
//     and each owned server needs the SAME cascade sqliteServerRepo.Delete
//     uses (channels/categories/roles/invites/user_roles/bans have no FK to
//     servers either — see deleteServerCascade), not a bare
//     `DELETE FROM servers`, or those tables leak exactly like they did
//     before that fix.
func (r *sqliteUserRepo) HardDeleteUser(ctx context.Context, userID string) error {
	// bans has no FK — manual cleanup
	_, err := r.db.ExecContext(ctx, `DELETE FROM bans WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to clean up bans for user: %w", err)
	}

	// servers.owner_id has no CASCADE — delete each owned server through the
	// same cascade sqliteServerRepo.Delete uses, not a bare bulk delete.
	ownedIDs, err := r.ownedServerIDs(ctx, userID)
	if err != nil {
		return fmt.Errorf("failed to list owned servers: %w", err)
	}
	for _, serverID := range ownedIDs {
		if err := deleteServerCascade(ctx, r.db, serverID); err != nil {
			return fmt.Errorf("failed to delete owned server %s: %w", serverID, err)
		}
	}

	// Main delete — CASCADE handles all related data
	result, err := r.db.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, userID)
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
// cascade-delete individually before the bans/user row cleanup.
func (r *sqliteUserRepo) ownedServerIDs(ctx context.Context, userID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id FROM servers WHERE owner_id = ?`, userID)
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
