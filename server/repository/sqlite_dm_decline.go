package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// DeclinePending serializes with AcceptPendingUnblocked on the channel row.
// All database deletion and the receipt of notification/file cleanup data are
// committed as one unit. The caller emits events and removes files only when
// changed is true and this method returned without error.
func (r *sqliteDMRepo) DeclinePending(ctx context.Context, channelID, recipientID string) (changed bool, fileURLs, notificationIDs []string, err error) {
	raw := database.RawDB(r.db)
	if raw == nil {
		return false, nil, nil, fmt.Errorf("atomic DM decline requires database connection")
	}
	err = database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		// This no-op UPDATE obtains SQLite's write lock and PostgreSQL's row
		// lock, matching AcceptPendingUnblocked's lock order.
		if _, lockErr := tx.ExecContext(ctx, `UPDATE dm_channels SET status=status WHERE id=?`, channelID); lockErr != nil {
			return lockErr
		}
		var user1, user2, status string
		var initiator sql.NullString
		if scanErr := tx.QueryRowContext(ctx, `SELECT user1_id,user2_id,status,initiated_by FROM dm_channels WHERE id=?`, channelID).Scan(&user1, &user2, &status, &initiator); scanErr != nil {
			if scanErr == sql.ErrNoRows {
				return nil
			}
			return scanErr
		}
		if status != models.DMStatusPending || !initiator.Valid || initiator.String == "" ||
			(initiator.String != user1 && initiator.String != user2) ||
			(recipientID != user1 && recipientID != user2) || recipientID == initiator.String {
			return nil
		}

		rows, queryErr := tx.QueryContext(ctx, `SELECT a.file_url FROM dm_attachments a JOIN dm_messages m ON m.id=a.dm_message_id WHERE m.dm_channel_id=?`, channelID)
		if queryErr != nil {
			return queryErr
		}
		for rows.Next() {
			var url string
			if scanErr := rows.Scan(&url); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			fileURLs = append(fileURLs, url)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			_ = rows.Close()
			return rowsErr
		}
		if closeErr := rows.Close(); closeErr != nil {
			return closeErr
		}

		rows, queryErr = tx.QueryContext(ctx, `SELECT id FROM notifications WHERE user_id=? AND kind='dm_request' AND dm_channel_id=? AND read_at IS NULL`, recipientID, channelID)
		if queryErr != nil {
			return queryErr
		}
		for rows.Next() {
			var id string
			if scanErr := rows.Scan(&id); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			notificationIDs = append(notificationIDs, id)
		}
		if rowsErr := rows.Err(); rowsErr != nil {
			_ = rows.Close()
			return rowsErr
		}
		if closeErr := rows.Close(); closeErr != nil {
			return closeErr
		}

		// Explicit child cleanup is required for Turso/libSQL, which does not
		// enforce the declared foreign keys. Keep it in this same transaction.
		for _, statement := range []string{
			`DELETE FROM email_delivery_jobs WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE dm_channel_id=?)`,
			`DELETE FROM dm_reactions WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE dm_channel_id=?)`,
			`DELETE FROM dm_attachments WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE dm_channel_id=?)`,
			`DELETE FROM saved_messages WHERE dm_message_id IN (SELECT id FROM dm_messages WHERE dm_channel_id=?)`,
			`DELETE FROM dm_messages WHERE dm_channel_id=?`,
			`DELETE FROM dm_reads WHERE dm_channel_id=?`,
			`DELETE FROM notifications WHERE dm_channel_id=?`,
			`DELETE FROM user_dm_settings WHERE dm_channel_id=?`,
			`DELETE FROM dm_channels WHERE id=? AND status='pending'`,
		} {
			result, execErr := tx.ExecContext(ctx, statement, channelID)
			if execErr != nil {
				return execErr
			}
			if statement == `DELETE FROM dm_channels WHERE id=? AND status='pending'` {
				n, affectedErr := result.RowsAffected()
				if affectedErr != nil {
					return affectedErr
				}
				if n != 1 {
					return fmt.Errorf("pending DM channel changed during decline")
				}
				changed = true
			}
		}
		return nil
	})
	if err != nil {
		return false, nil, nil, fmt.Errorf("failed to atomically decline DM request: %w", err)
	}
	if !changed {
		return false, nil, nil, nil
	}
	return true, fileURLs, notificationIDs, nil
}
