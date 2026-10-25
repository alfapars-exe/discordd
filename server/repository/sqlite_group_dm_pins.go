package repository

import (
	"context"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

const MaxGroupDMPins = 50

// The member predicate is part of each statement, not merely a service check.
func (r *sqliteGroupDMRepo) SetMessagePinned(ctx context.Context, groupID, messageID, userID string, pinned bool) error {
	member, err := r.IsMember(ctx, groupID, userID)
	if err != nil {
		return err
	}
	if !member {
		return pkg.ErrForbidden
	}
	if _, err = r.GetMessage(ctx, groupID, messageID); err != nil {
		return err
	}
	if !pinned {
		result, err := r.db.ExecContext(ctx, `DELETE FROM group_dm_pins WHERE group_id=? AND message_id=? AND EXISTS (SELECT 1 FROM group_dm_members WHERE group_id=? AND user_id=?)`, groupID, messageID, groupID, userID)
		if err != nil {
			return err
		}
		changed, err := result.RowsAffected()
		if err != nil || changed > 0 {
			return err
		}
		// No-op unpin remains idempotent, but must not report success if a
		// concurrent membership removal prevented the write predicate.
		member, err = r.IsMember(ctx, groupID, userID)
		if err != nil {
			return err
		}
		if !member {
			return pkg.ErrForbidden
		}
		return nil
	}
	// SQLite serializes this single statement's count predicate and write.
	// PostgreSQL needs a per-group transaction lock before the statement so
	// two READ COMMITTED snapshots cannot both consume the final free slot.
	if database.IsPostgres(r.db) {
		tx, err := database.RawDB(r.db).BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
		var lockedID string
		if err = tx.QueryRowContext(ctx, `SELECT id FROM group_dm_channels WHERE id=? FOR UPDATE`, groupID).Scan(&lockedID); err != nil {
			return err
		}
		if err = (&sqliteGroupDMRepo{db: tx}).insertMessagePin(ctx, groupID, messageID, userID); err != nil {
			return err
		}
		return tx.Commit()
	}
	return r.insertMessagePin(ctx, groupID, messageID, userID)
}

func (r *sqliteGroupDMRepo) insertMessagePin(ctx context.Context, groupID, messageID, userID string) error {
	result, err := r.db.ExecContext(ctx, `INSERT INTO group_dm_pins(group_id,message_id,pinned_by)
 SELECT m.group_id,m.id,? FROM group_dm_messages m WHERE m.group_id=? AND m.id=?
 AND EXISTS (SELECT 1 FROM group_dm_members WHERE group_id=m.group_id AND user_id=?)
 AND (SELECT COUNT(*) FROM group_dm_pins WHERE group_id=m.group_id)<?
 ON CONFLICT(group_id,message_id) DO NOTHING`, userID, groupID, messageID, userID, MaxGroupDMPins)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil || changed > 0 {
		return err
	}
	member, err := r.IsMember(ctx, groupID, userID)
	if err != nil {
		return err
	}
	if !member {
		return pkg.ErrForbidden
	}
	var exists bool
	if err = r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM group_dm_pins WHERE group_id=? AND message_id=?)`, groupID, messageID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	if _, err = r.GetMessage(ctx, groupID, messageID); err != nil {
		return err
	}
	return fmt.Errorf("%w: group has reached the maximum number of pins (%d)", pkg.ErrBadRequest, MaxGroupDMPins)
}

func (r *sqliteGroupDMRepo) ListPinnedMessages(ctx context.Context, groupID, userID string) ([]models.GroupDMMessage, error) {
	member, err := r.IsMember(ctx, groupID, userID)
	if err != nil {
		return nil, err
	}
	if !member {
		return nil, pkg.ErrForbidden
	}
	rows, err := r.db.QueryContext(ctx, `SELECT m.id,m.group_id,m.user_id,m.content,m.encryption_version,m.ciphertext,m.sender_device_id,m.e2ee_metadata,m.key_epoch,m.reply_to_id,m.edited_at,m.created_at,m.source_sequence
 FROM group_dm_messages m JOIN group_dm_pins p ON p.message_id=m.id AND p.group_id=m.group_id
 WHERE m.group_id=? AND EXISTS(SELECT 1 FROM group_dm_members WHERE group_id=m.group_id AND user_id=?)
	 ORDER BY p.created_at DESC,p.message_id DESC`, groupID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []models.GroupDMMessage{}
	for rows.Next() {
		var m models.GroupDMMessage
		if err := rows.Scan(&m.ID, &m.GroupID, &m.UserID, &m.Content, &m.EncryptionVersion, &m.Ciphertext, &m.SenderDeviceID, &m.E2EEMetadata, &m.KeyEpoch, &m.ReplyToID, &m.EditedAt, &m.CreatedAt, &m.SourceSequence); err != nil {
			return nil, err
		}
		items = append(items, m)
	}
	return items, rows.Err()
}
