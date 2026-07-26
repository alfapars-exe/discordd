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

type sqliteBanRepo struct {
	db database.TxQuerier
}

func NewSQLiteBanRepo(db database.TxQuerier) BanRepository {
	return &sqliteBanRepo{db: db}
}

// scanBan scans one bans row in the column order shared by the ban list query.
func scanBan(rows *sql.Rows) (models.Ban, error) {
	var ban models.Ban
	err := rows.Scan(
		&ban.ServerID, &ban.UserID, &ban.Username, &ban.Reason, &ban.BannedBy, &ban.CreatedAt, &ban.ExpiresAt,
	)
	return ban, err
}

// Create — INSERT OR REPLACE so re-banning an already-banned user (e.g.
// extending an existing temp ban) refreshes the row instead of failing
// on the PRIMARY KEY (server_id, user_id) conflict.
func (r *sqliteBanRepo) Create(ctx context.Context, ban *models.Ban) error {
	query := `
		INSERT OR REPLACE INTO bans (server_id, user_id, username, reason, banned_by, expires_at)
		VALUES (?, ?, ?, ?, ?, ?)`

	if _, err := r.db.ExecContext(ctx, query,
		ban.ServerID, ban.UserID, ban.Username, ban.Reason, ban.BannedBy, ban.ExpiresAt,
	); err != nil {
		return fmt.Errorf("failed to create ban: %w", err)
	}

	// Best-effort read-back of the DB-side default created_at (RETURNING avoided
	// for Turso/Hrana safety — see sqlite_user.go Create). Composite (server,user) PK.
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM bans WHERE server_id = ? AND user_id = ?", ban.ServerID, ban.UserID).Scan(&ban.CreatedAt)

	return nil
}

// GetByUserID returns the active ban row for (server, user), or
// ErrNotFound if the user is not banned OR the ban already expired.
// Filtering expired bans here means the caller never has to check the
// timestamp itself — the row is invisible the moment it lapses.
func (r *sqliteBanRepo) GetByUserID(ctx context.Context, serverID, userID string) (*models.Ban, error) {
	query := `
		SELECT server_id, user_id, username, reason, banned_by, created_at, expires_at
		FROM bans
		WHERE server_id = ? AND user_id = ?
		  AND (expires_at IS NULL OR expires_at > datetime('now'))`

	ban := &models.Ban{}
	err := r.db.QueryRowContext(ctx, query, serverID, userID).Scan(
		&ban.ServerID, &ban.UserID, &ban.Username, &ban.Reason, &ban.BannedBy, &ban.CreatedAt, &ban.ExpiresAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get ban by user id: %w", err)
	}

	return ban, nil
}

func (r *sqliteBanRepo) GetAllByServer(ctx context.Context, serverID string) ([]models.Ban, error) {
	// Lists only the bans still in effect — expired temp bans drop off
	// the management UI automatically.
	query := `
		SELECT server_id, user_id, username, reason, banned_by, created_at, expires_at
		FROM bans
		WHERE server_id = ?
		  AND (expires_at IS NULL OR expires_at > datetime('now'))
		ORDER BY created_at DESC`

	rows, err := r.db.QueryContext(ctx, query, serverID)
	if err != nil {
		return nil, fmt.Errorf("failed to get bans by server: %w", err)
	}
	return scanRows(rows, "ban", scanBan)
}

func (r *sqliteBanRepo) Delete(ctx context.Context, serverID, userID string) error {
	query := `DELETE FROM bans WHERE server_id = ? AND user_id = ?`

	result, err := r.db.ExecContext(ctx, query, serverID, userID)
	if err != nil {
		return fmt.Errorf("failed to delete ban: %w", err)
	}

	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("failed to check rows affected: %w", err)
	}
	if affected == 0 {
		return pkg.ErrNotFound
	}

	return nil
}

// Exists — true only when the user has an ACTIVE ban (permanent or a
// temp ban whose expires_at hasn't passed). Expired rows are ignored
// so login / WS-connect / channel-rejoin checks pass without needing
// a separate cleanup step.
func (r *sqliteBanRepo) Exists(ctx context.Context, serverID, userID string) (bool, error) {
	query := `
		SELECT 1 FROM bans
		WHERE server_id = ? AND user_id = ?
		  AND (expires_at IS NULL OR expires_at > datetime('now'))
		LIMIT 1`

	var dummy int
	err := r.db.QueryRowContext(ctx, query, serverID, userID).Scan(&dummy)

	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("failed to check ban existence: %w", err)
	}

	return true, nil
}
