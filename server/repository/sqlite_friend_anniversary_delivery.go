package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

const friendAnniversaryPreference = "friendAnniversaryNotifications"

type sqliteFriendAnniversaryDeliveryRepo struct{ db database.TxQuerier }

func NewSQLiteFriendAnniversaryDeliveryRepo(db database.TxQuerier) FriendAnniversaryDeliveryRepository {
	return &sqliteFriendAnniversaryDeliveryRepo{db: db}
}

func (r *sqliteFriendAnniversaryDeliveryRepo) DueCandidates(ctx context.Context, day string, includeLeapDay bool, afterID string, limit int) ([]FriendAnniversaryCandidate, error) {
	if limit < 1 || limit > 500 {
		limit = 100
	}
	query := `SELECT id,user_id,friend_id,CAST(accepted_at AS TEXT),anniversary_day
		FROM friendships WHERE status='accepted' AND anniversary_day=? AND id>?
		ORDER BY id ASC LIMIT ?`
	args := []any{day, afterID, limit}
	if includeLeapDay {
		query = `SELECT id,user_id,friend_id,CAST(accepted_at AS TEXT),anniversary_day
			FROM friendships WHERE status='accepted' AND anniversary_day IN (?,?) AND id>?
			ORDER BY id ASC LIMIT ?`
		args = []any{day, "02-29", afterID, limit}
	}
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("friend anniversary candidates: %w", err)
	}
	defer rows.Close()
	items := make([]FriendAnniversaryCandidate, 0, limit)
	for rows.Next() {
		var item FriendAnniversaryCandidate
		var acceptedAt string
		if err := rows.Scan(&item.FriendshipID, &item.UserID, &item.FriendID, &acceptedAt, &item.AnniversaryDay); err != nil {
			return nil, fmt.Errorf("friend anniversary candidate scan: %w", err)
		}
		parsed, err := parseFriendAnniversaryTimestamp(acceptedAt)
		if err != nil {
			return nil, fmt.Errorf("friend anniversary accepted_at parse: %w", err)
		}
		item.AcceptedAt = parsed.UTC()
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("friend anniversary candidate rows: %w", err)
	}
	return items, nil
}

