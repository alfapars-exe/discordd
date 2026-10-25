package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteGroupDMRepo struct{ db database.TxQuerier }

func NewSQLiteGroupDMRepo(db database.TxQuerier) GroupDMRepository { return &sqliteGroupDMRepo{db: db} }

func (r *sqliteGroupDMRepo) Create(ctx context.Context, group *models.GroupDM, memberIDs []string) error {
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("group create requires transaction-capable database")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `INSERT INTO group_dm_channels(id,owner_id,name,key_epoch,call_room_key) VALUES(?,?,?,?,?)`, group.ID, group.OwnerID, group.Name, group.KeyEpoch, group.CallRoomKey); err != nil {
		return fmt.Errorf("create group: %w", err)
	}
	for _, id := range memberIDs {
		if _, err = tx.ExecContext(ctx, `INSERT INTO group_dm_members(group_id,user_id) VALUES(?,?)`, group.ID, id); err != nil {
			return fmt.Errorf("add group member: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO group_dm_reads(group_id,user_id) VALUES(?,?)`, group.ID, id); err != nil {
			return fmt.Errorf("create group read state: %w", err)
		}
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	return r.db.QueryRowContext(ctx, `SELECT created_at,updated_at FROM group_dm_channels WHERE id=?`, group.ID).Scan(&group.CreatedAt, &group.UpdatedAt)
}

func (r *sqliteGroupDMRepo) GetByID(ctx context.Context, id string) (*models.GroupDM, error) {
	g := &models.GroupDM{}
	err := r.db.QueryRowContext(ctx, `SELECT id,owner_id,name,icon_url,key_epoch,call_room_key,created_at,updated_at FROM group_dm_channels WHERE id=?`, id).Scan(&g.ID, &g.OwnerID, &g.Name, &g.IconURL, &g.KeyEpoch, &g.CallRoomKey, &g.CreatedAt, &g.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return g, nil
}
func (r *sqliteGroupDMRepo) ListForUser(ctx context.Context, userID string) ([]models.GroupDM, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT g.id,g.owner_id,g.name,g.icon_url,g.key_epoch,g.call_room_key,g.created_at,g.updated_at FROM group_dm_channels g JOIN group_dm_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.GroupDM{}
	for rows.Next() {
		var g models.GroupDM
		if err := rows.Scan(&g.ID, &g.OwnerID, &g.Name, &g.IconURL, &g.KeyEpoch, &g.CallRoomKey, &g.CreatedAt, &g.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
func (r *sqliteGroupDMRepo) ListMemberIDs(ctx context.Context, groupID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT user_id FROM group_dm_members WHERE group_id=? ORDER BY joined_at,user_id`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
func (r *sqliteGroupDMRepo) IsMember(ctx context.Context, groupID, userID string) (bool, error) {
	var n int
	err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM group_dm_members WHERE group_id=? AND user_id=?`, groupID, userID).Scan(&n)
	return n > 0, err
}
func (r *sqliteGroupDMRepo) AddMember(ctx context.Context, groupID, userID string) (int64, error) {
	return r.changeMember(ctx, groupID, userID, true)
}
func (r *sqliteGroupDMRepo) RemoveMember(ctx context.Context, groupID, userID string) (int64, error) {
	return r.changeMember(ctx, groupID, userID, false)
}
func (r *sqliteGroupDMRepo) changeMember(ctx context.Context, groupID, userID string, add bool) (int64, error) {
	db := database.RawDB(r.db)
	if db == nil {
		return 0, fmt.Errorf("membership change requires transaction")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockGroupDM(ctx, tx, groupID); err != nil {
		return 0, err
	}
	var result sql.Result
	if add {
		result, err = tx.ExecContext(ctx, `INSERT INTO group_dm_members(group_id,user_id) VALUES(?,?) ON CONFLICT(group_id,user_id) DO NOTHING`, groupID, userID)
	} else {
		result, err = tx.ExecContext(ctx, `DELETE FROM group_dm_members WHERE group_id=? AND user_id=?`, groupID, userID)
	}
	if err != nil {
		return 0, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if changed == 0 {
		return 0, pkg.ErrConflict
	}
	if add {
		_, err = tx.ExecContext(ctx, `INSERT INTO group_dm_reads(group_id,user_id,last_read_source_sequence) SELECT ?,?,last_source_sequence FROM group_dm_channels WHERE id=? ON CONFLICT(group_id,user_id) DO NOTHING`, groupID, userID, groupID)
	} else {
		_, err = tx.ExecContext(ctx, `DELETE FROM group_dm_reads WHERE group_id=? AND user_id=?`, groupID, userID)
	}
	if err != nil {
		return 0, err
	}
	result, err = tx.ExecContext(ctx, `UPDATE group_dm_channels SET key_epoch=key_epoch+1,updated_at=CURRENT_TIMESTAMP WHERE id=?`, groupID)
	if err != nil {
		return 0, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	if updated == 0 {
		return 0, pkg.ErrNotFound
	}
	var epoch int64
	if err = tx.QueryRowContext(ctx, `SELECT key_epoch FROM group_dm_channels WHERE id=?`, groupID).Scan(&epoch); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return epoch, nil
}
func (r *sqliteGroupDMRepo) UpdateProfile(ctx context.Context, id, name string, icon *string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE group_dm_channels SET name=?,icon_url=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`, name, icon, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return pkg.ErrNotFound
	}
	return nil
}
func (r *sqliteGroupDMRepo) TransferOwner(ctx context.Context, id, userID string) error {
	res, err := r.db.ExecContext(ctx, `UPDATE group_dm_channels SET owner_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND EXISTS(SELECT 1 FROM group_dm_members WHERE group_id=? AND user_id=?)`, userID, id, id, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return pkg.ErrNotFound
	}
	return nil
}
func (r *sqliteGroupDMRepo) Delete(ctx context.Context, id string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM group_dm_channels WHERE id=?`, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return pkg.ErrNotFound
	}
	return nil
}
func (r *sqliteGroupDMRepo) CreateMessage(ctx context.Context, m *models.GroupDMMessage) error {
	if m.ID == "" && m.SendRequestID == "" {
		id, err := generateID()
		if err != nil {
			return err
		}
		m.ID = id
	}
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("group message create requires transaction")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Every send path, including legacy requests, validates membership/epoch
	// while holding the same group-first lock as member and read changes.
	allowed, lockErr := tx.ExecContext(ctx, `UPDATE group_dm_channels SET key_epoch=key_epoch WHERE id=? AND key_epoch=? AND EXISTS(SELECT 1 FROM group_dm_members WHERE group_id=? AND user_id=?)`, m.GroupID, m.KeyEpoch, m.GroupID, m.UserID)
	if lockErr != nil {
		return lockErr
	}
	n, lockErr := allowed.RowsAffected()
	if lockErr != nil {
		return lockErr
	}
	if n != 1 {
		return pkg.ErrConflict
	}

	if m.SendRequestID != "" {
		locked, lockErr := tx.ExecContext(ctx, `UPDATE group_dm_send_operations SET phase=phase WHERE group_id=? AND user_id=? AND request_id=? AND phase='prepared' AND cancelled_at IS NULL`, m.GroupID, m.UserID, m.SendRequestID)
		if lockErr != nil {
			return lockErr
		}
		n, lockErr := locked.RowsAffected()
		if lockErr != nil {
			return lockErr
		}
		if n != 1 {
			return pkg.ErrConflict
		}
		op, lockErr := readGroupSend(ctx, tx, m.GroupID, m.UserID, m.SendRequestID)
		if lockErr != nil {
			return lockErr
		}
		if m.ID != "" && m.ID != op.MessageID {
			return pkg.ErrConflict
		}
		m.ID = op.MessageID

	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO group_dm_messages(id,group_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata,key_epoch,reply_to_id,source_sequence) VALUES(?,?,?,?,?,?,?,?,?,?,?)`, m.ID, m.GroupID, m.UserID, m.Content, m.EncryptionVersion, m.Ciphertext, m.SenderDeviceID, m.E2EEMetadata, m.KeyEpoch, m.ReplyToID, m.SourceSequence); err != nil {
		return err
	}
	if err = tx.QueryRowContext(ctx, `SELECT created_at,source_sequence FROM group_dm_messages WHERE id=?`, m.ID).Scan(&m.CreatedAt, &m.SourceSequence); err != nil {
		return err
	}
	if err := insertGroupMessageNotifications(ctx, tx, m); err != nil {
		return err
	}
	if err := markGroupNotificationsRead(ctx, tx, m.GroupID, m.UserID, m.SourceSequence); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE group_dm_reads SET last_read_source_sequence=CASE WHEN last_read_source_sequence<? THEN ? ELSE last_read_source_sequence END WHERE group_id=? AND user_id=?`, m.SourceSequence, m.SourceSequence, m.GroupID, m.UserID); err != nil {
		return err
	}
	if err := refreshGroupReadCounts(ctx, tx, m.GroupID); err != nil {
		return err
	}

	if m.SendRequestID != "" {
		if _, err = tx.ExecContext(ctx, `UPDATE group_dm_send_operations SET phase='committed',updated_at=CURRENT_TIMESTAMP WHERE group_id=? AND user_id=? AND request_id=?`, m.GroupID, m.UserID, m.SendRequestID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (r *sqliteGroupDMRepo) GetMessage(ctx context.Context, groupID, messageID string) (*models.GroupDMMessage, error) {
	m := &models.GroupDMMessage{}
	err := r.db.QueryRowContext(ctx, `SELECT id,group_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata,key_epoch,reply_to_id,edited_at,created_at,source_sequence FROM group_dm_messages WHERE id=? AND group_id=?`, messageID, groupID).Scan(&m.ID, &m.GroupID, &m.UserID, &m.Content, &m.EncryptionVersion, &m.Ciphertext, &m.SenderDeviceID, &m.E2EEMetadata, &m.KeyEpoch, &m.ReplyToID, &m.EditedAt, &m.CreatedAt, &m.SourceSequence)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return m, nil
}
func (r *sqliteGroupDMRepo) GetMessageByID(ctx context.Context, messageID string) (*models.GroupDMMessage, error) {
	m := &models.GroupDMMessage{}
	err := r.db.QueryRowContext(ctx, `SELECT id,group_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata,key_epoch,reply_to_id,edited_at,created_at,source_sequence FROM group_dm_messages WHERE id=?`, messageID).Scan(&m.ID, &m.GroupID, &m.UserID, &m.Content, &m.EncryptionVersion, &m.Ciphertext, &m.SenderDeviceID, &m.E2EEMetadata, &m.KeyEpoch, &m.ReplyToID, &m.EditedAt, &m.CreatedAt, &m.SourceSequence)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return m, nil
}
func (r *sqliteGroupDMRepo) ListMessages(ctx context.Context, groupID, beforeID string, limit int) ([]models.GroupDMMessage, error) {
	q := `SELECT id,group_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata,key_epoch,reply_to_id,edited_at,created_at,source_sequence FROM group_dm_messages WHERE group_id=?`
	args := []any{groupID}
	if beforeID != "" {
		q += ` AND EXISTS (SELECT 1 FROM group_dm_messages anchor WHERE anchor.id=? AND anchor.group_id=?
 AND group_dm_messages.source_sequence<anchor.source_sequence)`
		args = append(args, beforeID, groupID)
	}
	q += ` ORDER BY source_sequence DESC LIMIT ?`
	args = append(args, limit)
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.GroupDMMessage{}
	for rows.Next() {
		var m models.GroupDMMessage
		if err := rows.Scan(&m.ID, &m.GroupID, &m.UserID, &m.Content, &m.EncryptionVersion, &m.Ciphertext, &m.SenderDeviceID, &m.E2EEMetadata, &m.KeyEpoch, &m.ReplyToID, &m.EditedAt, &m.CreatedAt, &m.SourceSequence); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// GetMessagesAround returns an ASC, bounded window centered on a message that
// belongs to this group. Durable source order survives timestamp ties and deletions.
func (r *sqliteGroupDMRepo) GetMessagesAround(ctx context.Context, groupID, anchorID string, limit int) ([]models.GroupDMMessage, bool, bool, error) {
	var exists int
	if err := r.db.QueryRowContext(ctx, `SELECT 1 FROM group_dm_messages WHERE id=? AND group_id=?`, anchorID, groupID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, false, false, pkg.ErrNotFound
		}
		return nil, false, false, err
	}
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	selectColumns := `SELECT id,group_id,user_id,content,encryption_version,ciphertext,sender_device_id,e2ee_metadata,key_epoch,reply_to_id,edited_at,created_at,source_sequence FROM group_dm_messages WHERE group_id=? AND `
	read := func(where, order string, args ...any) ([]models.GroupDMMessage, error) {
		rows, err := r.db.QueryContext(ctx, selectColumns+where+order, args...)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		items := make([]models.GroupDMMessage, 0, len(args))
		for rows.Next() {
			var item models.GroupDMMessage
			if err := rows.Scan(&item.ID, &item.GroupID, &item.UserID, &item.Content, &item.EncryptionVersion, &item.Ciphertext, &item.SenderDeviceID, &item.E2EEMetadata, &item.KeyEpoch, &item.ReplyToID, &item.EditedAt, &item.CreatedAt, &item.SourceSequence); err != nil {
				return nil, err
			}
			items = append(items, item)
		}
		return items, rows.Err()
	}
	half := limit / 2
	afterCount := limit - half
	older, err := read(`source_sequence<(SELECT source_sequence FROM group_dm_messages WHERE id=? AND group_id=?)`, ` ORDER BY source_sequence DESC LIMIT ?`, groupID, anchorID, groupID, half+1)
	if err != nil {
		return nil, false, false, err
	}
	hasMoreBefore := len(older) > half
	if hasMoreBefore {
		older = older[:half]
	}
	newer, err := read(`source_sequence>=(SELECT source_sequence FROM group_dm_messages WHERE id=? AND group_id=?)`, ` ORDER BY source_sequence ASC LIMIT ?`, groupID, anchorID, groupID, afterCount+1)
	if err != nil {
		return nil, false, false, err
	}
	hasMoreAfter := len(newer) > afterCount
	if hasMoreAfter {
		newer = newer[:afterCount]
	}
	out := make([]models.GroupDMMessage, 0, len(older)+len(newer))
	for i := len(older) - 1; i >= 0; i-- {
		out = append(out, older[i])
	}
	out = append(out, newer...)
	return out, hasMoreBefore, hasMoreAfter, nil
}

func (r *sqliteGroupDMRepo) UpdateMessage(ctx context.Context, groupID, messageID, userID string, req *models.UpdateGroupDMMessageRequest) error {
	res, err := r.db.ExecContext(ctx, `UPDATE group_dm_messages SET content=NULL,ciphertext=?,sender_device_id=?,e2ee_metadata=?,key_epoch=?,edited_at=CURRENT_TIMESTAMP WHERE id=? AND group_id=? AND user_id=?`, req.Ciphertext, req.SenderDeviceID, req.E2EEMetadata, req.KeyEpoch, messageID, groupID, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return pkg.ErrNotFound
	}
	return nil
}
func (r *sqliteGroupDMRepo) DeleteMessage(ctx context.Context, groupID, messageID, userID string) error {
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("group message delete requires transaction")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockGroupDM(ctx, tx, groupID); err != nil {
		return err
	}
	var created time.Time
	if err = tx.QueryRowContext(ctx, `SELECT created_at FROM group_dm_messages WHERE id=? AND group_id=? AND user_id=?`, messageID, groupID, userID).Scan(&created); errors.Is(err, sql.ErrNoRows) {
		return pkg.ErrNotFound
	} else if err != nil {
		return err
	}

	if _, err = tx.ExecContext(ctx, `UPDATE group_dm_send_operations SET phase='deleted',failed_indices='[]',updated_at=CURRENT_TIMESTAMP WHERE message_id=?`, messageID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM group_dm_messages WHERE id=?`, messageID); err != nil {
		return err
	}
	if err := refreshGroupReadCounts(ctx, tx, groupID); err != nil {
		return err
	}
	return tx.Commit()
}
func (r *sqliteGroupDMRepo) ToggleReaction(ctx context.Context, messageID, userID, emoji string) (bool, error) {
	res, err := r.db.ExecContext(ctx, `DELETE FROM group_dm_reactions WHERE group_message_id=? AND user_id=? AND emoji=?`, messageID, userID, emoji)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	id, err := generateID()
	if err != nil {
		return false, err
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO group_dm_reactions(id,group_message_id,user_id,emoji) VALUES(?,?,?,?)`, id, messageID, userID, emoji)
	return err == nil, err
}
func (r *sqliteGroupDMRepo) GetReactions(ctx context.Context, messageIDs []string) (map[string][]models.ReactionGroup, error) {
	out := make(map[string][]models.ReactionGroup)
	if len(messageIDs) == 0 {
		return out, nil
	}
	q := `SELECT group_message_id,emoji,user_id FROM group_dm_reactions WHERE group_message_id IN (`
	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		if i > 0 {
			q += ","
		}
		q += "?"
		args[i] = id
	}
	q += `) ORDER BY created_at`
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var mid, emoji, uid string
		if err := rows.Scan(&mid, &emoji, &uid); err != nil {
			return nil, err
		}
		groups := out[mid]
		idx := -1
		for i := range groups {
			if groups[i].Emoji == emoji {
				idx = i
				break
			}
		}
		if idx < 0 {
			groups = append(groups, models.ReactionGroup{Emoji: emoji})
			idx = len(groups) - 1
		}
		groups[idx].Count++
		groups[idx].Users = append(groups[idx].Users, uid)
		out[mid] = groups
	}
	return out, rows.Err()
}
func (r *sqliteGroupDMRepo) MarkRead(ctx context.Context, groupID, userID string, messageID *string, expectedEpoch ...int64) error {
	_, err := r.setReadCursor(ctx, groupID, userID, messageID, false, expectedEpoch...)
	return err
}

func (r *sqliteGroupDMRepo) MarkUnreadFrom(ctx context.Context, groupID, userID, messageID string, expectedEpoch ...int64) (*models.GroupDMReadState, error) {
	return r.setReadCursor(ctx, groupID, userID, &messageID, true, expectedEpoch...)
}

func (r *sqliteGroupDMRepo) GetReadState(ctx context.Context, groupID, userID string) (*models.GroupDMReadState, error) {
	return groupReadState(ctx, r.db, groupID, userID)
}

func (r *sqliteGroupDMRepo) UnreadCount(ctx context.Context, groupID, userID string) (int, error) {
	var n int
	err := r.db.QueryRowContext(ctx, `SELECT unread_count FROM group_dm_reads WHERE group_id=? AND user_id=?`, groupID, userID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, pkg.ErrNotFound
	}
	return n, err
}

func (r *sqliteGroupDMRepo) CreateAttachment(ctx context.Context, a *models.GroupDMAttachment) error {
	if a.ID == "" {
		id, err := generateID()
		if err != nil {
			return err
		}
		a.ID = id
	}
	err := r.insertGroupAttachment(ctx, a)
	if err != nil {
		return err
	}
	a.CreatedAt = time.Now().UTC()
	var created time.Time
	// The insert already committed. A failed timestamp read-back must not
	// turn a persisted attachment into a failed upload and remove its file.
	if r.db.QueryRowContext(ctx, `SELECT created_at FROM group_dm_attachments WHERE id=?`, a.ID).Scan(&created) == nil {
		a.CreatedAt = created
	}
	return nil
}
func (r *sqliteGroupDMRepo) GetAttachments(ctx context.Context, messageIDs []string) (map[string][]models.GroupDMAttachment, error) {
	out := make(map[string][]models.GroupDMAttachment)
	if len(messageIDs) == 0 {
		return out, nil
	}
	q := `SELECT id,group_message_id,filename,file_url,file_size,mime_type,created_at,file_key_index FROM group_dm_attachments WHERE group_message_id IN (`
	args := make([]any, len(messageIDs))
	for i, id := range messageIDs {
		if i > 0 {
			q += ","
		}
		q += "?"
		args[i] = id
	}
	q += `) ORDER BY created_at,id`
	rows, err := r.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a models.GroupDMAttachment
		if err := rows.Scan(&a.ID, &a.GroupMessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt, &a.FileKeyIndex); err != nil {
			return nil, err
		}
		out[a.GroupMessageID] = append(out[a.GroupMessageID], a)
	}
	return out, rows.Err()
}
func (r *sqliteGroupDMRepo) GetAttachmentByFileURL(ctx context.Context, fileURL string) (*models.GroupDMAttachment, error) {
	a := &models.GroupDMAttachment{}
	err := r.db.QueryRowContext(ctx, `SELECT id,group_message_id,filename,file_url,file_size,mime_type,created_at,file_key_index FROM group_dm_attachments WHERE file_url=?`, fileURL).Scan(&a.ID, &a.GroupMessageID, &a.Filename, &a.FileURL, &a.FileSize, &a.MimeType, &a.CreatedAt, &a.FileKeyIndex)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return a, nil
}
func (r *sqliteGroupDMRepo) GetAttachmentFileURLsByGroup(ctx context.Context, groupID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT a.file_url FROM group_dm_attachments a JOIN group_dm_messages m ON m.id=a.group_message_id WHERE m.group_id=?`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}
