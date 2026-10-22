package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteStickerRepo struct {
	db database.TxQuerier
}

func NewSQLiteStickerRepo(db database.TxQuerier) StickerRepository {
	return &sqliteStickerRepo{db: db}
}

// stickerColumns is the column list every SELECT below uses, in the order
// scanStickerRow reads it (trap #96: rows.Scan is positional, a mismatch is
// not a compile error).
const stickerColumns = `s.id, s.server_id, s.name, s.display_name, s.description, s.tags, s.animated,
	s.file_url, s.animated_url, s.copyable, s.cloned_from, s.created_by, s.created_at`

func scanStickerRow(rs rowScanner) (models.ServerSticker, error) {
	var (
		s           models.ServerSticker
		tags        string
		animatedURL sql.NullString
		clonedFrom  sql.NullString
		createdBy   sql.NullString
		createdAt   string
	)
	if err := rs.Scan(&s.ID, &s.ServerID, &s.Name, &s.DisplayName, &s.Description, &tags, &s.Animated,
		&s.URL, &animatedURL, &s.Copyable, &clonedFrom, &createdBy, &createdAt); err != nil {
		return models.ServerSticker{}, err
	}
	s.Tags = decodeStickerTags(tags)
	if animatedURL.Valid {
		s.AnimatedURL = &animatedURL.String
	}
	if clonedFrom.Valid {
		s.ClonedFrom = &clonedFrom.String
	}
	if createdBy.Valid {
		s.CreatedBy = &createdBy.String
	}
	s.CreatedAt = dbTextToRFC3339(createdAt)
	return s, nil
}

// decodeStickerTags reads the tags JSON array; anything unreadable is
// treated as no tags (only this repo writes the column).
func decodeStickerTags(raw string) []string {
	var tags []string
	if err := json.Unmarshal([]byte(raw), &tags); err != nil || tags == nil {
		return []string{}
	}
	return tags
}

func encodeStickerTags(tags []string) (string, error) {
	if tags == nil {
		tags = []string{}
	}
	b, err := json.Marshal(tags)
	if err != nil {
		return "", fmt.Errorf("failed to encode sticker tags: %w", err)
	}
	return string(b), nil
}

func (r *sqliteStickerRepo) CreateWithCap(ctx context.Context, s *models.ServerSticker, maxCount int) error {
	tags, err := encodeStickerTags(s.Tags)
	if err != nil {
		return err
	}
	res, err := r.db.ExecContext(ctx,
		`INSERT INTO server_stickers (id, server_id, name, display_name, description, tags, animated, file_url, animated_url, copyable, cloned_from, created_by)
		 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
		 WHERE (SELECT COUNT(*) FROM server_stickers WHERE server_id = ?) < ?`,
		s.ID, s.ServerID, s.Name, s.DisplayName, s.Description, tags, boolInt(s.Animated), s.URL, s.AnimatedURL,
		boolInt(s.Copyable), s.ClonedFrom, s.CreatedBy,
		s.ServerID, maxCount)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: sticker name taken", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to create sticker: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if n == 0 {
		return models.ErrExpressionLimitReached
	}

	// Read back the DB-side created_at default (RETURNING avoided for
	// Turso/Hrana safety, same as sqliteEmojiRepo.CreateWithCap).
	var createdAt string
	if err := r.db.QueryRowContext(ctx, `SELECT created_at FROM server_stickers WHERE id = ?`, s.ID).Scan(&createdAt); err == nil {
		s.CreatedAt = dbTextToRFC3339(createdAt)
	}
	if s.Tags == nil {
		s.Tags = []string{}
	}
	return nil
}

func (r *sqliteStickerRepo) GetByID(ctx context.Context, id string) (*models.ServerSticker, error) {
	query := `SELECT ` + stickerColumns + ` FROM server_stickers s WHERE s.id = ?`
	row := r.db.QueryRowContext(ctx, query, id)
	return r.scanOne(row)
}

func (r *sqliteStickerRepo) GetInServer(ctx context.Context, serverID, id string) (*models.ServerSticker, error) {
	row := r.db.QueryRowContext(ctx,
		`SELECT `+stickerColumns+` FROM server_stickers s WHERE s.id = ? AND s.server_id = ?`, id, serverID)
	return r.scanOne(row)
}

func (r *sqliteStickerRepo) scanOne(row *sql.Row) (*models.ServerSticker, error) {
	s, err := scanStickerRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("%w: sticker not found", pkg.ErrNotFound)
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get sticker: %w", err)
	}
	return &s, nil
}

func (r *sqliteStickerRepo) ListByServer(ctx context.Context, serverID string) ([]models.ServerSticker, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT `+stickerColumns+` FROM server_stickers s WHERE s.server_id = ? ORDER BY s.name`, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to list server stickers: %w", err)
	}
	return r.scanList(rows)
}

func (r *sqliteStickerRepo) ListForUser(ctx context.Context, userID string) ([]models.ServerSticker, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT `+stickerColumns+`
		 FROM server_stickers s
		 JOIN server_members m ON m.server_id = s.server_id
		 WHERE m.user_id = ?
		 ORDER BY s.server_id, s.name`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list user stickers: %w", err)
	}
	return r.scanList(rows)
}

func (r *sqliteStickerRepo) scanList(rows *sql.Rows) ([]models.ServerSticker, error) {
	out, err := scanRows(rows, "sticker", func(rs *sql.Rows) (models.ServerSticker, error) {
		return scanStickerRow(rs)
	})
	if err != nil {
		return nil, err
	}
	if out == nil {
		out = []models.ServerSticker{}
	}
	return out, nil
}

func (r *sqliteStickerRepo) CountByServer(ctx context.Context, serverID string) (int, error) {
	var n int
	if err := r.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM server_stickers WHERE server_id = ?`, serverID).Scan(&n); err != nil {
		return 0, fmt.Errorf("failed to count server stickers: %w", err)
	}
	return n, nil
}

func (r *sqliteStickerRepo) Update(ctx context.Context, s *models.ServerSticker) error {
	tags, err := encodeStickerTags(s.Tags)
	if err != nil {
		return err
	}
	res, err := r.db.ExecContext(ctx,
		`UPDATE server_stickers SET name = ?, display_name = ?, description = ?, tags = ?, copyable = ?
		 WHERE id = ? AND server_id = ?`,
		s.Name, s.DisplayName, s.Description, tags, boolInt(s.Copyable), s.ID, s.ServerID)
	if err != nil {
		if isUniqueViolation(err) {
			return fmt.Errorf("%w: sticker name taken", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to update sticker: %w", err)
	}
	return requireStickerAffected(res)
}

func (r *sqliteStickerRepo) Delete(ctx context.Context, serverID, id string) error {
	res, err := r.db.ExecContext(ctx, `DELETE FROM server_stickers WHERE id = ? AND server_id = ?`, id, serverID)
	if err != nil {
		return fmt.Errorf("failed to delete sticker: %w", err)
	}
	return requireStickerAffected(res)
}

// requireStickerAffected is requireAffected with sticker wording (the
// message reaches the client through pkg.Error).
func requireStickerAffected(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("%w: sticker not found", pkg.ErrNotFound)
	}
	return nil
}
