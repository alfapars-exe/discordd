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

const serverEventNoticeWindow = 15 * time.Minute
const serverEventNoticePreference = "upcomingEventNotifications"

type sqliteServerEventDeliveryRepo struct{ db database.TxQuerier }

func NewSQLiteServerEventDeliveryRepo(db database.TxQuerier) ServerEventDeliveryRepository {
	return &sqliteServerEventDeliveryRepo{db: db}
}

func (r *sqliteServerEventDeliveryRepo) DueCandidates(ctx context.Context, now time.Time, limit int, afterEventID string) ([]models.ServerEvent, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	nowText := now.UTC().Format("2006-01-02T15:04:05.000000000Z")
	deadlineText := now.Add(serverEventNoticeWindow).UTC().Format("2006-01-02T15:04:05.000000000Z")
	rows, err := r.db.QueryContext(ctx, serverEventSelect+` WHERE status='scheduled' AND starts_at>? AND starts_at<=? AND id>?
		ORDER BY id ASC LIMIT ?`, nowText, deadlineText, afterEventID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]models.ServerEvent, 0)
	for rows.Next() {
		event, scanErr := scanServerEvent(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, *event)
	}
	return out, rows.Err()
}

func (r *sqliteServerEventDeliveryRepo) InterestedPage(ctx context.Context, eventID, afterUserID string, limit int) ([]string, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	rows, err := r.db.QueryContext(ctx, `SELECT r.user_id FROM server_event_rsvps r
		JOIN server_events e ON e.id=r.event_id
		JOIN server_members sm ON sm.server_id=e.server_id AND sm.user_id=r.user_id
		LEFT JOIN server_event_deliveries d ON d.event_id=e.id AND d.user_id=r.user_id AND d.starts_at=e.starts_at
		WHERE r.event_id=? AND r.user_id>? AND e.status='scheduled' AND d.event_id IS NULL
		ORDER BY r.user_id ASC LIMIT ?`, eventID, afterUserID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			return nil, err
		}
		out = append(out, userID)
	}
	return out, rows.Err()
}

