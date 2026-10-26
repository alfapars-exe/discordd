package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteReminderRepo struct{ db *sql.DB }

func NewSQLiteReminderRepo(db *sql.DB) ReminderRepository { return &sqliteReminderRepo{db: db} }

func reminderTime(t time.Time) string { return t.UTC().Format("2006-01-02 15:04:05") }

func (r *sqliteReminderRepo) Create(ctx context.Context, m *models.MessageReminder) error {
	if m.ID == "" {
		id, err := generateID()
		if err != nil {
			return err
		}
		m.ID = id
	}
	due, err := time.Parse(time.RFC3339, m.DueAt)
	if err != nil {
		return fmt.Errorf("invalid reminder due_at: %w", err)
	}
	_, err = r.db.ExecContext(ctx, `INSERT INTO message_reminders
		(id,user_id,source_kind,server_id,channel_id,message_id,due_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
		m.ID, m.UserID, m.SourceKind, m.ServerID, m.ChannelID, m.MessageID, reminderTime(due))
	if err != nil {
		return fmt.Errorf("failed to create reminder: %w", err)
	}
	got, err := r.GetByID(ctx, m.UserID, m.ID)
	if err != nil {
		return err
	}
	serverMatches := (got.ServerID == nil && m.ServerID == nil) || (got.ServerID != nil && m.ServerID != nil && *got.ServerID == *m.ServerID)
	storedDue, parseErr := time.Parse(time.RFC3339, got.DueAt)
	if !serverMatches || got.SourceKind != m.SourceKind || got.ChannelID != m.ChannelID || got.MessageID != m.MessageID || parseErr != nil || !storedDue.Equal(due.UTC().Truncate(time.Second)) {
		return fmt.Errorf("%w: reminder request identity reused with different data", pkg.ErrConflict)
	}
	*m = *got
	return nil
}

const reminderSelect = `SELECT id,user_id,source_kind,server_id,channel_id,message_id,due_at,status,
	notification_id,created_at,updated_at,delivered_at FROM message_reminders`

func scanReminder(s interface{ Scan(...any) error }) (*models.MessageReminder, error) {
	var m models.MessageReminder
	var server, notification, delivered sql.NullString
	var due, created, updated string
	if err := s.Scan(&m.ID, &m.UserID, &m.SourceKind, &server, &m.ChannelID, &m.MessageID, &due, &m.Status, &notification, &created, &updated, &delivered); err != nil {
		return nil, err
	}
	m.ServerID = nullStringPtr(server)
	m.NotificationID = nullStringPtr(notification)
	m.DeliveredAt = nullStringPtr(delivered)
	m.DueAt = dbTextToRFC3339(due)
	m.CreatedAt = dbTextToRFC3339(created)
	m.UpdatedAt = dbTextToRFC3339(updated)
	if m.DeliveredAt != nil {
		v := dbTextToRFC3339(*m.DeliveredAt)
		m.DeliveredAt = &v
	}
	return &m, nil
}

func (r *sqliteReminderRepo) GetByID(ctx context.Context, userID, id string) (*models.MessageReminder, error) {
	m, err := scanReminder(r.db.QueryRowContext(ctx, reminderSelect+` WHERE id=? AND user_id=?`, id, userID))
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: reminder not found", pkg.ErrNotFound)
	}
	return m, err
}
func (r *sqliteReminderRepo) List(ctx context.Context, userID string) ([]models.MessageReminder, error) {
	rows, err := r.db.QueryContext(ctx, reminderSelect+` WHERE user_id=? AND status='scheduled' ORDER BY due_at,id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []models.MessageReminder{}
	for rows.Next() {
		m, e := scanReminder(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}
func (r *sqliteReminderRepo) UpdateDue(ctx context.Context, userID, id string, due time.Time) (bool, error) {
	res, err := r.db.ExecContext(ctx, `UPDATE message_reminders SET due_at=?,updated_at=datetime('now') WHERE id=? AND user_id=? AND status='scheduled'`, reminderTime(due), id, userID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
func (r *sqliteReminderRepo) Cancel(ctx context.Context, userID, id string) (bool, error) {
	res, err := r.db.ExecContext(ctx, `UPDATE message_reminders SET status='cancelled',updated_at=datetime('now') WHERE id=? AND user_id=? AND status='scheduled'`, id, userID)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
func (r *sqliteReminderRepo) DeliverDue(ctx context.Context, now time.Time, limit int) ([]models.Notification, error) {
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, reminderSelect+` WHERE status='scheduled' AND due_at<=? ORDER BY due_at,id LIMIT ?`, reminderTime(now), limit)
	if err != nil {
		return nil, err
	}
	var due []models.MessageReminder
	for rows.Next() {
		m, e := scanReminder(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		due = append(due, *m)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	out := make([]models.Notification, 0, len(due))
	for _, m := range due {
		nid, e := generateID()
		if e != nil {
			return nil, e
		}
		// First claim the reminder atomically without notification_id to prevent races
		// A concurrent reschedule can commit after the SELECT under READ COMMITTED.
		// Recheck the due time when claiming so postponed reminders stay scheduled.
		res, e := tx.ExecContext(ctx, `UPDATE message_reminders SET status='delivered',delivered_at=?,updated_at=? WHERE id=? AND status='scheduled' AND due_at<=?`, reminderTime(now), reminderTime(now), m.ID, reminderTime(now))
		if e != nil {
			return nil, e
		}
		affected, e := res.RowsAffected()
		if e != nil {
			return nil, e
		}
		if affected == 0 {
			continue
		}
		payload, _ := json.Marshal(map[string]string{"title": "Mesaj hatırlatıcısı", "body": "Kaydettiğiniz mesaja dönme zamanı.", "reminder_id": m.ID})
		n := models.Notification{ID: nid, UserID: m.UserID, Kind: models.NotificationKindSystem, ChannelID: &m.ChannelID, MessageID: &m.MessageID, Payload: payload, CreatedAt: now.UTC().Format(time.RFC3339)}
		if m.SourceKind == models.ReminderSourceChannel {
			n.ServerID = m.ServerID
		} else {
			n.DMChannelID = &m.ChannelID
			n.ChannelID = nil
		}
		_, e = tx.ExecContext(ctx, `INSERT INTO notifications(id,user_id,kind,server_id,channel_id,message_id,dm_channel_id,payload,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, n.ID, n.UserID, n.Kind, n.ServerID, n.ChannelID, n.MessageID, n.DMChannelID, string(n.Payload), reminderTime(now))
		if e != nil {
			return nil, e
		}
		_, e = tx.ExecContext(ctx, `UPDATE message_reminders SET notification_id=? WHERE id=?`, nid, m.ID)
		if e != nil {
			return nil, e
		}
		out = append(out, n)
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return out, nil
}
