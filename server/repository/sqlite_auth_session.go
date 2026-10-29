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

type sqliteAuthSessionRepo struct{ db database.TxQuerier }

func NewSQLiteAuthSessionRepo(db database.TxQuerier) AuthSessionRepository {
	return &sqliteAuthSessionRepo{db: db}
}

func (r *sqliteAuthSessionRepo) Create(ctx context.Context, s *models.AuthSession) error {
	result, err := r.db.ExecContext(ctx, `INSERT INTO auth_sessions(id,user_id,token_version,client_type,user_agent,created_at,last_active_at,expires_at) SELECT ?,?,?,?,?,?,?,? FROM users WHERE id=? AND token_version=? AND is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=users.id AND disabled_at IS NOT NULL)`, s.ID, s.UserID, s.TokenVersion, s.ClientType, s.UserAgent, s.CreatedAt, s.LastActiveAt, s.ExpiresAt, s.UserID, s.TokenVersion)
	if err != nil {
		return err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return pkg.ErrUnauthorized
	}
	return nil
}

func (r *sqliteAuthSessionRepo) transaction(ctx context.Context, fn func(*sql.Tx) error) error {
	raw := database.RawDB(r.db)
	if raw == nil {
		return fmt.Errorf("auth sessions require a transactional database")
	}
	return database.WithTx(ctx, raw, fn)
}

func (r *sqliteAuthSessionRepo) CreateWithRefresh(ctx context.Context, s *models.AuthSession, refresh *models.Session) error {
	return r.transaction(ctx, func(tx *sql.Tx) error {
		if err := NewSQLiteAuthSessionRepo(tx).Create(ctx, s); err != nil {
			return err
		}
		refresh.AuthSessionID = s.ID
		refresh.TokenVersion = s.TokenVersion
		if err := (&sqliteSessionRepo{db: tx}).Create(ctx, refresh); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE users SET status='online' WHERE id=?`, s.UserID)
		return err
	})
}

func (r *sqliteAuthSessionRepo) RotateRefresh(ctx context.Context, old, next *models.Session, logical *models.AuthSession, now int64) (bool, error) {
	rotated := false
	err := r.transaction(ctx, func(tx *sql.Tx) error {
		// Consume exactly the presented refresh row. A concurrent rotation
		// that loses this CAS must not issue a second token/session.
		result, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE id=? AND user_id=? AND refresh_token_hash=? AND token_version=?`, old.ID, old.UserID, hashRefreshToken(old.RefreshToken), old.TokenVersion)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return pkg.ErrUnauthorized
		}
		if old.AuthSessionID == "" {
			if err := NewSQLiteAuthSessionRepo(tx).Create(ctx, logical); err != nil {
				return err
			}
		} else {
			result, err = tx.ExecContext(ctx, `UPDATE auth_sessions SET last_active_at=?,expires_at=?,client_type=CASE WHEN client_type='unknown' THEN ? ELSE client_type END,user_agent=CASE WHEN user_agent='' THEN ? ELSE user_agent END WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>? AND token_version=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND token_version=? AND is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=users.id AND disabled_at IS NOT NULL))`, now, logical.ExpiresAt, logical.ClientType, logical.UserAgent, logical.ID, old.UserID, now, old.TokenVersion, old.UserID, old.TokenVersion)
			if err != nil {
				return err
			}
			n, err = result.RowsAffected()
			if err != nil {
				return err
			}
			if n != 1 {
				return pkg.ErrUnauthorized
			}
		}
		next.AuthSessionID = logical.ID
		next.TokenVersion = logical.TokenVersion
		if err := (&sqliteSessionRepo{db: tx}).Create(ctx, next); err != nil {
			return err
		}
		rotated = true
		return nil
	})
	if errors.Is(err, pkg.ErrUnauthorized) {
		return false, nil
	}
	return rotated, err
}

const authSessionColumns = `a.id,a.user_id,a.token_version,a.client_type,a.user_agent,a.created_at,a.last_active_at,a.expires_at`

