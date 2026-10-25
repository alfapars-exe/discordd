package database

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
)

//go:embed postgres_migrations/*.sql
var postgresMigrations embed.FS

// MigratePostgres applies only native PostgreSQL migrations, atomically and
// under an advisory lock. Existing SQLite migration history is kept separate.
func MigratePostgres(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(7341982001)"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS postgres_schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)"); err != nil {
		return err
	}
	entries, err := postgresMigrations.ReadDir("postgres_migrations")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		var applied bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT FROM postgres_schema_migrations WHERE filename=$1)", entry.Name()).Scan(&applied); err != nil {
			return err
		}
		if applied {
			continue
		}
		b, err := postgresMigrations.ReadFile("postgres_migrations/" + entry.Name())
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, string(b)); err != nil {
			return fmt.Errorf("PostgreSQL migration %s: %w", entry.Name(), err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO postgres_schema_migrations(filename) VALUES($1)", entry.Name()); err != nil {
			return err
		}
	}
	return tx.Commit()
}
