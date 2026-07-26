// Package repository — core sqliteUserRepo type, constructor, base user
// CRUD (Create/Delete), and the package-local unique-violation helpers.
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

type sqliteUserRepo struct {
	db database.TxQuerier
	// rawDB is the underlying *sql.DB reached by unwrapping db (see
	// database.RawDB) — nil when constructed inside another transaction (db
	// is already a *sql.Tx, which has nothing further to unwrap).
	// CreateWithSession requires it because it opens its own transaction via
	// database.WithTx.
	rawDB *sql.DB
}

func NewSQLiteUserRepo(db database.TxQuerier) UserRepository {
	return &sqliteUserRepo{db: db, rawDB: database.RawDB(db)}
}

func (r *sqliteUserRepo) Create(ctx context.Context, user *models.User) error {
	id, err := generateID()
	if err != nil {
		return fmt.Errorf("failed to create user: %w", err)
	}
	user.ID = id

	query := `
		INSERT INTO users (id, username, display_name, avatar_url, password_hash, status, email, language, is_platform_admin)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`

	_, err = r.db.ExecContext(ctx, query,
		user.ID,
		user.Username,
		user.DisplayName,
		user.AvatarURL,
		user.PasswordHash,
		user.Status,
		user.Email,
		user.Language,
		user.IsPlatformAdmin,
	)

	if err != nil {
		if isUniqueViolation(err) {
			if containsString(err.Error(), "idx_users_email") {
				return fmt.Errorf("%w: email already in use", pkg.ErrAlreadyExists)
			}
			return fmt.Errorf("%w: username already taken", pkg.ErrAlreadyExists)
		}
		return fmt.Errorf("failed to create user: %w", err)
	}

	// created_at is DB-side DEFAULT CURRENT_TIMESTAMP (001_init.sql), written
	// as SQLite "YYYY-MM-DD HH:MM:SS" text. Deliberately NOT set from Go — a
	// time.Time bind would write RFC3339 into the same column, silently
	// mixing two date-string formats and breaking string-ordered queries.
	// Best-effort read-back; must never turn a successful insert into a 500.
	_ = r.db.QueryRowContext(ctx, "SELECT created_at FROM users WHERE id = ?", user.ID).Scan(&user.CreatedAt)

	return nil
}

func (r *sqliteUserRepo) Delete(ctx context.Context, id string) error {
	query := `DELETE FROM users WHERE id = ?`

	result, err := r.db.ExecContext(ctx, query, id)
	if err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
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

func isUniqueViolation(err error) bool {
	return err != nil && !errors.Is(err, sql.ErrNoRows) &&
		(containsString(err.Error(), "UNIQUE constraint failed"))
}

func containsString(s, substr string) bool {
	return len(s) >= len(substr) && searchString(s, substr)
}

func searchString(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
