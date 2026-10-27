package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const channelIncomingMessagePayload = `{"action":"incoming_message","source":"channel"}`

type sqliteChannelMessageNotificationQueue struct {
	db       database.TxQuerier
	postgres bool
}

func NewSQLiteChannelMessageNotificationQueue(db database.TxQuerier) ChannelMessageNotificationQueue {
	return NewChannelMessageNotificationQueueWithDialect(db, database.IsPostgres(db))
}

// NewChannelMessageNotificationQueueWithDialect keeps the parent connection's
// dialect when db is a *sql.Tx (which cannot be introspected by IsPostgres).
func NewChannelMessageNotificationQueueWithDialect(db database.TxQuerier, postgres bool) ChannelMessageNotificationQueue {
	return &sqliteChannelMessageNotificationQueue{db: db, postgres: postgres}
}

func (r *sqliteChannelMessageNotificationQueue) Enqueue(ctx context.Context, messageID, serverID, channelID, actorID string) error {
	// Do not leave work for messages created before any member explicitly
	// opted in. Opt-in is account-synced and absent legacy values are false.
	query := `INSERT INTO channel_message_notification_jobs(message_id,server_id,channel_id,actor_id)
	 SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM server_members sm JOIN user_preferences p ON p.user_id=sm.user_id
	 WHERE sm.server_id=? AND sm.user_id<>? AND CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.notifications.channelMessageNotifications') ELSE 0 END=1)
	 ON CONFLICT(message_id) DO NOTHING`
	if r.postgres {
		query = `INSERT INTO channel_message_notification_jobs(message_id,server_id,channel_id,actor_id)
	 SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM server_members sm JOIN user_preferences p ON p.user_id=sm.user_id
	 WHERE sm.server_id=? AND sm.user_id<>? AND COALESCE((CASE WHEN pg_input_is_valid(p.data,'jsonb') THEN p.data::jsonb ELSE '{}'::jsonb END #>> '{notifications,channelMessageNotifications}')::boolean,false)=true)
	 ON CONFLICT(message_id) DO NOTHING`
	}
	_, err := r.db.ExecContext(ctx, query, messageID, serverID, channelID, actorID, serverID, actorID)
	return err
}

func (r *sqliteChannelMessageNotificationQueue) DeleteByMessageID(ctx context.Context, messageID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM channel_message_notification_jobs WHERE message_id=?`, messageID)
	return err
}

func (r *sqliteChannelMessageNotificationQueue) DeleteByChannelID(ctx context.Context, channelID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM channel_message_notification_jobs WHERE channel_id=?`, channelID)
	return err
}

