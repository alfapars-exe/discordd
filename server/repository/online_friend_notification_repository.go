package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

// OnlineFriendNotificationRepository persists an online notice only while
// the actor's consent, recipient preference, and accepted friendship are
// still current. A nil notification means the decision was ineligible.
type OnlineFriendNotificationRepository interface {
	CreateIfOnlineFriendEligible(ctx context.Context, actorID, recipientID string, notification *models.Notification) (*models.Notification, error)
}

// CreateIfOnlineFriendEligible is an additional capability on the production
// notification repository. The authorization read and notification insert
// share one transaction so a stale ListFriends result cannot notify someone
// after an unfriend/block or preference change has committed.
func (r *sqliteNotificationRepo) CreateIfOnlineFriendEligible(ctx context.Context, actorID, recipientID string, n *models.Notification) (*models.Notification, error) {
	if r == nil || n == nil || strings.TrimSpace(actorID) == "" || strings.TrimSpace(recipientID) == "" || actorID == recipientID ||
		n.UserID != recipientID || n.Kind != models.NotificationKindSystem || n.ActorID == nil || *n.ActorID != actorID ||
		n.ServerID != nil || n.ChannelID != nil || n.MessageID != nil || n.DMChannelID != nil || len(n.Payload) == 0 || !json.Valid(n.Payload) {
		return nil, errors.New("invalid online friend notification")
	}
	rawDB := database.RawDB(r.db)
	if rawDB == nil {
		return nil, errors.New("online friend notification requires raw database connection")
	}
	id, err := generateID()
	if err != nil {
		return nil, err
	}
	var committed *models.Notification
	err = database.WithTx(ctx, rawDB, func(tx *sql.Tx) error {
		postgres := database.IsPostgres(r.db)
		if err := lockStreamStartUserRows(ctx, tx, actorID, recipientID, postgres); err != nil {
			return err
		}
		if postgres {
			// NOWAIT avoids deadlocking with account deletion/preferences/friendship
			// writers that acquire these tables in a different order. A conflict
			// rolls back and the caller may retry the notification callback.
			if _, err := tx.ExecContext(ctx, `LOCK TABLE account_lifecycle, friendships, user_preferences IN SHARE MODE NOWAIT`); err != nil {
				return err
			}
		}

		var activeUsers int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users u
			WHERE u.id IN (?,?) AND u.deleted_at IS NULL AND u.is_bot=0 AND u.is_platform_banned=0
			AND (u.id<>? OR u.status<>'offline')
			AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL)`, actorID, recipientID, actorID).Scan(&activeUsers); err != nil {
			return err
		}
		if activeUsers != 2 {
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

		prefs := map[string]sql.NullString{}
		for _, userID := range []string{actorID, recipientID} {
			var raw sql.NullString
			if err := tx.QueryRowContext(ctx, `SELECT data FROM user_preferences WHERE user_id=?`, userID).Scan(&raw); err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			prefs[userID] = raw
		}
		actorSharing, err := onlineShareEnabled(prefs[actorID])
		if err != nil {
			return fmt.Errorf("decode actor online-sharing preference: %w", err)
		}
		recipientEnabled, err := onlineNotificationEnabled(prefs[recipientID])
		if err != nil {
			return fmt.Errorf("decode recipient online-notification preference: %w", err)
		}
		if !actorSharing || !recipientEnabled {
			return nil
		}

		payload := string(n.Payload)
		if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(id,user_id,kind,actor_id,server_id,channel_id,message_id,dm_channel_id,payload)
			VALUES(?,?,?,?,?,?,?,?,?)`, id, recipientID, models.NotificationKindSystem, actorID, nil, nil, nil, nil, payload); err != nil {
			return err
		}
		var createdAt string
		if err := tx.QueryRowContext(ctx, `SELECT CAST(created_at AS TEXT) FROM notifications WHERE id=?`, id).Scan(&createdAt); err != nil {
			return err
		}
		copy := *n
		copy.ID = id
		copy.CreatedAt = dbTextToRFC3339(createdAt)
		copy.Payload = json.RawMessage(payload)
		committed = &copy
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("create guarded online friend notification: %w", err)
	}
	return committed, nil
}

func onlineShareEnabled(raw sql.NullString) (bool, error) {
	if !raw.Valid {
		return true, nil
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw.String), &root); err != nil || root == nil {
		if err == nil {
			return false, errors.New("preferences are not an object")
		}
		return false, err
	}
	if len(root["privacy"]) == 0 {
		return true, nil
	}
	var privacy map[string]json.RawMessage
	if err := json.Unmarshal(root["privacy"], &privacy); err != nil || privacy == nil {
		if err == nil {
			return false, errors.New("privacy preferences are not an object")
		}
		return false, err
	}
	if len(privacy["shareOnlineUpdates"]) == 0 {
		return true, nil
	}
	var enabled bool
	if err := json.Unmarshal(privacy["shareOnlineUpdates"], &enabled); err != nil {
		return false, err
	}
	return enabled, nil
}

func onlineNotificationEnabled(raw sql.NullString) (bool, error) {
	if !raw.Valid {
		return false, nil
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw.String), &root); err != nil || root == nil {
		if err == nil {
			return false, errors.New("preferences are not an object")
		}
		return false, err
	}
	if len(root["notifications"]) == 0 {
		return false, nil
	}
	var notifications map[string]json.RawMessage
	if err := json.Unmarshal(root["notifications"], &notifications); err != nil || notifications == nil {
		if err == nil {
			return false, errors.New("notification preferences are not an object")
		}
		return false, err
	}
	if len(notifications["onlineFriendNotifications"]) == 0 {
		return false, nil
	}
	var enabled bool
	if err := json.Unmarshal(notifications["onlineFriendNotifications"], &enabled); err != nil {
		return false, err
	}
	return enabled, nil
}