func (r *sqliteFriendAnniversaryDeliveryRepo) Deliver(ctx context.Context, friendshipID string, year int, recipientID string, now time.Time) (*models.Notification, error) {
	rawDB := database.RawDB(r.db)
	if rawDB == nil {
		return nil, fmt.Errorf("friend anniversary delivery requires a raw database connection")
	}
	var delivered *models.Notification
	err := database.WithTx(ctx, rawDB, func(tx *sql.Tx) error {
		// Anonymization locks preferences before deleting friendships. Keep the
		// same order to avoid a cycle with an account-retirement transaction.
		var eligible int
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users u
			WHERE u.id=? AND u.deleted_at IS NULL AND u.is_bot=0
			AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`, recipientID).Scan(&eligible); err != nil {
			return err
		}
		if eligible == 0 {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data)
			SELECT ?,'{}' WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND deleted_at IS NULL)
			ON CONFLICT(user_id) DO NOTHING`, recipientID, recipientID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE user_preferences SET data=data WHERE user_id=?`, recipientID); err != nil {
			return err
		}
		var prefs sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT data FROM user_preferences WHERE user_id=?`, recipientID).Scan(&prefs); err != nil && err != sql.ErrNoRows {
			return err
		}

		locked, err := tx.ExecContext(ctx, `UPDATE friendships SET status=status WHERE id=? AND status='accepted'`, friendshipID)
		if err != nil {
			return err
		}
		if changed, err := locked.RowsAffected(); err != nil {
			return err
		} else if changed == 0 {
			return nil
		}
		var userID, friendID, acceptedAtRaw, anniversaryDay string
		if err := tx.QueryRowContext(ctx, `SELECT user_id,friend_id,CAST(accepted_at AS TEXT),anniversary_day
			FROM friendships WHERE id=? AND status='accepted'`, friendshipID).Scan(&userID, &friendID, &acceptedAtRaw, &anniversaryDay); err != nil {
			if err == sql.ErrNoRows {
				return nil
			}
			return err
		}
		if recipientID != userID && recipientID != friendID {
			return nil
		}
		actorID := friendID
		if recipientID == friendID {
			actorID = userID
		}
		var actorEligible int
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users u
			WHERE u.id=? AND u.deleted_at IS NULL AND u.is_bot=0
			AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`, actorID).Scan(&actorEligible); err != nil {
			return err
		}
		if actorEligible == 0 {
			return nil
		}
		var blocked int
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM friendships b
			WHERE b.status='blocked' AND ((b.user_id=? AND b.friend_id=?) OR (b.user_id=? AND b.friend_id=?)))`, userID, friendID, friendID, userID).Scan(&blocked); err != nil {
			return err
		}
		if blocked != 0 {
			return nil
		}
		acceptedAt, err := parseFriendAnniversaryTimestamp(acceptedAtRaw)
		if err != nil {
			return fmt.Errorf("friend anniversary accepted_at parse: %w", err)
		}
		nowUTC := now.UTC()
		if !friendAnniversaryDue(anniversaryDay, acceptedAt, year, nowUTC) {
			return nil
		}

		// Persist the decision even when the user opted out. This avoids a
		// retroactive same-day notification after changing the preference.
		decision, err := tx.ExecContext(ctx, `INSERT INTO friendship_anniversary_deliveries
			(friendship_id,anniversary_year,recipient_id) VALUES(?,?,?) ON CONFLICT DO NOTHING`, friendshipID, year, recipientID)
		if err != nil {
			return err
		}
		inserted, err := decision.RowsAffected()
		if err != nil || inserted == 0 {
			return err
		}
		if !friendAnniversaryEnabled(prefs) {
			return nil
		}
		payload, err := json.Marshal(map[string]any{"action": "friend_anniversary", "years": year - acceptedAt.Year()})
		if err != nil {
			return err
		}
		notificationID := fmt.Sprintf("friend-anniversary:%s:%d:%s", friendshipID, year, recipientID)
		if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(id,user_id,kind,actor_id,payload)
			VALUES(?,?,?,?,?)`, notificationID, recipientID, models.NotificationKindSystem, actorID, string(payload)); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE friendship_anniversary_deliveries SET notification_id=?
			WHERE friendship_id=? AND anniversary_year=? AND recipient_id=? AND notification_id IS NULL`, notificationID, friendshipID, year, recipientID); err != nil {
			return err
		}
		var createdAt string
		if err := tx.QueryRowContext(ctx, `SELECT CAST(created_at AS TEXT) FROM notifications WHERE id=?`, notificationID).Scan(&createdAt); err != nil {
			return err
		}
		var actor models.PublicUser
		var displayName, avatarURL, customStatus sql.NullString
		var status string
		var actorCreatedAt string
		if err := tx.QueryRowContext(ctx, `SELECT id,username,display_name,avatar_url,status,custom_status,CAST(created_at AS TEXT)
			FROM users WHERE id=?`, actorID).Scan(&actor.ID, &actor.Username, &displayName, &avatarURL, &status, &customStatus, &actorCreatedAt); err != nil {
			return err
		}
		actor.DisplayName = nullStringPtr(displayName)
		actor.AvatarURL = nullStringPtr(avatarURL)
		actor.CustomStatus = nullStringPtr(customStatus)
		actor.Status = models.UserStatus(status)
		if parsed, parseErr := time.Parse(time.RFC3339Nano, serverEventTimeAPI(actorCreatedAt)); parseErr == nil {
			actor.CreatedAt = parsed
		}
		delivered = &models.Notification{
			ID: notificationID, UserID: recipientID, Kind: models.NotificationKindSystem,
			ActorID: &actorID, Actor: &actor, Payload: payload,
			CreatedAt: serverEventTimeAPI(createdAt),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return delivered, nil
}

func friendAnniversaryDue(day string, acceptedAt time.Time, year int, now time.Time) bool {
	if now.UTC().Year() != year || acceptedAt.UTC().Year() >= year {
		return false
	}
	expectedDay := day
	if day == "02-29" && !isLeapYear(year) {
		expectedDay = "02-28"
	}
	return expectedDay == now.UTC().Format("01-02")
}

func isLeapYear(year int) bool {
	return year%4 == 0 && (year%100 != 0 || year%400 == 0)
}

func parseFriendAnniversaryTimestamp(raw string) (time.Time, error) {
	if parsed, err := time.Parse(time.RFC3339Nano, serverEventTimeAPI(raw)); err == nil {
		return parsed.UTC(), nil
	}
	// Historical SQLite rows may contain database/sql's textual form of a Go
	// time.Time (for example, "2020-02-29 12:00:00.123 +0000 UTC").
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999999 -0700 MST",
		"2006-01-02 15:04:05 -0700 MST",
	} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid friendship accepted_at timestamp %q", raw)
}

func friendAnniversaryEnabled(raw sql.NullString) bool {
	if !raw.Valid {
		return true
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw.String), &root); err != nil || root == nil {
		return false
	}
	notificationsRaw := root["notifications"]
	if len(notificationsRaw) == 0 {
		return true
	}
	var notifications map[string]json.RawMessage
	if err := json.Unmarshal(notificationsRaw, &notifications); err != nil || notifications == nil {
		return false
	}
	value, exists := notifications[friendAnniversaryPreference]
	if !exists {
		return true
	}
	var enabled bool
	if err := json.Unmarshal(value, &enabled); err != nil {
		return false
	}
	return enabled
}

var _ FriendAnniversaryDeliveryRepository = (*sqliteFriendAnniversaryDeliveryRepo)(nil)
