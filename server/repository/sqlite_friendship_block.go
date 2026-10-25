package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// AtomicBlockWriter optionally exposes the production relationship transition.
// removedRelationship is true only after the complete transaction committed.
type AtomicBlockWriter interface {
	CreateBlockAtomic(context.Context, *models.Friendship) (removedRelationship bool, err error)
}

func (r *sqliteFriendshipRepo) CreateBlockAtomic(ctx context.Context, block *models.Friendship) (bool, error) {
	if block == nil || block.Status != models.FriendshipStatusBlocked || block.UserID == block.FriendID {
		return false, fmt.Errorf("%w: invalid block", pkg.ErrBadRequest)
	}
	raw := database.RawDB(r.db)
	if raw == nil {
		return false, fmt.Errorf("%w: atomic block requires database connection", pkg.ErrInternal)
	}
	removed := false
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		// Match the DM acceptance lock order before changing relationship rows.
		if _, err := tx.ExecContext(ctx, `UPDATE dm_channels SET status = status WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)`, block.UserID, block.FriendID, block.FriendID, block.UserID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM friendship_anniversary_deliveries WHERE friendship_id IN (
			SELECT id FROM friendships WHERE status <> 'blocked' AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)))`, block.UserID, block.FriendID, block.FriendID, block.UserID); err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `DELETE FROM friendships WHERE status <> 'blocked' AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))`, block.UserID, block.FriendID, block.FriendID, block.UserID)
		if err != nil {
			return err
		}
		count, err := result.RowsAffected()
		if err != nil {
			return err
		}
		removed = count > 0
		// Never overwrite another directed block or publish a partial deletion.
		result, err = tx.ExecContext(ctx, `INSERT INTO friendships (id, user_id, friend_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, friend_id) DO NOTHING`, block.ID, block.UserID, block.FriendID, block.Status, block.CreatedAt, block.UpdatedAt)
		if err != nil {
			return err
		}
		count, err = result.RowsAffected()
		if err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("%w: user already blocked", pkg.ErrAlreadyExists)
		}
		return nil
	})
	return err == nil && removed, err
}
