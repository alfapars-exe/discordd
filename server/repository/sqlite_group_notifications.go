package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const groupIncomingMessagePayload = `{"action":"incoming_message","source":"group"}`

// The caller holds the group membership/key-epoch lock. Failure rolls back the
// source message and its read counts together; no body enters the inbox.
func insertGroupMessageNotifications(ctx context.Context, tx *sql.Tx, m *models.GroupDMMessage) error {
	rows, err := tx.QueryContext(ctx, `SELECT gm.user_id FROM group_dm_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=? AND gm.user_id<>? AND u.deleted_at IS NULL`, m.GroupID, m.UserID)
	if err != nil {
		return err
	}
	var recipients []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		recipients = append(recipients, id)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	const query = `INSERT INTO notifications(id,user_id,kind,actor_id,message_id,group_dm_channel_id,payload) VALUES(?,?,'system',?,?,?,?) ON CONFLICT(id) DO NOTHING`
	for _, recipient := range recipients {
		identity, _ := json.Marshal([]string{"group", recipient, m.GroupID, m.ID})
		id := fmt.Sprintf("group-message-%x", sha256.Sum256(identity))
		if _, err = tx.ExecContext(ctx, query, id, recipient, m.UserID, m.ID, m.GroupID, groupIncomingMessagePayload); err != nil {
			return err
		}
	}
	return nil
}

// Acknowledge the effective durable source watermark, never timestamps or IDs.
// Mark-unread does not resurrect dismissed inbox rows.
func markGroupNotificationsRead(ctx context.Context, tx *sql.Tx, groupID, userID string, watermark int64) error {
	const query = `UPDATE notifications SET read_at=COALESCE(read_at,CURRENT_TIMESTAMP) WHERE user_id=? AND group_dm_channel_id=? AND kind='system' AND payload=? AND message_id IN(SELECT id FROM group_dm_messages WHERE group_id=? AND source_sequence<=?)`
	_, err := tx.ExecContext(ctx, query, userID, groupID, groupIncomingMessagePayload, groupID, watermark)
	return err
}

// DeliverCommittedGroupNotifications serializes the postcommit metadata push
// with membership removal. No removed membership may receive a push after its
// removal acknowledges. The callback must not perform database operations.
func (r *sqliteGroupDMRepo) DeliverCommittedGroupNotifications(ctx context.Context, groupID, messageID string, deliver func(*models.Notification)) error {
	db := database.RawDB(r.db)
	if db == nil {
		return fmt.Errorf("group notifications require transaction-capable database")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = lockGroupDM(ctx, tx, groupID); err != nil {
		return err
	}
	const query = `SELECT n.id,n.user_id,n.kind,n.actor_id,n.server_id,n.channel_id,n.message_id,n.dm_channel_id,n.payload,n.read_at,n.created_at,n.group_dm_channel_id,
 u.id,u.username,u.display_name,u.avatar_url,u.status,u.custom_status,u.created_at
 FROM notifications n JOIN group_dm_members gm ON gm.group_id=n.group_dm_channel_id AND gm.user_id=n.user_id JOIN group_dm_messages src ON src.group_id=gm.group_id AND src.id=n.message_id AND src.user_id=n.actor_id LEFT JOIN users u ON u.id=n.actor_id
 WHERE n.group_dm_channel_id=? AND n.message_id=? AND n.kind='system' AND n.payload=? AND n.read_at IS NULL`
	rows, err := tx.QueryContext(ctx, query, groupID, messageID, groupIncomingMessagePayload)
	if err != nil {
		return err
	}
	var out []*models.Notification
	for rows.Next() {
		n, scanErr := scanNotificationRow(rows)
		if scanErr != nil {
			_ = rows.Close()
			return scanErr
		}
		out = append(out, n)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return err
	}
	for _, n := range out {
		deliver(n)
	}
	return tx.Commit()
}
