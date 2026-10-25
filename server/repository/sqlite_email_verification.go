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

type EmailVerificationRepository interface {
	Status(context.Context, string, int64) (*models.EmailVerificationStatus, error)
	Reserve(context.Context, string, int64, string, int64, int64) (bool, error)
	Consume(context.Context, string, int64) (bool, error)
}
type sqliteEmailVerificationRepo struct{ db database.TxQuerier }

func NewSQLiteEmailVerificationRepo(db database.TxQuerier) EmailVerificationRepository {
	return &sqliteEmailVerificationRepo{db: db}
}
func (r *sqliteEmailVerificationRepo) Status(ctx context.Context, owner string, now int64) (*models.EmailVerificationStatus, error) {
	var status models.EmailVerificationStatus
	var verified, last sql.NullInt64
	err := r.db.QueryRowContext(ctx, `SELECT u.email,u.email_generation,u.email_verified_at,t.last_requested_at FROM users u LEFT JOIN account_email_tokens t ON t.user_id=u.id WHERE u.id=?`, owner).Scan(&status.Email, &status.Generation, &verified, &last)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	status.Verified = status.Email != nil && verified.Valid
	if status.Verified {
		status.VerifiedAt = &verified.Int64
	}
	if last.Valid && last.Int64+60 > now {
		status.RetryAfter = last.Int64 + 60 - now
	}
	return &status, nil
}
func (r *sqliteEmailVerificationRepo) Reserve(ctx context.Context, owner string, generation int64, hash string, now, expires int64) (bool, error) {
	result, err := r.db.ExecContext(ctx, `INSERT INTO account_email_tokens(user_id,email,generation,token_hash,expires_at,last_requested_at)
SELECT id,email,email_generation,?,?,? FROM users WHERE id=? AND email IS NOT NULL AND email<>'' AND email_generation=? AND email_verified_at IS NULL AND is_platform_banned=0 AND is_bot=0 AND NOT EXISTS(SELECT 1 FROM account_lifecycle WHERE user_id=users.id AND disabled_at IS NOT NULL)
ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,generation=excluded.generation,token_hash=excluded.token_hash,expires_at=excluded.expires_at,last_requested_at=excluded.last_requested_at WHERE account_email_tokens.last_requested_at<=?`, hash, expires, now, owner, generation, now-60)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}
func (r *sqliteEmailVerificationRepo) Consume(ctx context.Context, hash string, now int64) (bool, error) {
	raw := database.RawDB(r.db)
	if raw == nil {
		return false, fmt.Errorf("email verification requires a transactional database")
	}
	consumed := false
	err := database.WithTx(ctx, raw, func(tx *sql.Tx) error {
		var owner, address string
		var generation int64
		err := tx.QueryRowContext(ctx, `SELECT user_id,email,generation FROM account_email_tokens WHERE token_hash=? AND expires_at>?`, hash, now).Scan(&owner, &address, &generation)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		result, err := tx.ExecContext(ctx, `UPDATE users SET email_verified_at=? WHERE id=? AND email=? AND email_generation=? AND email_verified_at IS NULL`, now, owner, address, generation)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM account_email_tokens WHERE token_hash=?`, hash); err != nil {
			return err
		}
		consumed = true
		return nil
	})
	return consumed && err == nil, err
}
