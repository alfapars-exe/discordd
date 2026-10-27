package database

import (
	"context"
	"database/sql"
	"fmt"
)

// SQLite table rebuilds must disable FK enforcement outside the transaction,
// on the same connection. Otherwise DROP TABLE executes cascading deletions.
// A remote driver that cannot honor these settings fails before any DDL runs.
func (db *DB) applyThreadChannelTypeMigration(filename, content string) (result error) {
	if db.remoteMigrationDSN != "" {
		return db.applyRemoteThreadChannelTypeMigration(filename, content)
	}
	ctx := context.Background()
	conn, err := db.Conn.Conn(ctx)
	if err != nil {
		return err
	}
	defer func() {
		if err := conn.Close(); err != nil && result == nil {
			result = fmt.Errorf("close thread migration connection: %w", err)
		}
	}()
	var original int
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&original); err != nil {
		return fmt.Errorf("thread migration requires foreign_keys support: %w", err)
	}
	restoreForeignKeys := "PRAGMA foreign_keys = OFF"
	if original != 0 {
		restoreForeignKeys = "PRAGMA foreign_keys = ON"
	}
	defer func() {
		_, err := conn.ExecContext(ctx, restoreForeignKeys)
		if err != nil && result == nil {
			result = fmt.Errorf("restore foreign keys after thread migration: %w", err)
		}
	}()
	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return fmt.Errorf("thread migration cannot safely disable foreign keys: %w", err)
	}
	var enabled int
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&enabled); err != nil || enabled != 0 {
		return fmt.Errorf("thread migration foreign keys remain enabled: value=%d error=%v", enabled, err)
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Acquire the SQLite write reservation before taking any transaction
	// snapshot. This is the BEGIN IMMEDIATE equivalent for database/sql's
	// already-open transaction, and serializes concurrent startup migrations.
	if _, err := tx.ExecContext(ctx, "UPDATE schema_migrations SET filename=filename WHERE 0"); err != nil {
		return err
	}
	var applied int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM schema_migrations WHERE filename=?", filename).Scan(&applied); err != nil {
		return err
	}
	if applied != 0 {
		return tx.Commit()
	}
	// Legacy libSQL installations can already contain orphan rows. Reject only
	// violations introduced by this rebuild, keeping existing rows for startup
	// repair rather than making an unrelated orphan prevent every future boot.
	before, err := threadMigrationForeignKeyViolations(ctx, tx)
	if err != nil {
		return err
	}
	// Preserve installation-specific indexes/triggers as well as the standard
	// indexes recreated by the SQL file.
	objects, err := tx.QueryContext(ctx, "SELECT name, sql FROM sqlite_master WHERE tbl_name='channels' AND type IN ('index','trigger') AND sql IS NOT NULL")
	if err != nil {
		return err
	}
	type schemaObject struct{ name, sql string }
	var saved []schemaObject
	for objects.Next() {
		var object schemaObject
		if err := objects.Scan(&object.name, &object.sql); err != nil {
			objects.Close()
			return err
		}
		saved = append(saved, object)
	}
	objectErr := objects.Err()
	objects.Close()
	if objectErr != nil {
		return objectErr
	}
	if err := execStatementsTx(tx, filename, content); err != nil {
		return err
	}
	for _, object := range saved {
		var count int
		if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE name=?", object.name).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			if _, err := tx.ExecContext(ctx, object.sql); err != nil {
				return fmt.Errorf("restore channel schema object %s: %w", object.name, err)
			}
		}
	}
	after, err := threadMigrationForeignKeyViolations(ctx, tx)
	if err != nil {
		return err
	}
	for violation := range after {
		if _, existed := before[violation]; !existed {
			return fmt.Errorf("thread migration introduced foreign key violation in %s", violation.table)
		}
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations(filename) VALUES (?)", filename); err != nil {
		return err
	}
	return tx.Commit()
}

type threadMigrationFKViolation struct {
	table, parent string
	rowID         sql.NullInt64
	foreignKeyID  int64
}

func threadMigrationForeignKeyViolations(ctx context.Context, tx *sql.Tx) (map[threadMigrationFKViolation]struct{}, error) {
	rows, err := tx.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return nil, fmt.Errorf("thread migration cannot validate foreign keys: %w", err)
	}
	defer rows.Close()
	violations := make(map[threadMigrationFKViolation]struct{})
	for rows.Next() {
		var violation threadMigrationFKViolation
		if err := rows.Scan(&violation.table, &violation.rowID, &violation.parent, &violation.foreignKeyID); err != nil {
			return nil, fmt.Errorf("thread migration cannot read foreign key violation: %w", err)
		}
		violations[violation] = struct{}{}
	}
	return violations, rows.Err()
}
