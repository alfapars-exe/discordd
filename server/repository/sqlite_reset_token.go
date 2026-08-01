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

type sqliteResetTokenRepo struct {
	db database.TxQuerier
}

func NewSQLiteResetTokenRepo(db database.TxQuerier) PasswordResetRepository {
	return &sqliteResetTokenRepo{db: db}
}

func (r *sqliteResetTokenRepo) Create(ctx context.Context, token *models.PasswordResetToken) error {
	query := `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
		VALUES (?, ?, ?)`

	// expires_at is bound as a pre-formatted "YYYY-MM-DD HH:MM:SS" string, not
	// the raw time.Time — go-libsql writes time.Time as RFC3339 ("...T...Z"),
	// same bug class as sqlite_ban.go. Expiry itself is checked in Go
	// (auth_password.go: time.Now().After(resetToken.ExpiresAt)), so this did
	// not let an expired token through; DeleteExpired's SQL-side
	// `expires_at < CURRENT_TIMESTAMP` is the affected comparison — it never
	// matched RFC3339 rows, leaving expired tokens undeleted.
	_, err := r.db.ExecContext(ctx, query, token.UserID, token.TokenHash, token.ExpiresAt.UTC().Format("2006-01-02 15:04:05"))
	if err != nil {
		return fmt.Errorf("failed to create password reset token: %w", err)
	}

	return nil
}

func (r *sqliteResetTokenRepo) GetByTokenHash(ctx context.Context, tokenHash string) (*models.PasswordResetToken, error) {
	query := `SELECT id, user_id, token_hash, expires_at, created_at
		FROM password_reset_tokens WHERE token_hash = ?`

	token := &models.PasswordResetToken{}
	err := r.db.QueryRowContext(ctx, query, tokenHash).Scan(
		&token.ID, &token.UserID, &token.TokenHash, &token.ExpiresAt, &token.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get password reset token: %w", err)
	}

	return token, nil
}

func (r *sqliteResetTokenRepo) DeleteByID(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM password_reset_tokens WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete password reset token: %w", err)
	}
	return nil
}

func (r *sqliteResetTokenRepo) DeleteByUserID(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM password_reset_tokens WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user's password reset tokens: %w", err)
	}
	return nil
}

func (r *sqliteResetTokenRepo) DeleteExpired(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM password_reset_tokens WHERE expires_at < CURRENT_TIMESTAMP`)
	if err != nil {
		return fmt.Errorf("failed to delete expired password reset tokens: %w", err)
	}
	return nil
}

func (r *sqliteResetTokenRepo) GetLatestByUserID(ctx context.Context, userID string) (*models.PasswordResetToken, error) {
	query := `SELECT id, user_id, token_hash, expires_at, created_at
		FROM password_reset_tokens WHERE user_id = ?
		ORDER BY created_at DESC LIMIT 1`

	token := &models.PasswordResetToken{}
	err := r.db.QueryRowContext(ctx, query, userID).Scan(
		&token.ID, &token.UserID, &token.TokenHash, &token.ExpiresAt, &token.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get latest password reset token: %w", err)
	}

	return token, nil
}
