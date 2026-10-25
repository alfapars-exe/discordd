package repository

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

func validGroupSendKey(key, hash string, count int) bool {
	if !models.ValidGroupSendRequestID(key) || len(hash) != 64 || count < 0 || count > 10 {
		return false
	}
	_, err := hex.DecodeString(hash)
	return err == nil
}

func readGroupSend(ctx context.Context, q database.TxQuerier, group, user, key string) (*models.GroupSendOperation, error) {
	op := &models.GroupSendOperation{}
	var failed string
	var cancelled sql.NullTime
	err := q.QueryRowContext(ctx, `SELECT group_id,user_id,request_id,request_hash,message_id,file_count,phase,failed_indices,created_at,updated_at,cancelled_at FROM group_dm_send_operations WHERE group_id=? AND user_id=? AND request_id=?`, group, user, key).Scan(&op.GroupID, &op.UserID, &op.RequestID, &op.RequestHash, &op.MessageID, &op.FileCount, &op.Phase, &failed, &op.CreatedAt, &op.UpdatedAt, &cancelled)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if cancelled.Valid {
		op.Phase = "cancelled"
	}
	if err = json.Unmarshal([]byte(failed), &op.FailedIndices); err != nil {
		return nil, fmt.Errorf("read group send outcome: %w", err)
	}
	return op, nil
}

func (r *sqliteGroupDMRepo) GetSendOperation(ctx context.Context, group, user, key string) (*models.GroupSendOperation, error) {
	return readGroupSend(ctx, r.db, group, user, key)
}

