package repository

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func lockGroupDM(ctx context.Context, tx *sql.Tx, id string) error {
	result, err := tx.ExecContext(ctx, `UPDATE group_dm_channels SET key_epoch=key_epoch WHERE id=?`, id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count != 1 {
		return pkg.ErrNotFound
	}
	return nil
}

// Settings belong to the requesting membership, never the shared group profile.
func (r *sqliteGroupDMRepo) SetMuted(ctx context.Context, groupID, userID string, muted bool) (*models.GroupDMReadState, error) {
	db := database.RawDB(r.db)
	if db == nil {
		return nil, fmt.Errorf("group settings require transaction-capable database")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := lockGroupDM(ctx, tx, groupID); err != nil {
		return nil, err
	}
	value := 0
	if muted {
		value = 1
	}
	const updateMuteQuery = `UPDATE group_dm_members SET is_muted=?,settings_revision=settings_revision+1 WHERE group_id=? AND user_id=? AND is_muted<>?`
	if _, err := tx.ExecContext(ctx, updateMuteQuery, value, groupID, userID, value); err != nil {
		return nil, err
	}
	state, err := groupReadState(ctx, tx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return state, nil
}
