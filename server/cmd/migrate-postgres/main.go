// migrate-postgres rehearses an offline SQLite snapshot in a new PostgreSQL
// schema. It never changes DATABASE_URL or enables application writes.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"time"

	"github.com/argeinfina/hichat/database"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	input := flag.String("snapshot", "", "offline SQLite snapshot; the original is never migrated")
	flag.Parse()
	if *input == "" {
		return fmt.Errorf("--snapshot is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	absolute, err := filepath.Abs(*input)
	if err != nil {
		return err
	}
	if info, err := os.Stat(absolute); err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("snapshot must be an existing regular file")
	}
	sourceURL := url.URL{Scheme: "file", Path: filepath.ToSlash(absolute)}
	q := sourceURL.Query()
	q.Set("mode", "ro")
	sourceURL.RawQuery = q.Encode()
	original, err := sql.Open("sqlite", sourceURL.String())
	if err != nil {
		return err
	}
	defer original.Close()
	work, err := os.MkdirTemp("", "hichat-import-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(work)
	copyPath := filepath.Join(work, "snapshot.db")
	// VACUUM INTO gives a consistent local copy, including any committed WAL.
	if _, err = original.ExecContext(ctx, `VACUUM INTO ?`, copyPath); err != nil {
		return fmt.Errorf("snapshot copy failed: %w", err)
	}
	migrations, err := fs.Sub(database.EmbeddedMigrations, "migrations")
	if err != nil {
		return err
	}
	source, err := database.New(copyPath, migrations)
	if err != nil {
		return fmt.Errorf("copy migration failed: %w", err)
	}
	defer source.Close()
	var integrity string
	if err = source.Conn.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil || integrity != "ok" {
		return fmt.Errorf("SQLite copy integrity check failed")
	}
	dsn := os.Getenv("HICHAT_POSTGRES_URL")
	admin, err := database.OpenPostgres(ctx, dsn)
	if err != nil {
		return err
	}
	defer admin.Close()
	schema := fmt.Sprintf("hichat_import_%d", time.Now().UnixNano())
	if _, err = admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		return fmt.Errorf("create rehearsal schema failed")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		return fmt.Errorf("invalid target URL")
	}
	query := u.Query()
	query.Set("search_path", schema+",public")
	u.RawQuery = query.Encode()
	target, err := database.OpenPostgres(ctx, u.String())
	if err != nil {
		return err
	}
	defer target.Close()
	if err = database.MigratePostgres(ctx, target); err != nil {
		return err
	}
	report, err := database.ImportSQLiteSnapshot(ctx, source.Conn, target)
	if err != nil {
		return fmt.Errorf("rehearsal %s failed; no cutover occurred: %w", schema, err)
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Schema   string                       `json:"schema"`
		Verified bool                         `json:"verified"`
		Tables   []database.ImportTableReport `json:"tables"`
	}{schema, true, report})
}