func (r *sqliteChannelMessageNotificationQueue) NextBatch(ctx context.Context, limit int) (*ChannelMessageNotificationJob, []string, error) {
	if limit < 1 || limit > ChannelMessageNotificationBatchSize {
		return nil, nil, fmt.Errorf("invalid notification batch limit")
	}
	job := &ChannelMessageNotificationJob{}
	nextJobQuery := `SELECT j.message_id,j.server_id,j.channel_id,j.actor_id,j.cursor_user_id,j.last_batch_at
	 FROM channel_message_notification_jobs j JOIN messages m ON m.id=j.message_id AND m.channel_id=j.channel_id AND m.user_id=j.actor_id
	 JOIN channels c ON c.id=j.channel_id AND c.server_id=j.server_id
	 WHERE j.next_attempt_at<=strftime('%Y-%m-%d %H:%M:%f','now')
	 ORDER BY j.last_batch_at ASC,j.created_at ASC,j.message_id ASC LIMIT 1`
	if r.postgres {
		nextJobQuery = `SELECT j.message_id,j.server_id,j.channel_id,j.actor_id,j.cursor_user_id,j.last_batch_at
		 FROM channel_message_notification_jobs j JOIN messages m ON m.id=j.message_id AND m.channel_id=j.channel_id AND m.user_id=j.actor_id
		 JOIN channels c ON c.id=j.channel_id AND c.server_id=j.server_id
		 WHERE j.next_attempt_at<=CURRENT_TIMESTAMP
		 ORDER BY j.last_batch_at ASC,j.created_at ASC,j.message_id ASC LIMIT 1`
	}
	err := r.db.QueryRowContext(ctx, nextJobQuery).Scan(
		&job.MessageID, &job.ServerID, &job.ChannelID, &job.ActorID, &job.CursorUserID, &job.LastBatchAt)
	if err == sql.ErrNoRows {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	query := `SELECT sm.user_id FROM server_members sm JOIN user_preferences p ON p.user_id=sm.user_id
	 JOIN users u ON u.id=sm.user_id AND u.deleted_at IS NULL
	 WHERE sm.server_id=? AND sm.user_id>? AND sm.user_id<>? AND CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.notifications.channelMessageNotifications') ELSE 0 END=1
	 ORDER BY sm.user_id LIMIT ?`
	if r.postgres {
		query = `SELECT sm.user_id FROM server_members sm JOIN user_preferences p ON p.user_id=sm.user_id
	 JOIN users u ON u.id=sm.user_id AND u.deleted_at IS NULL
	 WHERE sm.server_id=? AND sm.user_id>? AND sm.user_id<>? AND COALESCE((CASE WHEN pg_input_is_valid(p.data,'jsonb') THEN p.data::jsonb ELSE '{}'::jsonb END #>> '{notifications,channelMessageNotifications}')::boolean,false)=true
	 ORDER BY sm.user_id LIMIT ?`
	}
	rows, err := r.db.QueryContext(ctx, query, job.ServerID, job.CursorUserID, job.ActorID, limit)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, nil, err
		}
		ids = append(ids, id)
	}
	return job, ids, rows.Err()
}

