package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/argeinfina/hichat/database"
)

type sqliteUserNoteRepo struct {
	db database.TxQuerier
}

func NewSQLiteUserNoteRepo(db database.TxQuerier) UserNoteRepository {
	return &sqliteUserNoteRepo{db: db}
}

func (r *sqliteUserNoteRepo) Get(ctx context.Context, ownerUserID, targetUserID string) (string, *string, error) {
	var note, updatedAt string
	err := r.db.QueryRowContext(ctx,
		`SELECT note, updated_at FROM user_notes WHERE owner_user_id = ? AND target_user_id = ?`,
		ownerUserID, targetUserID,
	).Scan(&note, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, nil
	}
	if err != nil {
		return "", nil, fmt.Errorf("failed to get user note: %w", err)
	}
	ts := dbTextToRFC3339(updatedAt)
	return note, &ts, nil
}

// Upsert — ON CONFLICT on the composite primary key (same upsert form as
// sqlite_channel_permission.go Set). updated_at is DB-side datetime('now')
// text so lexical ordering stays correct on Turso; it is read back (no
// RETURNING — Turso/Hrana safety, see sqlite_user.go Create) and converted
// to RFC3339 for the API boundary.
func (r *sqliteUserNoteRepo) Upsert(ctx context.Context, ownerUserID, targetUserID, note string) (string, error) {
	if _, err := r.db.ExecContext(ctx,
		`INSERT INTO user_notes (owner_user_id, target_user_id, note, updated_at)
		 VALUES (?, ?, ?, datetime('now'))
		 ON CONFLICT(owner_user_id, target_user_id) DO UPDATE SET
		   note = excluded.note,
		   updated_at = excluded.updated_at`,
		ownerUserID, targetUserID, note,
	); err != nil {
		return "", fmt.Errorf("failed to upsert user note: %w", err)
	}

	var updatedAt string
	if err := r.db.QueryRowContext(ctx,
		`SELECT updated_at FROM user_notes WHERE owner_user_id = ? AND target_user_id = ?`,
		ownerUserID, targetUserID,
	).Scan(&updatedAt); err != nil {
		return "", fmt.Errorf("failed to read back user note timestamp: %w", err)
	}
	return dbTextToRFC3339(updatedAt), nil
}

func (r *sqliteUserNoteRepo) Delete(ctx context.Context, ownerUserID, targetUserID string) error {
	if _, err := r.db.ExecContext(ctx,
		`DELETE FROM user_notes WHERE owner_user_id = ? AND target_user_id = ?`,
		ownerUserID, targetUserID,
	); err != nil {
		return fmt.Errorf("failed to delete user note: %w", err)
	}
	return nil
}
