package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

// DMSendReceipts must be used under the channel lock in the message transaction.
// Retaining the original ID after deletion prevents a retry resurrecting a message.
type DMSendReceipts interface {
	FindDMSend(context.Context, string, string, string, string) (*models.DMMessage, error)
	RecordDMSend(context.Context, string, string, string, string, string) error
}

func (r *sqliteDMRepo) FindDMSend(ctx context.Context, channel, user, key, hash string) (*models.DMMessage, error) {
	var savedHash, id string
	err := r.db.QueryRowContext(ctx, `SELECT request_hash,message_id FROM dm_send_receipts WHERE dm_channel_id=? AND user_id=? AND request_id=?`, channel, user, key).Scan(&savedHash, &id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if savedHash != hash {
		return nil, fmt.Errorf("%w: dm_send_request_conflict", pkg.ErrConflict)
	}
	msg, err := r.GetMessageByID(ctx, id)
	if errors.Is(err, pkg.ErrNotFound) {
		return nil, fmt.Errorf("%w: dm_send_original_unavailable", pkg.ErrConflict)
	}
	if err != nil {
		return nil, err
	}
	if msg.EditedAt != nil {
		return nil, fmt.Errorf("%w: dm_send_original_edited", pkg.ErrConflict)
	}
	if msg.DMChannelID != channel || msg.UserID != user {
		return nil, fmt.Errorf("%w: dm_send_scope_mismatch", pkg.ErrConflict)
	}
	msg.SendReplayed = true
	return msg, nil
}
func (r *sqliteDMRepo) RecordDMSend(ctx context.Context, channel, user, key, hash, id string) error {
	_, err := r.db.ExecContext(ctx, `INSERT INTO dm_send_receipts(dm_channel_id,user_id,request_id,request_hash,message_id) VALUES(?,?,?,?,?)`, channel, user, key, hash, id)
	return err
}