func (r *sqliteChannelMessageNotificationQueue) SuppressedRecipients(ctx context.Context, job *ChannelMessageNotificationJob, userIDs []string) (map[string]bool, error) {
	out := make(map[string]bool, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	userIDsJSON, err := json.Marshal(userIDs)
	if err != nil {
		return nil, err
	}
	query := `SELECT sm.user_id,
	 EXISTS(SELECT 1 FROM channel_mutes cm WHERE cm.user_id=sm.user_id AND cm.channel_id IN(c.id,c.parent_channel_id) AND (cm.muted_until IS NULL OR cm.muted_until>CURRENT_TIMESTAMP)),
	 EXISTS(SELECT 1 FROM server_mutes mu WHERE mu.user_id=sm.user_id AND mu.server_id=c.server_id AND (mu.muted_until IS NULL OR mu.muted_until>CURRENT_TIMESTAMP)),
	 EXISTS(SELECT 1 FROM friendships f WHERE f.status='blocked' AND ((f.user_id=sm.user_id AND f.friend_id=?) OR (f.user_id=? AND f.friend_id=sm.user_id))),
	 EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.data) THEN COALESCE(json_extract(p.data,'$.privacy.ignoredUsers'),'{}') ELSE '{}' END) WHERE key=? AND value=1)
	 FROM server_members sm JOIN channels c ON c.id=? JOIN user_preferences p ON p.user_id=sm.user_id
	 WHERE sm.server_id=? AND sm.user_id IN (SELECT value FROM json_each(?))`
	args := []any{job.ActorID, job.ActorID, job.ActorID, job.ChannelID, job.ServerID, string(userIDsJSON)}
	if r.postgres {
		query = `SELECT sm.user_id,
		 EXISTS(SELECT 1 FROM channel_mutes cm WHERE cm.user_id=sm.user_id AND cm.channel_id IN(c.id,c.parent_channel_id) AND (cm.muted_until IS NULL OR cm.muted_until>CURRENT_TIMESTAMP)),
		 EXISTS(SELECT 1 FROM server_mutes mu WHERE mu.user_id=sm.user_id AND mu.server_id=c.server_id AND (mu.muted_until IS NULL OR mu.muted_until>CURRENT_TIMESTAMP)),
		 EXISTS(SELECT 1 FROM friendships f WHERE f.status='blocked' AND ((f.user_id=sm.user_id AND f.friend_id=?) OR (f.user_id=? AND f.friend_id=sm.user_id))),
		 COALESCE((CASE WHEN pg_input_is_valid(p.data,'jsonb') THEN p.data::jsonb ELSE '{}'::jsonb END #> '{privacy,ignoredUsers}') ->> ?,'false')='true'
		 FROM server_members sm JOIN channels c ON c.id=? JOIN user_preferences p ON p.user_id=sm.user_id
		 WHERE sm.server_id=? AND sm.user_id IN (SELECT jsonb_array_elements_text(?::jsonb))`
		args[len(args)-1] = string(userIDsJSON)
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var channelMuted, serverMuted, blocked, ignored bool
		if err = rows.Scan(&id, &channelMuted, &serverMuted, &blocked, &ignored); err != nil {
			return nil, err
		}
		out[id] = channelMuted || serverMuted || blocked || ignored
	}
	return out, rows.Err()
}

// CommitBatch is compare-and-swap protected for multiple app instances. A
// worker may spend time resolving live ACLs; only the worker holding the old
// cursor can insert and advance. Stable IDs make retry after a lost response
// idempotent. Inbox writes and cursor movement commit together.
func (r *sqliteChannelMessageNotificationQueue) CommitBatch(ctx context.Context, job *ChannelMessageNotificationJob, nextCursor string, done bool, eligible []*models.Notification) ([]*models.Notification, bool, error) {
	db := database.RawDB(r.db)
	if db == nil { // tx-scoped queue is used only for Enqueue.
		return nil, false, fmt.Errorf("channel notification batch requires database connection")
	}
	// PostgreSQL ACL and user-policy writers share advisory transaction fences
	// with this fanout. Acquire those fences before reads, under READ COMMITTED
	// so every later statement sees any writer that won the lock first. This
	// covers missing-row INSERT phantoms that SERIALIZABLE + row locks miss.
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	if database.IsPostgres(db) {
		// Account retirement takes PG005's exclusive global write barrier
		// before cascades. Join its shared barrier first, so retirement and this
		// fanout cannot deadlock while each is acquiring the narrower fences.
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock_shared(7341982002)`); err != nil {
			return nil, false, err
		}
		// Cascading channel/server writers acquire the server fence before
		// per-user mute fences, so use the same global -> server -> user order.
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(?,0))`, job.ServerID); err != nil {
			return nil, false, err
		}
		userIDs := make(map[string]struct{}, len(eligible)+1)
		userIDs[job.ActorID] = struct{}{}
		for _, n := range eligible {
			userIDs[n.UserID] = struct{}{}
		}
		orderedUsers := make([]string, 0, len(userIDs))
		for id := range userIDs {
			orderedUsers = append(orderedUsers, id)
		}
		sort.Strings(orderedUsers)
		if len(orderedUsers) > 0 {
			orderedUsersJSON, marshalErr := json.Marshal(orderedUsers)
			if marshalErr != nil {
				return nil, false, marshalErr
			}
			rows, lockErr := tx.QueryContext(ctx, `WITH sorted_users AS MATERIALIZED (SELECT user_id FROM jsonb_array_elements_text(?::jsonb) AS policy(user_id) ORDER BY user_id) SELECT pg_advisory_xact_lock(hashtextextended('user:' || sorted_users.user_id,0)) FROM sorted_users`, string(orderedUsersJSON))
			if lockErr != nil {
				return nil, false, lockErr
			}
			for rows.Next() {
			} // Drain the result to ensure each row lock is acquired.
			lockErr = rows.Err()
			_ = rows.Close()
			if lockErr != nil {
				return nil, false, lockErr
			}
		}
	}
	advance := `UPDATE channel_message_notification_jobs SET cursor_user_id=?,last_batch_at=strftime('%Y-%m-%d %H:%M:%f','now'),attempt_count=0,next_attempt_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE message_id=? AND cursor_user_id=? AND last_batch_at=?`
	if database.IsPostgres(db) {
		advance = `UPDATE channel_message_notification_jobs SET cursor_user_id=?,last_batch_at=CURRENT_TIMESTAMP,attempt_count=0,next_attempt_at=CURRENT_TIMESTAMP WHERE message_id=? AND cursor_user_id=? AND last_batch_at=?`
	}
	result, err := tx.ExecContext(ctx, advance, nextCursor, job.MessageID, job.CursorUserID, job.LastBatchAt)
	if err != nil {
		return nil, false, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return nil, false, err
	}
	if changed != 1 {
		return nil, false, nil
	}
	readable, err := channelReadAccessInTx(ctx, tx, db, job, eligible)
	if err != nil {
		return nil, false, err
	}
	created := make([]*models.Notification, 0, len(eligible))
	for _, n := range eligible {
		if !readable[n.UserID] {
			continue
		}
		identity, _ := json.Marshal([]string{"channel", n.UserID, job.ChannelID, job.MessageID})
		n.ID = fmt.Sprintf("channel-message-%x", sha256.Sum256(identity))
		n.Kind = models.NotificationKindSystem
		n.ActorID = &job.ActorID
		n.ServerID = &job.ServerID
		n.ChannelID = &job.ChannelID
		n.MessageID = &job.MessageID
		n.Payload = json.RawMessage(channelIncomingMessagePayload)
		query := `INSERT INTO notifications(id,user_id,kind,actor_id,server_id,channel_id,message_id,payload)
		 SELECT ?,?,'system',?,?,?,?,? WHERE EXISTS(
		 SELECT 1 FROM messages m JOIN channels c ON c.id=m.channel_id JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=?
		 JOIN users u ON u.id=sm.user_id AND u.deleted_at IS NULL
		 JOIN user_preferences p ON p.user_id=sm.user_id WHERE m.id=? AND m.channel_id=? AND m.user_id=?
		 AND CASE WHEN json_valid(p.data) THEN json_extract(p.data,'$.notifications.channelMessageNotifications') ELSE 0 END=1
		 AND NOT EXISTS(SELECT 1 FROM channel_mutes cm WHERE cm.user_id=sm.user_id AND cm.channel_id IN (c.id,c.parent_channel_id) AND (cm.muted_until IS NULL OR cm.muted_until>CURRENT_TIMESTAMP))
		 AND NOT EXISTS(SELECT 1 FROM server_mutes smu WHERE smu.user_id=sm.user_id AND smu.server_id=c.server_id AND (smu.muted_until IS NULL OR smu.muted_until>CURRENT_TIMESTAMP))
		 AND NOT EXISTS(SELECT 1 FROM friendships f WHERE f.status='blocked' AND ((f.user_id=sm.user_id AND f.friend_id=m.user_id) OR (f.user_id=m.user_id AND f.friend_id=sm.user_id)))
		 AND NOT EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(p.data) THEN COALESCE(json_extract(p.data,'$.privacy.ignoredUsers'),'{}') ELSE '{}' END) WHERE key=? AND value=1)
		 AND NOT EXISTS(SELECT 1 FROM notifications old WHERE old.user_id=sm.user_id AND old.message_id=m.id AND old.kind IN ('mention','reply')))
		 ON CONFLICT(id) DO NOTHING`
		if database.IsPostgres(db) {
			query = `INSERT INTO notifications(id,user_id,kind,actor_id,server_id,channel_id,message_id,payload)
			 SELECT ?,?,'system',?,?,?,?,? WHERE EXISTS(
			 SELECT 1 FROM messages m JOIN channels c ON c.id=m.channel_id JOIN server_members sm ON sm.server_id=c.server_id AND sm.user_id=?
			 JOIN users u ON u.id=sm.user_id AND u.deleted_at IS NULL
			 JOIN user_preferences p ON p.user_id=sm.user_id WHERE m.id=? AND m.channel_id=? AND m.user_id=?
			 AND COALESCE((CASE WHEN pg_input_is_valid(p.data,'jsonb') THEN p.data::jsonb ELSE '{}'::jsonb END #>> '{notifications,channelMessageNotifications}')::boolean,false)=true
			 AND NOT EXISTS(SELECT 1 FROM channel_mutes cm WHERE cm.user_id=sm.user_id AND cm.channel_id IN (c.id,c.parent_channel_id) AND (cm.muted_until IS NULL OR cm.muted_until>CURRENT_TIMESTAMP))
			 AND NOT EXISTS(SELECT 1 FROM server_mutes smu WHERE smu.user_id=sm.user_id AND smu.server_id=c.server_id AND (smu.muted_until IS NULL OR smu.muted_until>CURRENT_TIMESTAMP))
			 AND NOT EXISTS(SELECT 1 FROM friendships f WHERE f.status='blocked' AND ((f.user_id=sm.user_id AND f.friend_id=m.user_id) OR (f.user_id=m.user_id AND f.friend_id=sm.user_id)))
			 AND COALESCE((CASE WHEN pg_input_is_valid(p.data,'jsonb') THEN p.data::jsonb ELSE '{}'::jsonb END #> '{privacy,ignoredUsers}') ->> ?,'false') <> 'true'
			 AND NOT EXISTS(SELECT 1 FROM notifications old WHERE old.user_id=sm.user_id AND old.message_id=m.id AND old.kind IN ('mention','reply')))
			 ON CONFLICT(id) DO NOTHING`
		}
		res, execErr := tx.ExecContext(ctx, query, n.ID, n.UserID, n.ActorID, n.ServerID, n.ChannelID, n.MessageID, string(n.Payload), n.UserID, job.MessageID, job.ChannelID, job.ActorID, job.ActorID)
		if execErr != nil {
			return nil, false, execErr
		}
		rows, rowsErr := res.RowsAffected()
		if rowsErr != nil {
			return nil, false, rowsErr
		}
		if rows == 1 {
			var createdAt string
			if err = tx.QueryRowContext(ctx, `SELECT created_at FROM notifications WHERE id=?`, n.ID).Scan(&createdAt); err != nil {
				return nil, false, err
			}
			n.CreatedAt = dbTextToRFC3339(createdAt)
			created = append(created, n)
		}
	}
	if done {
		if _, err = tx.ExecContext(ctx, `DELETE FROM channel_message_notification_jobs WHERE message_id=? AND cursor_user_id=?`, job.MessageID, nextCursor); err != nil {
			return nil, false, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return created, true, nil
}

// FailBatch persists bounded exponential retry delay while leaving the cursor
// untouched. A failing job therefore backs off and cannot starve ready jobs.
func (r *sqliteChannelMessageNotificationQueue) FailBatch(ctx context.Context, job *ChannelMessageNotificationJob) error {
	query := `UPDATE channel_message_notification_jobs SET attempt_count=attempt_count+1,
	 next_attempt_at=strftime('%Y-%m-%d %H:%M:%f','now','+'||MIN(300,(1 << MIN(attempt_count,8)))||' seconds')
	 WHERE message_id=? AND cursor_user_id=? AND last_batch_at=?`
	if r.postgres {
		query = `UPDATE channel_message_notification_jobs SET attempt_count=attempt_count+1,
	 next_attempt_at=CURRENT_TIMESTAMP + (LEAST(300,(1::bigint << LEAST(attempt_count,8))) * INTERVAL '1 second')
	 WHERE message_id=? AND cursor_user_id=? AND last_batch_at=?`
	}
	_, err := r.db.ExecContext(ctx, query, job.MessageID, job.CursorUserID, job.LastBatchAt)
	return err
}

// channelReadAccessInTx recomputes the exact channel ACL from rows in the
// notification transaction. Role assignments, roles and overrides are read
// in a bounded pair of queries; PostgreSQL serializable isolation protects
// against concurrent permission writes through the shared server fence taken
// by CommitBatch; SQLite's writer lock already serializes permission changes.
func channelReadAccessInTx(ctx context.Context, tx *sql.Tx, db *sql.DB, job *ChannelMessageNotificationJob, eligible []*models.Notification) (map[string]bool, error) {
	readable := make(map[string]bool, len(eligible))
	if len(eligible) == 0 {
		return readable, nil
	}
	channelID := job.ChannelID
	var typ string
	var parent sql.NullString
	if err := tx.QueryRowContext(ctx, `SELECT type,parent_channel_id FROM channels WHERE id=? AND server_id=?`, job.ChannelID, job.ServerID).Scan(&typ, &parent); err != nil {
		return nil, err
	}
	if typ == string(models.ChannelTypeThread) {
		if !parent.Valid || parent.String == "" {
			return readable, nil
		}
		var parentType, parentServer string
		if err := tx.QueryRowContext(ctx, `SELECT type,server_id FROM channels WHERE id=?`, parent.String).Scan(&parentType, &parentServer); err != nil {
			return nil, err
		}
		if parentType != string(models.ChannelTypeText) || parentServer != job.ServerID {
			return readable, nil
		}
		channelID = parent.String
	}
	eligibleIDs := make([]string, 0, len(eligible))
	for _, n := range eligible {
		eligibleIDs = append(eligibleIDs, n.UserID)
	}
	eligibleIDsJSON, err := json.Marshal(eligibleIDs)
	if err != nil {
		return nil, err
	}
	roleQuery := `SELECT ur.user_id,r.id,r.permissions FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.server_id=? AND ur.user_id IN (SELECT value FROM json_each(?))`
	roleArgs := []any{job.ServerID, string(eligibleIDsJSON)}
	if database.IsPostgres(db) {
		roleQuery = `SELECT ur.user_id,r.id,r.permissions FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.server_id=? AND ur.user_id IN (SELECT jsonb_array_elements_text(?::jsonb))`
	}
	rows, err := tx.QueryContext(ctx, roleQuery, roleArgs...)
	if err != nil {
		return nil, err
	}
	type roleBits struct {
		id          string
		permissions models.Permission
	}
	roles := make(map[string][]roleBits, len(eligible))
	for rows.Next() {
		var userID, roleID string
		var bits int64
		if err = rows.Scan(&userID, &roleID, &bits); err != nil {
			_ = rows.Close()
			return nil, err
		}
		roles[userID] = append(roles[userID], roleBits{roleID, models.Permission(bits)})
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	overrideQuery := `SELECT role_id,allow,deny FROM channel_permissions WHERE channel_id=?`
	rows, err = tx.QueryContext(ctx, overrideQuery, channelID)
	if err != nil {
		return nil, err
	}
	type overrideBits struct{ allow, deny models.Permission }
	overrides := make(map[string]overrideBits)
	for rows.Next() {
		var roleID string
		var allow, deny int64
		if err = rows.Scan(&roleID, &allow, &deny); err != nil {
			_ = rows.Close()
			return nil, err
		}
		b := overrides[roleID]
		b.allow |= models.Permission(allow)
		b.deny |= models.Permission(deny)
		overrides[roleID] = b
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	for _, n := range eligible {
		var base, allow, deny models.Permission
		for _, role := range roles[n.UserID] {
			base |= role.permissions
			b := overrides[role.id]
			allow |= b.allow
			deny |= b.deny
		}
		if models.PermCanReadChannel(models.EffectiveChannelPermission(base, allow, deny)) {
			readable[n.UserID] = true
		}
	}
	return readable, nil
}
