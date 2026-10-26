package database

import (
	"context"
	"fmt"
)

// SQLite table rebuilds must disable FK enforcement outside the transaction,
// on the same connection. Otherwise DROP TABLE executes cascading deletions.
// A remote driver that cannot honor these settings fails before any DDL runs.
func (db *DB) applyThreadChannelTypeMigration(filename, content string) (result error) {
	ctx := context.Background()
	conn, err := db.Conn.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	var original int
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&original); err != nil {
		return fmt.Errorf("thread migration requires foreign_keys support: %w", err)
	}
	defer func() {
		_, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA foreign_keys = %d", original))
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
	rows, err := tx.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("thread migration cannot validate foreign keys: %w", err)
	}
	violations := rows.Next()
	checkErr := rows.Err()
	rows.Close()
	if checkErr != nil {
		return checkErr
	}
	if violations {
		return fmt.Errorf("thread migration foreign key validation failed")
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations(filename) VALUES (?)", filename); err != nil {
		return err
	}
	return tx.Commit()
}