func scanAuthSession(row interface{ Scan(...any) error }) (*models.AuthSession, error) {
	var s models.AuthSession
	err := row.Scan(&s.ID, &s.UserID, &s.TokenVersion, &s.ClientType, &s.UserAgent, &s.CreatedAt, &s.LastActiveAt, &s.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	return &s, err
}
func (r *sqliteAuthSessionRepo) GetActive(ctx context.Context, userID, id string, now int64) (*models.AuthSession, error) {
	s, err := scanAuthSession(r.db.QueryRowContext(ctx, `SELECT `+authSessionColumns+` FROM auth_sessions a JOIN users u ON u.id=a.user_id AND u.token_version=a.token_version WHERE a.id=? AND a.user_id=? AND a.revoked_at IS NULL AND a.expires_at>? AND u.is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=u.id AND disabled_at IS NOT NULL)`, id, userID, now))
	if err == nil && s.LastActiveAt < now-60 {
		if result, writeErr := r.db.ExecContext(ctx, `UPDATE auth_sessions SET last_active_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL AND last_active_at<?`, now, id, userID, now-60); writeErr == nil {
			if n, _ := result.RowsAffected(); n == 1 {
				s.LastActiveAt = now
			}
		}
	}
	return s, err
}
func (r *sqliteAuthSessionRepo) ListActive(ctx context.Context, userID string, now int64) ([]models.AuthSession, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT `+authSessionColumns+` FROM auth_sessions a JOIN users u ON u.id=a.user_id AND u.token_version=a.token_version WHERE a.user_id=? AND a.revoked_at IS NULL AND a.expires_at>? ORDER BY a.last_active_at DESC,a.id`, userID, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]models.AuthSession, 0)
	for rows.Next() {
		s, err := scanAuthSession(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *s)
	}
	return result, rows.Err()
}
func (r *sqliteAuthSessionRepo) Revoke(ctx context.Context, userID, id string, now int64, currentIDs ...string) (bool, error) {
	query := `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=? AND id=?`
	args := []any{now, userID, id}
	if len(currentIDs) > 0 {
		query += ` AND EXISTS(SELECT 1 FROM auth_sessions actor JOIN users u ON u.id=actor.user_id AND u.token_version=actor.token_version WHERE actor.id=? AND actor.user_id=? AND actor.revoked_at IS NULL AND actor.expires_at>?)`
		args = append(args, currentIDs[0], userID, now)
	}
	result, err := r.db.ExecContext(ctx, query, args...)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}
func (r *sqliteAuthSessionRepo) RevokeOthers(ctx context.Context, userID, current string, now int64) ([]string, error) {
	var ids []string
	err := r.transaction(ctx, func(tx *sql.Tx) error {
		if _, err := NewSQLiteAuthSessionRepo(tx).GetActive(ctx, userID, current, now); err != nil {
			if errors.Is(err, pkg.ErrNotFound) {
				return pkg.ErrUnauthorized
			}
			return err
		}
		rows, err := tx.QueryContext(ctx, `SELECT id FROM auth_sessions WHERE user_id=? AND id<>? AND revoked_at IS NULL AND expires_at>?`, userID, current, now)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()
		_, err = tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at=? WHERE user_id=? AND id<>? AND revoked_at IS NULL`, now, userID, current)
		return err
	})
	return ids, err
}
func (r *sqliteAuthSessionRepo) RevokeAll(ctx context.Context, userID string, now int64) error {
	return r.transaction(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `UPDATE users SET token_version=token_version+1 WHERE id=?`, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?`, now, userID); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=?`, userID)
		return err
	})
}

// UpdatePasswordAndRevoke commits the credential, reset-token consumption and
// every sign-in invalidation together. Exactly one proof is accepted: the
// password hash already checked by the service, or a live reset-token hash.
func (r *sqliteAuthSessionRepo) UpdatePasswordAndRevoke(ctx context.Context, userID, expectedHash, resetHash, newHash string, now int64) error {
	if (expectedHash == "") == (resetHash == "") || newHash == "" {
		return pkg.ErrBadRequest
	}
	return r.transaction(ctx, func(tx *sql.Tx) error {
		query := `UPDATE users SET password_hash=?,token_version=token_version+1 WHERE id=?`
		args := []any{newHash, userID}
		if expectedHash != "" {
			query += ` AND password_hash=?`
			args = append(args, expectedHash)
		} else {
			query += ` AND EXISTS(SELECT 1 FROM password_reset_tokens WHERE user_id=? AND token_hash=? AND ` + epochSecondsSQL(r.db, "expires_at") + `>?)`
			args = append(args, userID, resetHash, now)
		}
		result, err := tx.ExecContext(ctx, query, args...)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return pkg.ErrUnauthorized
		}
		if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?`, now, userID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=?`, userID); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM password_reset_tokens WHERE user_id=?`, userID)
		return err
	})
}