func (r *sqliteServerEventDeliveryRepo) Deliver(ctx context.Context, eventID string, version int64, userID string, now time.Time) (*models.Notification, error) {
	rawDB := database.RawDB(r.db)
	if rawDB == nil {
		return nil, fmt.Errorf("server event delivery requires a raw database connection")
	}
	var delivered *models.Notification
	err := database.WithTx(ctx, rawDB, func(tx *sql.Tx) error {
		// The no-op write locks this event row before checking eligibility. It
		// serializes a concurrent cancellation/update with delivery on both
		// SQLite and PostgreSQL, and its version predicate fences stale workers.
		locked, err := tx.ExecContext(ctx, `UPDATE server_events SET status=status
			WHERE id=? AND version=? AND status='scheduled'`, eventID, version)
		if err != nil {
			return err
		}
		if count, err := locked.RowsAffected(); err != nil {
			return err
		} else if count != 1 {
			return nil
		}

		var serverID, name, startsAt string
		var currentVersion int64
		var status string
		if err := tx.QueryRowContext(ctx, `SELECT server_id,name,CAST(starts_at AS TEXT),version,status
			FROM server_events WHERE id=?`, eventID).Scan(&serverID, &name, &startsAt, &currentVersion, &status); err != nil {
			if err == sql.ErrNoRows {
				return nil
			}
			return err
		}
		startTime, err := time.Parse(time.RFC3339Nano, serverEventTimeAPI(startsAt))
		if err != nil {
			return fmt.Errorf("invalid server event start time: %w", err)
		}
		if currentVersion != version || status != models.ServerEventStatusScheduled || !startTime.After(now.UTC()) || startTime.After(now.UTC().Add(serverEventNoticeWindow)) {
			return nil
		}

		// Lock in the same broad order as account anonymization: preferences
		// before membership, then RSVP. That avoids a preference/member lock
		// cycle with its cleanup transaction and serializes first preference
		// creation with opt-out writes.
		prefInsert, err := tx.ExecContext(ctx, `INSERT INTO user_preferences(user_id,data) VALUES(?,'{}')
			ON CONFLICT(user_id) DO NOTHING`, userID)
		if err != nil {
			return err
		}
		preferenceCreated, err := prefInsert.RowsAffected()
		if err != nil {
			return err
		}
		prefLock, err := tx.ExecContext(ctx, `UPDATE user_preferences SET data=data WHERE user_id=?`, userID)
		if err != nil {
			return err
		}
		if changed, err := prefLock.RowsAffected(); err != nil {
			return err
		} else if changed == 0 {
			return fmt.Errorf("preference row missing for existing user %q", userID)
		}
		var raw sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT data FROM user_preferences WHERE user_id=?`, userID).Scan(&raw); err != nil && err != sql.ErrNoRows {
			return err
		}
		appNoticeEnabled := serverEventNoticePreferenceEnabled(raw)

		// The no-op updates are portable row locks (SQLite serializes writers;
		// PostgreSQL holds the row locks until this transaction completes).
		memberLock, err := tx.ExecContext(ctx, `UPDATE server_members SET server_id=server_id
			WHERE server_id=? AND user_id=?`, serverID, userID)
		if err != nil {
			return err
		}
		if changed, err := memberLock.RowsAffected(); err != nil {
			return err
		} else if changed == 0 {
			// Anonymization may have removed preferences while this transaction
			// was waiting on that row. Do not recreate an empty preference row for
			// the now-removed member.
			if preferenceCreated == 1 {
				_, err = tx.ExecContext(ctx, `DELETE FROM user_preferences WHERE user_id=?`, userID)
			}
			return err
		}
		rsvpLock, err := tx.ExecContext(ctx, `UPDATE server_event_rsvps SET user_id=user_id
			WHERE event_id=? AND user_id=?`, eventID, userID)
		if err != nil {
			return err
		}
		if changed, err := rsvpLock.RowsAffected(); err != nil {
			return err
		} else if changed == 0 {
			return nil
		}

		// One row per event, recipient, and scheduled start. The dedupe row,
		// optional in-app notification, and optional email enqueue commit
		// together, so a crash cannot lose or duplicate either producer.
		canonicalStart, err := serverEventTimeDB(startTime.Format(time.RFC3339Nano))
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `INSERT INTO server_event_deliveries(event_id,user_id,starts_at)
			VALUES(?,?,?) ON CONFLICT(event_id,user_id,starts_at) DO NOTHING`, eventID, userID, canonicalStart)
		if err != nil {
			return err
		}
		inserted, err := result.RowsAffected()
		if err != nil || inserted == 0 {
			return err
		}

		if appNoticeEnabled {
			notificationID, err := generateID()
			if err != nil {
				return err
			}
			payload, err := json.Marshal(map[string]string{
				"action":   "server_event_upcoming",
				"title":    name,
				"body":     "An event you marked as interested in starts soon.",
				"event_id": eventID,
			})
			if err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO notifications(id,user_id,kind,server_id,payload)
				VALUES(?,?,?,?,?)`, notificationID, userID, models.NotificationKindSystem, serverID, string(payload)); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `UPDATE server_event_deliveries SET notification_id=?
				WHERE event_id=? AND user_id=? AND starts_at=? AND notification_id IS NULL`, notificationID, eventID, userID, canonicalStart); err != nil {
				return err
			}
			var createdAt string
			if err := tx.QueryRowContext(ctx, `SELECT CAST(created_at AS TEXT) FROM notifications WHERE id=?`, notificationID).Scan(&createdAt); err != nil {
				return err
			}
			serverIDCopy := serverID
			delivered = &models.Notification{
				ID: notificationID, UserID: userID, Kind: models.NotificationKindSystem,
				ServerID: &serverIDCopy, Payload: payload, CreatedAt: serverEventTimeAPI(createdAt),
			}
		}

		// Email is an independent channel from the in-app upcoming-event
		// preference. Consent and verified-address state are checked here to
		// avoid queueing ineligible work, then checked again immediately before
		// the sender runs. Keep subject/body generic so same-occurrence edits do
		// not leave stale event details in a queued message.
		var emailEligible bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM users u
			WHERE u.id=? AND u.email IS NOT NULL AND u.email<>'' AND u.email_verified_at IS NOT NULL
			AND u.deleted_at IS NULL AND u.is_bot=0
			AND NOT EXISTS(SELECT 1 FROM account_lifecycle l WHERE l.user_id=u.id AND l.disabled_at IS NOT NULL))`, userID).Scan(&emailEligible); err != nil {
			return err
		}
		if emailEligible && emailCategoryAllowed(raw, models.EmailCategorySocial) {
			jobID, err := generateID()
			if err != nil {
				return err
			}
			dedupeKey := "server-event:" + eventID + ":" + canonicalStart
			if _, err := tx.ExecContext(ctx, `INSERT INTO email_delivery_jobs(
				id,user_id,category,dedupe_key,subject,body_html,server_event_id,server_event_starts_at)
				VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,category,dedupe_key) DO NOTHING`,
				jobID, userID, models.EmailCategorySocial, dedupeKey,
				"An event you marked as interested in starts soon",
				"<p>An event you marked as interested in starts soon.</p>", eventID, canonicalStart); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return delivered, nil
}

func serverEventNoticePreferenceEnabled(raw sql.NullString) bool {
	if !raw.Valid {
		return true
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw.String), &root); err != nil || root == nil {
		return false
	}
	var notifications map[string]json.RawMessage
	if len(root["notifications"]) == 0 {
		return true
	}
	if err := json.Unmarshal(root["notifications"], &notifications); err != nil || notifications == nil {
		return false
	}
	value, exists := notifications[serverEventNoticePreference]
	if !exists {
		return true
	}
	var enabled bool
	if err := json.Unmarshal(value, &enabled); err != nil {
		return false
	}
	return enabled
}
