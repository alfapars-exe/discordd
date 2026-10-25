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

type AccountLifecycleRepository interface {
	Get(context.Context, string) (*models.AccountLifecycle, error)
	Disable(context.Context, string, string, string, int64) error
	RestoreWithSession(context.Context, string, int64, string, *models.AuthSession, *models.Session) error
}
type sqliteAccountLifecycleRepo struct{ db database.TxQuerier }

func (r *sqliteAccountLifecycleRepo) transaction(ctx context.Context, fn func(*sql.Tx) error) error {
	raw := database.RawDB(r.db)
	if raw == nil {
		return fmt.Errorf("account lifecycle requires a transactional database")
	}
	return database.WithTx(ctx, raw, fn)
}
func NewSQLiteAccountLifecycleRepo(db database.TxQuerier) AccountLifecycleRepository {
	return &sqliteAccountLifecycleRepo{db: db}
}
func (r *sqliteAccountLifecycleRepo) Get(ctx context.Context, owner string) (*models.AccountLifecycle, error) {
	var disabled sql.NullInt64
	var state models.AccountLifecycle
	err := r.db.QueryRowContext(ctx, `SELECT a.disabled_at,COALESCE(a.version,0) FROM users u LEFT JOIN account_lifecycle a ON a.user_id=u.id WHERE u.id=?`, owner).Scan(&disabled, &state.Version)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if disabled.Valid {
		state.DisabledAt = &disabled.Int64
	}
	return &state, nil
}
func (r *sqliteAccountLifecycleRepo) Disable(ctx context.Context, owner, sid, expectedHash string, now int64) error {
	return r.transaction(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE users SET status='offline',last_seen_at=CURRENT_TIMESTAMP,token_version=token_version+1 WHERE id=? AND password_hash=? AND is_bot=0 AND is_platform_banned=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=? AND disabled_at IS NOT NULL) AND EXISTS(SELECT 1 FROM auth_sessions WHERE id=? AND user_id=users.id AND token_version=users.token_version AND revoked_at IS NULL AND expires_at>?)`, owner, expectedHash, owner, sid, now)
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
		if _, err := tx.ExecContext(ctx, `INSERT INTO account_lifecycle(user_id,disabled_at,version) VALUES(?,?,1) ON CONFLICT(user_id) DO UPDATE SET disabled_at=excluded.disabled_at,version=account_lifecycle.version+1`, owner, now); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE user_id=?`, now, owner); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM sessions WHERE user_id=?`, owner)
		return err
	})
}
func (r *sqliteAccountLifecycleRepo) RestoreWithSession(ctx context.Context, owner string, version int64, expectedHash string, logical *models.AuthSession, refresh *models.Session) error {
	if logical == nil || refresh == nil || logical.UserID != owner || refresh.UserID != owner || logical.TokenVersion < 1 {
		return pkg.ErrBadRequest
	}
	return r.transaction(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE users SET token_version=token_version+1,status='online' WHERE id=? AND password_hash=? AND token_version=? AND is_bot=0 AND is_platform_banned=0 AND EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=? AND disabled_at IS NOT NULL AND version=?)`, owner, expectedHash, logical.TokenVersion-1, owner, version)
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
		if _, err := tx.ExecContext(ctx, `UPDATE account_lifecycle SET disabled_at=NULL,version=version+1 WHERE user_id=? AND version=?`, owner, version); err != nil {
			return err
		}
		if err := NewSQLiteAuthSessionRepo(tx).Create(ctx, logical); err != nil {
			return err
		}
		refresh.AuthSessionID = logical.ID
		refresh.TokenVersion = logical.TokenVersion
		return NewSQLiteSessionRepo(tx).Create(ctx, refresh)
	})
}
