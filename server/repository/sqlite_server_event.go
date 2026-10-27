package repository

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteServerEventRepo struct{ db database.TxQuerier }

func NewSQLiteServerEventRepo(db database.TxQuerier) ServerEventRepository {
	return &sqliteServerEventRepo{db: db}
}

const serverEventSelect = `SELECT id,server_id,creator_id,name,description,
	CAST(starts_at AS TEXT),CAST(ends_at AS TEXT),channel_id,status,version,
	CAST(created_at AS TEXT),CAST(updated_at AS TEXT) FROM server_events`

func scanServerEvent(row interface{ Scan(...any) error }) (*models.ServerEvent, error) {
	var e models.ServerEvent
	var endsAt, channelID sql.NullString
	if err := row.Scan(&e.ID, &e.ServerID, &e.CreatorID, &e.Name, &e.Description,
		&e.StartsAt, &endsAt, &channelID, &e.Status, &e.Version, &e.CreatedAt, &e.UpdatedAt); err != nil {
		return nil, err
	}
	e.StartsAt = serverEventTimeAPI(e.StartsAt)
	e.EndsAt = nullStringPtr(endsAt)
	if e.EndsAt != nil {
		v := serverEventTimeAPI(*e.EndsAt)
		e.EndsAt = &v
	}
	e.ChannelID = nullStringPtr(channelID)
	e.CreatedAt = serverEventTimeAPI(e.CreatedAt)
	e.UpdatedAt = serverEventTimeAPI(e.UpdatedAt)
	return &e, nil
}

func serverEventTimeDB(raw string) (string, error) {
	t, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return "", fmt.Errorf("invalid RFC3339 event time: %w", err)
	}
	// SQLite stores timestamps as text, so variable-width RFC3339Nano values
	// do not sort chronologically when one value has a fraction and another
	// does not (the decimal point sorts before the trailing Z). A fixed-width
	// UTC representation keeps ordering and the ends_at CHECK lexically sound.
	return t.UTC().Format("2006-01-02T15:04:05.000000000Z"), nil
}

func serverEventTimeAPI(raw string) string {
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t.UTC().Format(time.RFC3339Nano)
	}
	// PostgreSQL's CAST(timestamptz AS TEXT) uses a space separator and may
	// render its UTC offset as either +00 or +00:00, with fractional digits
	// omitted when zero. Normalize those forms at the same API boundary.
	for _, layout := range []string{
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05.999999999-07",
		"2006-01-02 15:04:05-07:00",
		"2006-01-02 15:04:05-07",
		"2006-01-02 15:04:05.000000000",
	} {
		if t, err := time.Parse(layout, raw); err == nil {
			return t.UTC().Format(time.RFC3339Nano)
		}
	}
	return dbTextToRFC3339(raw)
}

func (r *sqliteServerEventRepo) Create(ctx context.Context, event *models.ServerEvent) error {
	if event == nil || event.ServerID == "" || event.CreatorID == "" || strings.TrimSpace(event.Name) == "" || len([]rune(strings.TrimSpace(event.Name))) > 100 || len([]rune(event.Description)) > 2000 {
		return fmt.Errorf("invalid server event")
	}
	startsAt, err := serverEventTimeDB(event.StartsAt)
	if err != nil {
		return err
	}
	var endsAt any
	if event.EndsAt != nil {
		v, parseErr := serverEventTimeDB(*event.EndsAt)
		if parseErr != nil {
			return parseErr
		}
		startTime, _ := time.Parse(time.RFC3339Nano, startsAt)
		endTime, _ := time.Parse(time.RFC3339Nano, v)
		if !endTime.After(startTime) {
			return fmt.Errorf("event ends_at must follow starts_at")
		}
		endsAt = v
	}
	if event.ID == "" {
		event.ID, err = generateID()
		if err != nil {
			return err
		}
	}
	if event.Status == "" {
		event.Status = models.ServerEventStatusScheduled
	}
	if event.Status != models.ServerEventStatusScheduled || (event.Version != 0 && event.Version != 1) {
		return fmt.Errorf("new server event must be scheduled at version 1")
	}
	if event.ChannelID != nil && strings.TrimSpace(*event.ChannelID) == "" {
		return fmt.Errorf("channel_id cannot be empty")
	}
	if _, err = r.db.ExecContext(ctx, `INSERT INTO server_events
		(id,server_id,creator_id,name,description,starts_at,ends_at,channel_id,status,version)
		VALUES(?,?,?,?,?,?,?,?,?,1)`, event.ID, event.ServerID, event.CreatorID,
		strings.TrimSpace(event.Name), event.Description, startsAt, endsAt, event.ChannelID, event.Status); err != nil {
		return fmt.Errorf("create server event: %w", err)
	}
	created, err := r.GetByID(ctx, event.ServerID, event.ID)
	if err != nil {
		return err
	}
	*event = *created
	return nil
}

func (r *sqliteServerEventRepo) GetByID(ctx context.Context, serverID, eventID string) (*models.ServerEvent, error) {
	e, err := scanServerEvent(r.db.QueryRowContext(ctx, serverEventSelect+` WHERE server_id=? AND id=?`, serverID, eventID))
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("%w: server event not found", pkg.ErrNotFound)
	}
	return e, err
}

func (r *sqliteServerEventRepo) List(ctx context.Context, serverID string, limit int, beforeID string) ([]models.ServerEvent, error) {
	if limit < 1 || limit > 100 {
		limit = 50
	}
	query := serverEventSelect + ` WHERE server_id=?`
	args := []any{serverID}
	if beforeID != "" {
		query += ` AND (starts_at > (SELECT starts_at FROM server_events WHERE id=? AND server_id=?)
			OR (starts_at = (SELECT starts_at FROM server_events WHERE id=? AND server_id=?) AND id>?))`
		args = append(args, beforeID, serverID, beforeID, serverID, beforeID)
	}
	query += ` ORDER BY starts_at ASC,id ASC LIMIT ?`
	args = append(args, limit)
	rows, err := r.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]models.ServerEvent, 0)
	for rows.Next() {
		e, scanErr := scanServerEvent(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		out = append(out, *e)
	}
	return out, rows.Err()
}

