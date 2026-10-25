package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const maxStreamStartServerMembers = 200

type sqliteStreamStartNotificationRepo struct{ db database.TxQuerier }

func NewSQLiteStreamStartNotificationRepo(db database.TxQuerier) StreamStartNotificationRepository {
	return &sqliteStreamStartNotificationRepo{db: db}
}

func (r *sqliteStreamStartNotificationRepo) DueRecipients(ctx context.Context, publicationID, serverID, actorID string, limit int) ([]string, error) {
	if strings.TrimSpace(publicationID) == "" || strings.TrimSpace(serverID) == "" || strings.TrimSpace(actorID) == "" {
		return nil, fmt.Errorf("stream notification requires publication, server, and actor")
	}
	if limit < 1 || limit > maxStreamStartServerMembers {
		limit = maxStreamStartServerMembers
	}
	var memberCount, actorMember, actorActive int
	if err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM server_members WHERE server_id=?`, serverID).Scan(&memberCount); err != nil {
		return nil, fmt.Errorf("stream notification server membership count: %w", err)
	}
	if memberCount > maxStreamStartServerMembers {
		return []string{}, nil
	}
	if err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM server_members WHERE server_id=? AND user_id=?)`, serverID, actorID).Scan(&actorMember); err != nil {
		return nil, fmt.Errorf("stream notification actor membership: %w", err)
	}
	if err := r.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users u WHERE u.id=? AND u.deleted_at IS NULL AND u.is_bot=0 AND u.is_platform_banned=0
		AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`, actorID).Scan(&actorActive); err != nil {
		return nil, fmt.Errorf("stream notification actor status: %w", err)
	}
	if actorMember == 0 || actorActive == 0 {
		return []string{}, nil
	}
	rows, err := r.db.QueryContext(ctx, `SELECT DISTINCT CASE WHEN f.user_id=? THEN f.friend_id ELSE f.user_id END AS friend_id
		FROM friendships f
		JOIN users u ON u.id=CASE WHEN f.user_id=? THEN f.friend_id ELSE f.user_id END
		JOIN server_members sm ON sm.server_id=? AND sm.user_id=u.id
		WHERE f.status='accepted' AND (f.user_id=? OR f.friend_id=?)
		AND u.deleted_at IS NULL AND u.is_bot=0 AND u.is_platform_banned=0
		AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)
		AND NOT EXISTS(SELECT 1 FROM friendships b WHERE b.status='blocked' AND
			((b.user_id=? AND b.friend_id=u.id) OR (b.user_id=u.id AND b.friend_id=?)))
		AND NOT EXISTS(SELECT 1 FROM stream_start_deliveries d WHERE d.publication_id=? AND d.recipient_id=u.id)
		ORDER BY friend_id ASC LIMIT ?`, actorID, actorID, serverID, actorID, actorID, actorID, actorID, publicationID, limit)
	if err != nil {
		return nil, fmt.Errorf("stream notification recipients: %w", err)
	}
	defer rows.Close()
	recipients := make([]string, 0, limit)
	for rows.Next() {
		var recipientID string
		if err := rows.Scan(&recipientID); err != nil {
			return nil, fmt.Errorf("stream notification recipient scan: %w", err)
		}
		recipients = append(recipients, recipientID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("stream notification recipient rows: %w", err)
	}
	return recipients, nil
}

func (r *sqliteStreamStartNotificationRepo) Deliver(ctx context.Context, publicationID, roomName, trackSID, serverID, channelID, actorID, recipientID string, now time.Time) (*models.Notification, error) {
	if strings.TrimSpace(publicationID) == "" || strings.TrimSpace(roomName) == "" || strings.TrimSpace(trackSID) == "" ||
		strings.TrimSpace(serverID) == "" || strings.TrimSpace(channelID) == "" || strings.TrimSpace(actorID) == "" || strings.TrimSpace(recipientID) == "" || actorID == recipientID {
		return nil, fmt.Errorf("invalid stream notification identity")
	}
	rawDB := database.RawDB(r.db)
	if rawDB == nil {
		return nil, fmt.Errorf("stream notification delivery requires raw database connection")
	}
	var delivered *models.Notification
	err := database.WithTx(ctx, rawDB, func(tx *sql.Tx) error {
		// The durable decision is committed with the optional notification.
		// Recording it first also makes opt-outs, blocks, and stale membership
		// decisions non-replayable if the same publication callback is retried.
		decision, err := tx.ExecContext(ctx, `INSERT INTO stream_start_deliveries(publication_id,recipient_id,actor_id)
			VALUES(?,?,?) ON CONFLICT(publication_id,recipient_id) DO NOTHING`, publicationID, recipientID, actorID)
		if err != nil {
			return err
		}
		inserted, err := decision.RowsAffected()
		if err != nil || inserted == 0 {
			return err
		}

		// Match account anonymization's preference-before-membership order,
		preferenceUsers := []string{actorID, recipientID}
		sort.Strings(preferenceUsers)
		prefs := make(map[string]sql.NullString, 2)
		for _, userID := range preferenceUsers {
			if _, err := tx.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data)
				SELECT ?,'{}' WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
				ON CONFLICT(user_id) DO NOTHING`, userID, userID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE user_preferences SET data=data WHERE user_id=?`, userID); err != nil {
				return err
			}
			var raw sql.NullString
			if err := tx.QueryRowContext(ctx, `SELECT data FROM user_preferences WHERE user_id=?`, userID).Scan(&raw); err != nil && err != sql.ErrNoRows {
				return err
			}
			prefs[userID] = raw
		}
		// PostgreSQL's READ COMMITTED snapshots do not by themselves order these
		// authorization reads against concurrent user-status, membership,
		// friendship, channel, permission, ban, timeout, or lifecycle writes.
		// Deterministic user-row plus SHARE table locks keep those inputs stable
		// through commit. NOWAIT avoids waiting with a partial lock set when other
		// writers acquire tables in a different order. The table guard is
		// deliberately coarse-grained; unrelated writes may fail/retry briefly.
		postgres := database.IsPostgres(r.db)
		if err := lockStreamStartUserRows(ctx, tx, actorID, recipientID, postgres); err != nil {
			return err
		}
		if err := lockStreamStartAuthorizationTables(ctx, tx, postgres); err != nil {
			return err
		}
		var pairActive int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users u WHERE u.id IN (?,?) AND u.deleted_at IS NULL AND u.is_bot=0 AND u.is_platform_banned=0
			AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`, actorID, recipientID).Scan(&pairActive); err != nil {
			return err
		}
		if pairActive != 2 {
			return nil
		}
		if !streamShareConsent(prefs[actorID]) || !streamNotificationEnabled(prefs[recipientID]) {
			return nil
		}

		var eligible int
		if err := tx.QueryRowContext(ctx, `SELECT
			(SELECT COUNT(*) FROM server_members WHERE server_id=?)<=? AND
			EXISTS(SELECT 1 FROM server_members WHERE server_id=? AND user_id=?) AND
			EXISTS(SELECT 1 FROM server_members WHERE server_id=? AND user_id=?)`,
			serverID, maxStreamStartServerMembers, serverID, actorID, serverID, recipientID).Scan(&eligible); err != nil {
			return err
		}
		if eligible == 0 {
			return nil
		}
		var channelServer, channelType string
		if err := tx.QueryRowContext(ctx, `SELECT server_id,type FROM channels WHERE id=?`, channelID).Scan(&channelServer, &channelType); err != nil {
			if err == sql.ErrNoRows {
				return nil
			}
			return err
		}
		if channelServer != serverID || channelType != string(models.ChannelTypeVoice) {
			return nil
		}
		var accepted, blocked int
		if err := tx.QueryRowContext(ctx, `SELECT
			EXISTS(SELECT 1 FROM friendships f WHERE f.status='accepted' AND
				((f.user_id=? AND f.friend_id=?) OR (f.user_id=? AND f.friend_id=?))),
			EXISTS(SELECT 1 FROM friendships b WHERE b.status='blocked' AND
				((b.user_id=? AND b.friend_id=?) OR (b.user_id=? AND b.friend_id=?)))`,
			actorID, recipientID, recipientID, actorID, actorID, recipientID, recipientID, actorID).Scan(&accepted, &blocked); err != nil {
			return err
		}
		if accepted == 0 || blocked != 0 {
			return nil
		}
		var actorBanned, actorTimedOut int
		if err := tx.QueryRowContext(ctx, `SELECT
			EXISTS(SELECT 1 FROM bans WHERE server_id=? AND user_id=? AND (expires_at IS NULL OR expires_at>CURRENT_TIMESTAMP)),
			EXISTS(SELECT 1 FROM member_timeouts WHERE server_id=? AND user_id=? AND expires_at>CURRENT_TIMESTAMP)`,
			serverID, actorID, serverID, actorID).Scan(&actorBanned, &actorTimedOut); err != nil {
			return err
		}
		if actorBanned != 0 || actorTimedOut != 0 {
			return nil
		}
		actorPermissions, err := streamEffectiveChannelPermissions(ctx, tx, actorID, serverID, channelID)
		if err != nil {
			return err
		}
		if !actorPermissions.Has(models.PermViewChannel) || !actorPermissions.Has(models.PermConnectVoice) || !actorPermissions.Has(models.PermStream) {
			return nil
		}
		recipientPermissions, err := streamEffectiveChannelPermissions(ctx, tx, recipientID, serverID, channelID)
		if err != nil || !recipientPermissions.Has(models.PermViewChannel) {
			return err
		}

		notificationID, err := generateID()
		if err != nil {
			return err
		}
		payload := json.RawMessage(`{"action":"stream_start"}`)
		if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(id,user_id,kind,actor_id,payload)
			VALUES(?,?,?,?,?)`, notificationID, recipientID, models.NotificationKindSystem, actorID, string(payload)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE stream_start_deliveries SET notification_id=?
			WHERE publication_id=? AND recipient_id=? AND notification_id IS NULL`, notificationID, publicationID, recipientID); err != nil {
			return err
		}
		var createdAt string
		if err := tx.QueryRowContext(ctx, `SELECT CAST(created_at AS TEXT) FROM notifications WHERE id=?`, notificationID).Scan(&createdAt); err != nil {
			return err
		}
		var actor models.PublicUser
		var displayName, avatarURL, customStatus sql.NullString
		var status, actorCreatedAt string
		if err := tx.QueryRowContext(ctx, `SELECT id,username,display_name,avatar_url,status,custom_status,CAST(created_at AS TEXT)
			FROM users WHERE id=?`, actorID).Scan(&actor.ID, &actor.Username, &displayName, &avatarURL, &status, &customStatus, &actorCreatedAt); err != nil {
			return err
		}
		actor.DisplayName = nullStringPtr(displayName)
		actor.AvatarURL = nullStringPtr(avatarURL)
		actor.CustomStatus = nullStringPtr(customStatus)
		actor.Status = models.UserStatus(status)
		if parsed, err := time.Parse(time.RFC3339Nano, serverEventTimeAPI(actorCreatedAt)); err == nil {
			actor.CreatedAt = parsed
		}
		delivered = &models.Notification{
			ID: notificationID, UserID: recipientID, Kind: models.NotificationKindSystem,
			ActorID: &actorID, Actor: &actor, Payload: payload, CreatedAt: serverEventTimeAPI(createdAt),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return delivered, nil
}

