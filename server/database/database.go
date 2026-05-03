package database

import (
	"database/sql"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	_ "github.com/tursodatabase/go-libsql" // CGO-based libSQL driver for remote Turso (registers "libsql")
	_ "modernc.org/sqlite"                 // pure-Go SQLite driver for local files (registers "sqlite")
)

// recoverableErrors lists error patterns that can be safely skipped
// when re-running a partially applied migration (e.g. "duplicate column name").
var recoverableErrors = []string{
	"duplicate column name",
}

type DB struct {
	Conn *sql.DB
}

// isRemoteLibSQL reports whether the DSN points to a remote libSQL/Turso server
// rather than a local SQLite file. URLs starting with libsql://, http://, https://,
// ws://, or wss:// are treated as remote.
func isRemoteLibSQL(dsn string) bool {
	for _, prefix := range []string{"libsql://", "https://", "http://", "wss://", "ws://"} {
		if strings.HasPrefix(dsn, prefix) {
			return true
		}
	}
	return false
}

// New opens a database connection and runs pending migrations.
// Supports both local SQLite (file path) and remote Turso/libSQL (libsql://...).
func New(dbPath string, migrationsFS fs.FS) (*DB, error) {
	var conn *sql.DB
	var err error

	if isRemoteLibSQL(dbPath) {
		// Turso/libSQL remote — connection-level pragmas don't apply (server manages WAL).
		conn, err = sql.Open("libsql", dbPath)
		if err != nil {
			return nil, fmt.Errorf("failed to open libsql database: %w", err)
		}
		log.Printf("[database] using remote libSQL backend")
	} else {
		// Local SQLite file — ensure parent directory exists.
		dir := filepath.Dir(dbPath)
		if err := os.MkdirAll(dir, 0755); err != nil {
			return nil, fmt.Errorf("failed to create database directory: %w", err)
		}

		// foreign_keys=on (off by default in SQLite), journal_mode=WAL for concurrent r/w,
		// busy_timeout=5000ms lets concurrent writers wait instead of returning SQLITE_BUSY immediately.
		conn, err = sql.Open("sqlite", dbPath+"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
		if err != nil {
			return nil, fmt.Errorf("failed to open sqlite database: %w", err)
		}
		log.Printf("[database] using local SQLite at %s", dbPath)
	}

	// Connection pool settings.
	//
	// For local SQLite the old comments still apply: MaxOpenConns=4 allows
	// concurrent reads (WAL serializes writes internally), MaxIdleConns=2
	// keeps warm connections ready.
	//
	// For remote Turso/libSQL there's an additional constraint: each *sql.Conn
	// maps to a Hrana stream on the Turso side, and Turso closes idle streams
	// after ~10 seconds. If we reuse a pooled conn after the stream is gone,
	// Prepare fails with:
	//   error code = 3: Hrana: api error: status=404 Not Found,
	//   body={"error":"stream not found: ..."}
	// This bit users on mobile where network latency widens the idle window.
	//
	// Fix: ConnMaxIdleTime=5s drops idle pool entries before Turso does, and
	// ConnMaxLifetime=5m bounds total connection age as a safety net. Both
	// are also harmless for local SQLite.
	conn.SetMaxOpenConns(4)
	conn.SetMaxIdleConns(2)
	conn.SetConnMaxIdleTime(5 * time.Second)
	conn.SetConnMaxLifetime(5 * time.Minute)

	if err := conn.Ping(); err != nil {
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	db := &DB{Conn: conn}

	if err := db.runMigrations(migrationsFS); err != nil {
		return nil, fmt.Errorf("failed to run migrations: %w", err)
	}

	log.Println("[database] connected and migrations applied")
	return db, nil
}

func (db *DB) Close() error {
	return db.Conn.Close()
}

// runMigrations applies SQL files from migrationsFS in alphabetical order.
// Uses schema_migrations table to track which files have been applied.
func (db *DB) runMigrations(migrationsFS fs.FS) error {
	if _, err := db.Conn.Exec(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			filename TEXT PRIMARY KEY,
			applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`); err != nil {
		return fmt.Errorf("failed to create schema_migrations table: %w", err)
	}

	entries, err := fs.ReadDir(migrationsFS, ".")
	if err != nil {
		return fmt.Errorf("failed to read migrations directory: %w", err)
	}

	var sqlFiles []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".sql") {
			sqlFiles = append(sqlFiles, entry.Name())
		}
	}

	sort.Strings(sqlFiles)

	applied := make(map[string]bool)
	rows, err := db.Conn.Query("SELECT filename FROM schema_migrations")
	if err != nil {
		return fmt.Errorf("failed to query schema_migrations: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return fmt.Errorf("failed to scan migration row: %w", err)
		}
		applied[name] = true
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("failed to iterate migration rows: %w", err)
	}

	// Bootstrap: if schema_migrations is empty but tables already exist,
	// mark all migrations as applied to avoid re-running ALTER TABLE etc.
	if len(applied) == 0 {
		var tableCount int
		if err := db.Conn.QueryRow(
			"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'",
		).Scan(&tableCount); err != nil {
			return fmt.Errorf("failed to check existing tables: %w", err)
		}

		if tableCount > 0 {
			for _, file := range sqlFiles {
				if _, err := db.Conn.Exec(
					"INSERT INTO schema_migrations (filename) VALUES (?)", file,
				); err != nil {
					return fmt.Errorf("failed to bootstrap migration %s: %w", file, err)
				}
				applied[file] = true
			}
			log.Printf("[database] bootstrapped %d existing migrations", len(sqlFiles))
			return nil
		}
	}

	for _, file := range sqlFiles {
		if applied[file] {
			continue
		}

		content, err := fs.ReadFile(migrationsFS, file)
		if err != nil {
			return fmt.Errorf("failed to read migration %s: %w", file, err)
		}

		if err := db.execStatements(file, string(content)); err != nil {
			return err
		}

		if _, err := db.Conn.Exec(
			"INSERT INTO schema_migrations (filename) VALUES (?)", file,
		); err != nil {
			return fmt.Errorf("failed to record migration %s: %w", file, err)
		}

		log.Printf("[database] migration applied: %s", file)
	}

	return nil
}

// execStatements runs each SQL statement individually, skipping recoverable errors
// (e.g. "duplicate column name" from a partially applied migration).
//
// PRAGMA statements are skipped entirely: connection-level settings
// (foreign_keys, journal_mode, busy_timeout) are already passed via the SQLite
// DSN, and remote libSQL/Turso rejects PRAGMAs with HTTP 400 because the
// server manages those settings itself.
func (db *DB) execStatements(filename, content string) error {
	statements := splitStatements(content)

	for i, stmt := range statements {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" {
			continue
		}

		// Detect "is this a PRAGMA?" by peeking past leading "--" comment lines.
		// We can't just strings.HasPrefix(stmt, "PRAGMA") because the migration
		// files put descriptive comments before each PRAGMA.
		core := stmt
		for strings.HasPrefix(core, "--") {
			nl := strings.IndexByte(core, '\n')
			if nl < 0 {
				core = ""
				break
			}
			core = strings.TrimSpace(core[nl+1:])
		}
		if core == "" {
			// All-comment chunk. This happens when splitStatements hits a `;`
			// that's actually inside a SQL comment (it doesn't track `--`),
			// e.g. "-- ...returns 0 rows;\n-- ..." in migration 018. We can't
			// fix the splitter without rewriting it, but we can detect the
			// resulting empty-statement chunk here. go-libsql rejects empty
			// statements with "API misuse: no SQL statement provided".
			log.Printf("[database] %s: statement %d skipped (comment-only)", filename, i+1)
			continue
		}

		if strings.HasPrefix(strings.ToUpper(core), "PRAGMA") {
			log.Printf("[database] %s: statement %d skipped (PRAGMA — set via DSN / managed by libSQL server)", filename, i+1)
			continue
		}

		if _, err := db.Conn.Exec(stmt); err != nil {
			errMsg := err.Error()
			recoverable := false
			for _, pattern := range recoverableErrors {
				if strings.Contains(errMsg, pattern) {
					recoverable = true
					break
				}
			}

			if recoverable {
				log.Printf("[database] %s: statement %d skipped (recoverable: %s)", filename, i+1, errMsg)
				continue
			}

			return fmt.Errorf("failed to execute migration %s (statement %d): %w", filename, i+1, err)
		}
	}

	return nil
}

// splitStatements splits SQL by semicolons, respecting string literals,
// BEGIN...END blocks (for triggers), and -- line comments. Without comment
// awareness, a literal ';' inside a "-- ..." comment would cut a statement
// in half, which broke migration 018 ("...nothing is migrated; the first
// user to register will...").
func splitStatements(sql string) []string {
	var statements []string
	var current strings.Builder
	inString := false
	inLineComment := false
	beginDepth := 0

	for i := 0; i < len(sql); i++ {
		ch := sql[i]

		// Line comment ends at the next newline. We still emit the bytes so
		// migrations keep their inline documentation in error messages.
		if inLineComment {
			current.WriteByte(ch)
			if ch == '\n' {
				inLineComment = false
			}
			continue
		}

		if !inString && ch == '-' && i+1 < len(sql) && sql[i+1] == '-' {
			inLineComment = true
			current.WriteByte(ch)
			continue
		}

		if ch == '\'' {
			if inString && i+1 < len(sql) && sql[i+1] == '\'' {
				current.WriteByte(ch)
				current.WriteByte(sql[i+1])
				i++
				continue
			}
			inString = !inString
		}

		if !inString {
			if matchKeyword(sql, i, "BEGIN") {
				beginDepth++
			}
			if matchKeyword(sql, i, "END") && beginDepth > 0 {
				beginDepth--
			}
		}

		if ch == ';' && !inString && beginDepth == 0 {
			s := strings.TrimSpace(current.String())
			if s != "" {
				statements = append(statements, s)
			}
			current.Reset()
			continue
		}

		current.WriteByte(ch)
	}

	s := strings.TrimSpace(current.String())
	if s != "" {
		statements = append(statements, s)
	}

	return statements
}

// matchKeyword checks for a case-insensitive keyword at the given position
// with word-boundary checks on both sides.
func matchKeyword(sql string, pos int, keyword string) bool {
	if pos+len(keyword) > len(sql) {
		return false
	}
	if pos > 0 && isIdentChar(sql[pos-1]) {
		return false
	}
	for j := 0; j < len(keyword); j++ {
		c := sql[pos+j]
		if c >= 'a' && c <= 'z' {
			c -= 32
		}
		if c != keyword[j] {
			return false
		}
	}
	afterIdx := pos + len(keyword)
	if afterIdx < len(sql) && isIdentChar(sql[afterIdx]) {
		return false
	}
	return true
}

func isIdentChar(b byte) bool {
	return (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') || (b >= '0' && b <= '9') || b == '_'
}