func (r *sqliteServerEventRepo) UpdateCAS(ctx context.Context, event *models.ServerEvent, expectedVersion int64) (bool, error) {
	if event == nil || event.ID == "" || event.ServerID == "" || expectedVersion < 1 || strings.TrimSpace(event.Name) == "" || len([]rune(strings.TrimSpace(event.Name))) > 100 || len([]rune(event.Description)) > 2000 {
		return false, fmt.Errorf("invalid server event update")
	}
	startsAt, err := serverEventTimeDB(event.StartsAt)
	if err != nil {
		return false, err
	}
	var endsAt any
	if event.EndsAt != nil {
		v, parseErr := serverEventTimeDB(*event.EndsAt)
		if parseErr != nil {
			return false, parseErr
		}
		startTime, _ := time.Parse(time.RFC3339Nano, startsAt)
		endTime, _ := time.Parse(time.RFC3339Nano, v)
		if !endTime.After(startTime) {
			return false, fmt.Errorf("event ends_at must follow starts_at")
		}
		endsAt = v
	}
	if event.ChannelID != nil && strings.TrimSpace(*event.ChannelID) == "" {
		return false, fmt.Errorf("channel_id cannot be empty")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := r.db.ExecContext(ctx, `UPDATE server_events SET name=?,description=?,starts_at=?,ends_at=?,channel_id=?,version=version+1,updated_at=?
		WHERE server_id=? AND id=? AND version=? AND status='scheduled'`, strings.TrimSpace(event.Name), event.Description,
		startsAt, endsAt, event.ChannelID, now, event.ServerID, event.ID, expectedVersion)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 1 {
		event.Version = expectedVersion + 1
		event.UpdatedAt = now
	}
	return n == 1, nil
}

func (r *sqliteServerEventRepo) CancelCAS(ctx context.Context, serverID, eventID string, expectedVersion int64) (bool, error) {
	if expectedVersion < 1 {
		return false, fmt.Errorf("invalid server event version")
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	res, err := r.db.ExecContext(ctx, `UPDATE server_events SET status='cancelled',version=version+1,updated_at=?
		WHERE server_id=? AND id=? AND version=? AND status='scheduled'`, now, serverID, eventID, expectedVersion)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (r *sqliteServerEventRepo) SetInterested(ctx context.Context, eventID, userID string, interested bool) error {
	if eventID == "" || userID == "" {
		return fmt.Errorf("event_id and user_id are required")
	}
	if !interested {
		_, err := r.db.ExecContext(ctx, `DELETE FROM server_event_rsvps WHERE event_id=? AND user_id=?`, eventID, userID)
		return err
	}
	if database.IsPostgres(r.db) {
		return database.WithTx(ctx, database.RawDB(r.db), func(tx *sql.Tx) error {
			// An EXISTS snapshot alone can see a membership being deleted by
			// another transaction. Lock the membership until the RSVP commits;
			// a removal already in progress must finish before this check.
			var member int
			err := tx.QueryRowContext(ctx, `SELECT 1 FROM server_members sm
				JOIN server_events e ON e.server_id=sm.server_id
				WHERE e.id=? AND sm.user_id=? FOR KEY SHARE OF sm`, eventID, userID).Scan(&member)
			if err == sql.ErrNoRows {
				return fmt.Errorf("%w: event is unavailable for RSVP", pkg.ErrConflict)
			}
			if err != nil {
				return err
			}
			return r.setInterested(ctx, tx, eventID, userID)
		})
	}
	return r.setInterested(ctx, r.db, eventID, userID)
}

func (r *sqliteServerEventRepo) setInterested(ctx context.Context, q database.TxQuerier, eventID, userID string) error {
	now := time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
	// Recheck membership in the write itself: the service's earlier check can
	// become stale if the user leaves or is removed before this statement.
	res, err := q.ExecContext(ctx, `INSERT INTO server_event_rsvps(event_id,user_id,interested_at,updated_at)
		SELECT id,?,?,? FROM server_events WHERE id=? AND status='scheduled' AND starts_at>?
		AND EXISTS(SELECT 1 FROM server_members sm WHERE sm.server_id=server_events.server_id AND sm.user_id=?)
		ON CONFLICT(event_id,user_id) DO UPDATE SET updated_at=excluded.updated_at`, userID, now, now, eventID, now, userID)
	if err != nil {
		return err
	}
	if changed, err := res.RowsAffected(); err != nil {
		return err
	} else if changed == 0 {
		return fmt.Errorf("%w: event is unavailable for RSVP", pkg.ErrConflict)
	}
	return nil
}

func (r *sqliteServerEventRepo) InterestedUserIDs(ctx context.Context, eventID string) ([]string, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT user_id FROM server_event_rsvps WHERE event_id=? ORDER BY user_id`, eventID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (r *sqliteServerEventRepo) IsInterested(ctx context.Context, eventID, userID string) (bool, error) {
	if eventID == "" || userID == "" {
		return false, fmt.Errorf("event_id and user_id are required")
	}
	var interested bool
	err := r.db.QueryRowContext(ctx, `SELECT EXISTS(
		SELECT 1 FROM server_event_rsvps WHERE event_id=? AND user_id=?
	)`, eventID, userID).Scan(&interested)
	return interested, err
}