func lockStreamStartAuthorizationTables(ctx context.Context, tx *sql.Tx, postgres bool) error {
	if !postgres {
		return nil
	}
	_, err := tx.ExecContext(ctx, `LOCK TABLE bans, channels, channel_permissions, friendships, member_timeouts, roles, server_members, user_roles, account_lifecycle IN SHARE MODE NOWAIT`)
	return err
}

func lockStreamStartUserRows(ctx context.Context, tx *sql.Tx, actorID, recipientID string, postgres bool) error {
	if !postgres {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id FROM users WHERE id IN (?,?) ORDER BY id FOR SHARE NOWAIT`, actorID, recipientID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return err
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	return nil
}

func streamEffectiveChannelPermissions(ctx context.Context, tx *sql.Tx, userID, serverID, channelID string) (models.Permission, error) {
	rows, err := tx.QueryContext(ctx, `SELECT r.permissions FROM user_roles ur
		JOIN roles r ON r.id=ur.role_id AND r.server_id=ur.server_id
		WHERE ur.user_id=? AND ur.server_id=?`, userID, serverID)
	if err != nil {
		return 0, err
	}
	var base models.Permission
	for rows.Next() {
		var permissions int64
		if err := rows.Scan(&permissions); err != nil {
			rows.Close()
			return 0, err
		}
		base |= models.Permission(permissions)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if base.Has(models.PermAdmin) {
		return base, nil
	}
	rows, err = tx.QueryContext(ctx, `SELECT cp.allow,cp.deny FROM channel_permissions cp
		JOIN user_roles ur ON ur.role_id=cp.role_id AND ur.server_id=?
		WHERE ur.user_id=? AND cp.channel_id=?`, serverID, userID, channelID)
	if err != nil {
		return 0, err
	}
	var allow, deny models.Permission
	for rows.Next() {
		var a, d int64
		if err := rows.Scan(&a, &d); err != nil {
			rows.Close()
			return 0, err
		}
		allow |= models.Permission(a)
		deny |= models.Permission(d)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	return (base &^ deny) | allow, nil
}

func streamShareConsent(raw sql.NullString) bool {
	var root map[string]json.RawMessage
	if !raw.Valid || json.Unmarshal([]byte(raw.String), &root) != nil || root == nil || len(root["privacy"]) == 0 {
		return false
	}
	var privacy map[string]json.RawMessage
	if err := json.Unmarshal(root["privacy"], &privacy); err != nil || privacy == nil {
		return false
	}
	var enabled bool
	return json.Unmarshal(privacy["shareStreamUpdates"], &enabled) == nil && enabled
}

func streamNotificationEnabled(raw sql.NullString) bool {
	if !raw.Valid {
		return true
	}
	var root map[string]json.RawMessage
	if json.Unmarshal([]byte(raw.String), &root) != nil || root == nil {
		return false
	}
	if len(root["notifications"]) == 0 {
		return true
	}
	var notifications map[string]json.RawMessage
	if json.Unmarshal(root["notifications"], &notifications) != nil || notifications == nil {
		return false
	}
	if len(notifications["streamNotifications"]) == 0 {
		return true
	}
	var enabled bool
	return json.Unmarshal(notifications["streamNotifications"], &enabled) == nil && enabled
}

var _ StreamStartNotificationRepository = (*sqliteStreamStartNotificationRepo)(nil)
