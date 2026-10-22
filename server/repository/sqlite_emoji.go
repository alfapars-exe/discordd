package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteEmojiRepo struct {
	db database.TxQuerier
}

func NewSQLiteEmojiRepo(db database.TxQuerier) EmojiRepository {
	return &sqliteEmojiRepo{db: db}
}

// Every SELECT below lists the same columns in the same order —
// e.id, e.server_id, e.name, e.display_name, e.animated, e.file_url,
// e.animated_url, e.copyable, e.cloned_from, e.created_by, e.created_at —
// and is read by
// scanEmojiRow (trap #96: rows.Scan is positional, a mismatch is not a
// compile error). rowScanner is shared with sqlite_livekit_scan.go.

func scanEmojiRow(s rowScanner) (models.ServerEmoji, error) {
	var (
		e           models.ServerEmoji
		animatedURL sql.NullString
		clonedFrom  sql.NullString
		createdBy   sql.NullString
		createdAt   string
	)
	if err := s.Scan(&e.ID, &e.ServerID, &e.Name, &e.DisplayName, &e.Animated, &e.URL,
		&animatedURL, &e.Copyable, &clonedFrom, &createdBy, &createdAt); err != nil {
		return models.ServerEmoji{}, err
	}
	if animatedURL.Valid {
		e.AnimatedURL = &animatedURL.String
	}
	if clonedFrom.Valid {
		e.ClonedFrom = &clonedFrom.String
	}
	if createdBy.Valid {
		e.CreatedBy = &createdBy.String
	}
	e.CreatedAt = dbTextToRFC3339(createdAt)
	return e, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (r *sqliteEmojiRepo) CreateWithCap(ctx context.Context, e *models.ServerEmoji, maxForType int) error {
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO server_emojis (id, server_id, name, display_name, animated, file_url, animated_url, copyable, cloned_from, created_by)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		 WHERE (SELECT COUNT(*) FROM server_emojis WHERE server_id = ? AND animated = ?) < ?`,
		e.ID, e.ServerID, e.Name, e.DisplayName, boolInt(e.Animated), e.URL, e.AnimatedURL,
		boolInt(e.Copyable), e.ClonedFrom, e.CreatedBy,
		e.ServerID, boolInt(e.Animated), maxForType)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: emoji name taken", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to create emoji: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if n == 0 {
		return models.ErrExpressionLimitReached
	}

	// Read back the DB-side created_at default (RETURNING avoided for
	// Turso/Hrana safety, same as sqlite_notification.go Create).
	var createdAt string
	if err := r.db.QueryRowContext(ctx, `SELECT created_at FROM server_emojis WHERE id = ?`, e.ID).Scan(&createdAt); err == nil {
		e.CreatedAt = dbTextToRFC3339(createdAt)
	}
	return nil
}

func (r *sqliteEmojiRepo) GetByID(ctx context.Context, id string) (*models.ServerEmoji, error) {
	row := r.db.QueryRowContext(ctx, `SELECT e.id, e.server_id, e.name, e.display_name, e.animated, e.file_url, e.animated_url, e.copyable, e.cloned_from, e.created_by, e.created_at
		 FROM server_emojis e WHERE e.id = ?`, id)
	return r.scanOne(row)
}

func (r *sqliteEmojiRepo) GetInServer(ctx context.Context, serverID, id string) (*models.ServerEmoji, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT e.id, e.server_id, e.name, e.display_name, e.animated, e.file_url, e.animated_url, e.copyable, e.cloned_from, e.created_by, e.created_at
		 FROM server_emojis e WHERE e.id = ? AND e.server_id = ?`, id, serverID)
	return r.scanOne(row)
}

func (r *sqliteEmojiRepo) scanOne(row *sql.Row) (*models.ServerEmoji, error) {
	e, err := scanEmojiRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: emoji not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get emoji: %w", err)
	}
	return &e, nil
}

func (r *sqliteEmojiRepo) ListByServer(ctx context.Context, serverID string) ([]models.ServerEmoji, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT e.id, e.server_id, e.name, e.display_name, e.animated, e.file_url, e.animated_url, e.copyable, e.cloned_from, e.created_by, e.created_at
		 FROM server_emojis e WHERE e.server_id = ? ORDER BY e.name`, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to list server emojis: %w", err)
	}
	return r.scanList(rows)
}

func (r *sqliteEmojiRepo) ListForUser(ctx context.Context, userID string) ([]models.ServerEmoji, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT e.id, e.server_id, e.name, e.display_name, e.animated, e.file_url, e.animated_url, e.copyable, e.cloned_from, e.created_by, e.created_at
		 FROM server_emojis e
		 JOIN server_members m ON m.server_id = e.server_id
		 WHERE m.user_id = ?
		 ORDER BY e.server_id, e.name`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list user emojis: %w", err)
	}
	return r.scanList(rows)
}

func (r *sqliteEmojiRepo) scanList(rows *sql.Rows) ([]models.ServerEmoji, error) {
	out, err := scanRows(rows, "emoji", func(rs *sql.Rows) (models.ServerEmoji, error) {
		return scanEmojiRow(rs)
	})
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []models.ServerEmoji{}
	}
	return out, nil
}

func (r *sqliteEmojiRepo) CountByServer(ctx context.Context, serverID string) (static, animated int, err error) {
	err = r.db.QueryRowContext(ctx,
		`SELECT COALESCE(SUM(CASE WHEN animated = 0 THEN 1 ELSE 0 END), 0),
		        COALESCE(SUM(CASE WHEN animated = 0 THEN 0 ELSE 1 END), 0)
		 FROM server_emojis WHERE server_id = ?`, serverID).Scan(&static, &animated)
	if err != nil {
		return 0, 0, fmt.Errorf("failed to count server emojis: %w", err)
	}
	return static, animated, nil
}

func (r *sqliteEmojiRepo) Update(ctx context.Context, e *models.ServerEmoji) error {
	res, err := r.db.ExecContext(ctx,
		`UPDATE server_emojis SET name = ?, display_name = ?, copyable = ? WHERE id = ? AND server_id = ?`,
		e.Name, e.DisplayName, boolInt(e.Copyable), e.ID, e.ServerID)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: emoji name taken", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to update emoji: %w", err)
	}
	return requireAffected(res)
}

func (r *sqliteEmojiRepo) Delete(ctx context.Context, serverID, id string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM server_emojis WHERE id = ? AND server_id = ?`, id, serverID)
	if err != nil {
		return fmt.Errorf("failed to delete emoji: %w", err)
	}
	return requireAffected(res)
}

func requireAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("%w: emoji not found", pkg.ErrNotFound)
	}
	return nil
}
