package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// Read sequence survives removal of its display cursor and never depends on IDs.
func groupReadState(ctx context.Context, db database.TxQuerier, groupID, userID string) (*models.GroupDMReadState, error) {
	state := &models.GroupDMReadState{GroupID: groupID}
	var anchor sql.NullString
	const query = `SELECT r.last_read_message_id,r.last_read_source_sequence,r.unread_count,r.revision,m.is_muted,m.settings_revision,g.key_epoch,
 (SELECT unread.id FROM group_dm_messages unread WHERE unread.group_id=r.group_id AND unread.user_id<>? AND unread.source_sequence>r.last_read_source_sequence ORDER BY unread.source_sequence LIMIT 1)
 FROM group_dm_reads r JOIN group_dm_members m ON m.group_id=r.group_id AND m.user_id=r.user_id JOIN group_dm_channels g ON g.id=r.group_id WHERE r.group_id=? AND r.user_id=?`
	err := db.QueryRowContext(ctx, query, userID, groupID, userID).Scan(&state.LastReadMessageID, &state.LastReadSourceSequence, &state.UnreadCount, &state.Revision, &state.IsMuted, &state.SettingsRevision, &state.KeyEpoch, &anchor)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if anchor.Valid {
		state.OldestUnreadMessageID = &anchor.String
	}
	return state, nil
}

func refreshGroupReadCounts(ctx context.Context, tx *sql.Tx, groupID string) error {
	const query = `UPDATE group_dm_reads SET last_read_message_id=(SELECT seen.id FROM group_dm_messages seen WHERE seen.group_id=group_dm_reads.group_id AND seen.source_sequence<=group_dm_reads.last_read_source_sequence ORDER BY seen.source_sequence DESC LIMIT 1),
 unread_count=(SELECT COUNT(*) FROM group_dm_messages unread WHERE unread.group_id=group_dm_reads.group_id AND unread.user_id<>group_dm_reads.user_id AND unread.source_sequence>group_dm_reads.last_read_source_sequence),revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE group_id=?`
	_, err := tx.ExecContext(ctx, query, groupID)
	return err
}

func (r *sqliteGroupDMRepo) setReadCursor(ctx context.Context, groupID, userID string, messageID *string, unread bool, expectedEpoch ...int64) (*models.GroupDMReadState, error) {
	db := database.RawDB(r.db)
	if db == nil {
		return nil, fmt.Errorf("group read cursor requires transaction-capable database")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err := lockGroupDM(ctx, tx, groupID); err != nil {
		return nil, err
	}
	if err := verifyGroupKeyEpoch(ctx, tx, groupID, expectedEpoch); err != nil {
		return nil, err
	}
	var watermark int64
	if err := tx.QueryRowContext(ctx, `SELECT last_read_source_sequence FROM group_dm_reads WHERE group_id=? AND user_id=?`, groupID, userID).Scan(&watermark); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, pkg.ErrNotFound
		}
		return nil, err
	}
	var target int64
	if messageID == nil {
		err = tx.QueryRowContext(ctx, `SELECT last_source_sequence FROM group_dm_channels WHERE id=?`, groupID).Scan(&target)
	} else {
		err = tx.QueryRowContext(ctx, `SELECT source_sequence FROM group_dm_messages WHERE id=? AND group_id=?`, *messageID, groupID).Scan(&target)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if unread {
		if target > 0 {
			target--
		}
		watermark = target
	} else if target > watermark {
		watermark = target
	}
	const query = `UPDATE group_dm_reads SET last_read_source_sequence=?,last_read_message_id=(SELECT id FROM group_dm_messages WHERE group_id=? AND source_sequence<=? ORDER BY source_sequence DESC LIMIT 1),
 unread_count=(SELECT COUNT(*) FROM group_dm_messages WHERE group_id=? AND user_id<>? AND source_sequence>?),revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND user_id=?`
	if _, err := tx.ExecContext(ctx, query, watermark, groupID, watermark, groupID, userID, watermark, groupID, userID); err != nil {
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
