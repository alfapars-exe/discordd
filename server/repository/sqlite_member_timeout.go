package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
)

type sqliteMemberTimeoutRepo struct {
	db database.TxQuerier
}

func NewSQLiteMemberTimeoutRepo(db database.TxQuerier) MemberTimeoutRepository {
	return &sqliteMemberTimeoutRepo{db: db}
}

// Upsert — INSERT OR REPLACE so re-timing an already timed-out user
// extends the duration without leaving stale rows. The PRIMARY KEY is
// (server_id, user_id), so the REPLACE keeps exactly one row per user
// per server.
func (r *sqliteMemberTimeoutRepo) Upsert(ctx context.Context, t *models.MemberTimeout) error {
	query := `
		INSERT OR REPLACE INTO member_timeouts
			(server_id, user_id, expires_at, applied_by, reason)
		VALUES (?, ?, ?, ?, ?)
		RETURNING created_at`
	err := r.db.QueryRowContext(ctx, query,
		t.ServerID, t.UserID, t.ExpiresAt, t.AppliedBy, t.Reason,
	).Scan(&t.CreatedAt)
	if err != nil {
		return fmt.Errorf("upsert member_timeout: %w", err)
	}
	return nil
}

// Get — returns the active timeout for (server, user), or (nil, nil)
// if the user is not currently timed out. Expired rows are filtered
// out by the WHERE clause so the caller never has to compare times.
func (r *sqliteMemberTimeoutRepo) Get(ctx context.Context, serverID, userID string) (*models.MemberTimeout, error) {
	query := `
		SELECT server_id, user_id, expires_at, applied_by, reason, created_at
		FROM member_timeouts
		WHERE server_id = ? AND user_id = ?
		  AND expires_at > datetime('now')`
	t := &models.MemberTimeout{}
	err := r.db.QueryRowContext(ctx, query, serverID, userID).Scan(
		&t.ServerID, &t.UserID, &t.ExpiresAt, &t.AppliedBy, &t.Reason, &t.CreatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get member_timeout: %w", err)
	}
	return t, nil
}

// Delete — lift the timeout. Returns nil even when the row didn't
// exist: an explicit un-timeout for a user who isn't muted is a no-op
// from the caller's perspective, not a 404.
func (r *sqliteMemberTimeoutRepo) Delete(ctx context.Context, serverID, userID string) error {
	_, err := r.db.ExecContext(ctx,
		`DELETE FROM member_timeouts WHERE server_id = ? AND user_id = ?`,
		serverID, userID,
	)
	if err != nil {
		return fmt.Errorf("delete member_timeout: %w", err)
	}
	return nil
}

// IsActive — fast existence check used on every Send-Message and
// JoinChannel call. Same expiry filter as Get; returns false for
// rows whose expires_at has passed (without needing a cleanup job).
func (r *sqliteMemberTimeoutRepo) IsActive(ctx context.Context, serverID, userID string) (bool, error) {
	var dummy int
	err := r.db.QueryRowContext(ctx,
		`SELECT 1 FROM member_timeouts
		 WHERE server_id = ? AND user_id = ?
		   AND expires_at > datetime('now')
		 LIMIT 1`,
		serverID, userID,
	).Scan(&dummy)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check member_timeout active: %w", err)
	}
	return true, nil
}

// ListActive — bulk fetch of non-expired timeouts for one server.
// Used by member_service.GetAll so the member list can be tagged with
// "timed out until X" without an N+1 of single-row Gets. Same
// expires_at filter as Get so callers never see expired rows.
func (r *sqliteMemberTimeoutRepo) ListActive(ctx context.Context, serverID string) ([]models.MemberTimeout, error) {
	rows, err := r.db.QueryContext(ctx,
		`SELECT server_id, user_id, expires_at, applied_by, reason, created_at
		 FROM member_timeouts
		 WHERE server_id = ?
		   AND expires_at > datetime('now')`,
		serverID,
	)
	if err != nil {
		return nil, fmt.Errorf("list active member_timeouts: %w", err)
	}
	defer rows.Close()

	var out []models.MemberTimeout
	for rows.Next() {
		var t models.MemberTimeout
		if err := rows.Scan(&t.ServerID, &t.UserID, &t.ExpiresAt, &t.AppliedBy, &t.Reason, &t.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan member_timeout row: %w", err)
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate member_timeout rows: %w", err)
	}
	return out, nil
}
