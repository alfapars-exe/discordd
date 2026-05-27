package repository

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
	"github.com/argeinfina/hichat/models"
	"github.com/argeinfina/hichat/pkg"
)

type sqliteSessionRepo struct {
	db database.TxQuerier
}

func NewSQLiteSessionRepo(db database.TxQuerier) SessionRepository {
	return &sqliteSessionRepo{db: db}
}

// hashRefreshToken returns the at-rest representation of a refresh token.
// SHA-256 is fine here — refresh tokens are 32+ bytes of unpredictable
// random data, so no password-grade KDF (bcrypt/argon2) is needed to
// resist offline brute-force; the input space is already too large to
// guess. The goal is solely to make stolen DB rows unusable as
// credentials.
func hashRefreshToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func (r *sqliteSessionRepo) Create(ctx context.Context, session *models.Session) error {
	// We persist only the hash. The legacy `refresh_token` column is
	// declared NOT NULL **and** UNIQUE in migration 001, so we can't
	// write SQL NULL here, and we can't write a shared sentinel ('' or
	// 'deprecated') either — the second login would trip the UNIQUE
	// constraint. Bind the same hash into both columns: it satisfies
	// NOT NULL, satisfies UNIQUE (SHA-256 of a 32-byte random token
	// collides with probability ~1/2^128), and the legacy column
	// stays dead data because every lookup goes through
	// refresh_token_hash. A follow-up migration will rebuild the
	// table to drop the column outright once every live deployment
	// has rolled past 067.
	hash := hashRefreshToken(session.RefreshToken)
	query := `
		INSERT INTO sessions (id, user_id, refresh_token_hash, refresh_token, expires_at)
		VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?)
		RETURNING id, created_at`

	err := r.db.QueryRowContext(ctx, query,
		session.UserID,
		hash,
		hash, // legacy NOT NULL + UNIQUE column — reuse hash for uniqueness
		session.ExpiresAt,
	).Scan(&session.ID, &session.CreatedAt)

	if err != nil {
		return fmt.Errorf("failed to create session: %w", err)
	}

	return nil
}

func (r *sqliteSessionRepo) GetByRefreshToken(ctx context.Context, token string) (*models.Session, error) {
	// Look up by hash. Pre-067 rows have refresh_token_hash IS NULL and
	// were invalidated by the migration, so the lookup will only find
	// rows created since the upgrade.
	hash := hashRefreshToken(token)
	query := `
		SELECT id, user_id, refresh_token, expires_at, created_at
		FROM sessions WHERE refresh_token_hash = ?`

	session := &models.Session{}
	var storedToken sql.NullString
	err := r.db.QueryRowContext(ctx, query, hash).Scan(
		&session.ID, &session.UserID, &storedToken,
		&session.ExpiresAt, &session.CreatedAt,
	)

	if errors.Is(err, sql.ErrNoRows) {
		return nil, pkg.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("failed to get session by refresh token: %w", err)
	}

	// Echo the caller-supplied token back into the model so existing
	// callers (auth service rotation flow, logout) keep working without
	// having to learn about the hash split.
	session.RefreshToken = token
	return session, nil
}

func (r *sqliteSessionRepo) DeleteByID(ctx context.Context, id string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("failed to delete session: %w", err)
	}
	return nil
}

func (r *sqliteSessionRepo) DeleteByUserID(ctx context.Context, userID string) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE user_id = ?`, userID)
	if err != nil {
		return fmt.Errorf("failed to delete user sessions: %w", err)
	}
	return nil
}

func (r *sqliteSessionRepo) DeleteExpired(ctx context.Context) error {
	_, err := r.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < CURRENT_TIMESTAMP`)
	if err != nil {
		return fmt.Errorf("failed to delete expired sessions: %w", err)
	}
	return nil
}