// CancelSend races against the same operation-row lock as CreateMessage.
// A missing operation gets a permanent cancellation tombstone as well: an
// original HTTP request may still be delayed before reaching PrepareSend.
func (r *sqliteGroupDMRepo) CancelSend(ctx context.Context, group, user, key string) (*models.GroupSendOperation, error) {
	if !models.ValidGroupSendRequestID(key) {
		return nil, pkg.ErrBadRequest
	}
	db := database.RawDB(r.db)
	if db == nil {
		return nil, fmt.Errorf("group send cancellation requires transaction")
	}
	id, err := generateID()
	if err != nil {
		return nil, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `INSERT INTO group_dm_send_operations(group_id,user_id,request_id,request_hash,message_id,file_count,cancelled_at) SELECT ?,?,?,?,?,0,CURRENT_TIMESTAMP WHERE EXISTS(SELECT 1 FROM group_dm_members WHERE group_id=? AND user_id=?) ON CONFLICT(group_id,user_id,request_id) DO NOTHING`, group, user, key, strings.Repeat("0", 64), id, group, user); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE group_dm_send_operations SET cancelled_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND user_id=? AND request_id=? AND phase='prepared' AND cancelled_at IS NULL`, group, user, key); err != nil {
		return nil, err
	}
	op, err := readGroupSend(ctx, tx, group, user, key)
	if err != nil {
		return nil, err
	}
	return op, tx.Commit()
}

func (r *sqliteGroupDMRepo) PrepareSend(ctx context.Context, group, user, key, hash string, count int) (*models.GroupSendOperation, bool, error) {
	if !validGroupSendKey(key, hash, count) {
		return nil, false, pkg.ErrBadRequest
	}
	id, err := generateID()
	if err != nil {
		return nil, false, err
	}
	result, err := r.db.ExecContext(ctx, `INSERT INTO group_dm_send_operations(group_id,user_id,request_id,request_hash,message_id,file_count) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM group_dm_members WHERE group_id=? AND user_id=?) ON CONFLICT(group_id,user_id,request_id) DO NOTHING`, group, user, key, hash, id, count, group, user)
	if err != nil {
		return nil, false, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return nil, false, err
	}
	op, err := r.GetSendOperation(ctx, group, user, key)
	if err != nil {
		return nil, false, err
	}
	if op.RequestHash != hash || op.FileCount != count {
		return nil, false, pkg.ErrConflict
	}
	return op, n == 1, nil
}

// CompleteSend locks the operation before reading attachments. Tracked uploads
// acquire the same lock, so a late worker cannot append after finalization.
func (r *sqliteGroupDMRepo) CompleteSend(ctx context.Context, group, user, key string, failed []int) (*models.GroupSendOperation, error) {
	db := database.RawDB(r.db)
	if db == nil {
		return nil, fmt.Errorf("group send completion requires transaction")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `UPDATE group_dm_send_operations SET phase=phase WHERE group_id=? AND user_id=? AND request_id=?`, group, user, key); err != nil {
		return nil, err
	}
	op, err := readGroupSend(ctx, tx, group, user, key)
	if err != nil {
		return nil, err
	}
	normalized := append([]int{}, failed...)
	slices.Sort(normalized)
	for i, index := range normalized {
		if index < 0 || index >= op.FileCount || (i > 0 && normalized[i-1] == index) {
			return nil, pkg.ErrBadRequest
		}
	}
	if op.Phase == "completed" {
		if !slices.Equal(op.FailedIndices, normalized) {
			return nil, pkg.ErrConflict
		}
		return op, tx.Commit()
	}
	if op.Phase != "committed" {
		return nil, pkg.ErrConflict
	}
	present := make(map[int]bool)
	rows, err := tx.QueryContext(ctx, `SELECT file_key_index FROM group_dm_attachments WHERE group_message_id=?`, op.MessageID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var index sql.NullInt64
		if err = rows.Scan(&index); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if !index.Valid || index.Int64 < 0 || index.Int64 >= int64(op.FileCount) || present[int(index.Int64)] {
			_ = rows.Close()
			return nil, pkg.ErrConflict
		}
		present[int(index.Int64)] = true
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	for _, index := range normalized {
		if present[index] {
			return nil, pkg.ErrConflict
		}
		present[index] = true
	}
	if len(present) != op.FileCount {
		return nil, pkg.ErrConflict
	}
	encoded, _ := json.Marshal(normalized)
	if _, err = tx.ExecContext(ctx, `UPDATE group_dm_send_operations SET phase='completed',failed_indices=?,updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND user_id=? AND request_id=?`, string(encoded), group, user, key); err != nil {
		return nil, err
	}
	op, err = readGroupSend(ctx, tx, group, user, key)
	if err != nil {
		return nil, err
	}
	return op, tx.Commit()
}

func (r *sqliteGroupDMRepo) insertGroupAttachment(ctx context.Context, a *models.GroupDMAttachment) error {
	const insert = `INSERT INTO group_dm_attachments(id,group_message_id,filename,file_url,file_size,mime_type,file_key_index) VALUES(?,?,?,?,?,?,?)`
	args := []any{a.ID, a.GroupMessageID, a.Filename, a.FileURL, a.FileSize, a.MimeType, a.FileKeyIndex}
	// Legacy uploads keep their existing path (including wrapper read-back tests).
	rows, err := r.db.QueryContext(ctx, `SELECT message_id FROM group_dm_send_operations WHERE message_id=?`, a.GroupMessageID)
	if err != nil {
		return err
	}
	tracked := rows.Next()
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	if !tracked {
		_, err = r.db.ExecContext(ctx, insert, args...)
		return err
	}
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("tracked group upload requires transaction")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	locked, err := tx.ExecContext(ctx, `UPDATE group_dm_send_operations SET phase=phase WHERE message_id=? AND phase='committed'`, a.GroupMessageID)
	if err != nil {
		return err
	}
	n, err := locked.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return pkg.ErrConflict
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT file_count FROM group_dm_send_operations WHERE message_id=?`, a.GroupMessageID).Scan(&count); err != nil {
		return err
	}
	if a.FileKeyIndex == nil || *a.FileKeyIndex < 0 || *a.FileKeyIndex >= count {
		return pkg.ErrBadRequest
	}
	var exists int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM group_dm_attachments WHERE group_message_id=? AND file_key_index=?`, a.GroupMessageID, *a.FileKeyIndex).Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		return pkg.ErrConflict
	}
	if _, err = tx.ExecContext(ctx, insert, args...); err != nil {
		return err
	}
	return tx.Commit()
}
