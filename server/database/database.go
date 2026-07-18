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

	_ "modernc.org/sqlite" // pure-Go SQLite driver for local files (registers "sqlite")
	// Remote libSQL/Turso driver is imported in database_libsql.go under a
	// non-Windows build tag — go-libsql requires CGO and is not buildable
	// on Windows without a C toolchain. Local SQLite still works via the
	// pure-Go driver above, so tests can run cross-platform.
)

// recoverableErrors lists error patterns that can be safely skipped
// when re-running a partially applied migration (e.g. "duplicate column name").
var recoverableErrors = []string{
	"duplicate column name",
}

type DB struct {
	Conn *sql.DB
}

// IsRemoteLibSQL reports whether the DSN points to a remote libSQL/Turso server
// rather than a local SQLite file. URLs starting with libsql://, http://, https://,
// ws://, or wss:// are treated as remote.
//
// Exported so callers outside this package (e.g. backup_service) can skip
// behaviours that only make sense for a local file path — for instance,
// restore-on-boot is a no-op for remote DBs because Turso is already
// persistent and the local /data/hichat.db is never read.
func IsRemoteLibSQL(dsn string) bool {
	for _, prefix := range []string{"libsql://", "https://", "http://", "wss://", "ws://"} {
		if strings.HasPrefix(dsn, prefix) {
			return true
		}
	}
	return false
}

// RedactDSN masks the credential in a DSN — the Turso/libSQL `authToken=<jwt>`
// query parameter — so the DSN is safe to log. Connection strings routinely
// embed secrets; logging one raw leaks read-write database credentials into the
// container logs, where anyone with log access then has full DB access. Always
// pass a DSN through this before printing it.
func RedactDSN(dsn string) string {
	i := strings.Index(dsn, "authToken=")
	if i < 0 {
		return dsn
	}
	rest := dsn[i+len("authToken="):]
	if amp := strings.IndexByte(rest, '&'); amp >= 0 {
		return dsn[:i] + "authToken=***" + rest[amp:]
	}
	return dsn[:i] + "authToken=***"
}

// New opens a database connection and runs pending migrations.
// Supports both local SQLite (file path) and remote Turso/libSQL (libsql://...).
func New(dbPath string, migrationsFS fs.FS) (*DB, error) {
	var conn *sql.DB
	var err error

	if IsRemoteLibSQL(dbPath) {
		// Turso/libSQL remote — connection-level pragmas don't apply (server manages WAL).
		conn, err = sql.Open("libsql", dbPath)
		if err != nil {
			return nil, fmt.Errorf("failed to open libsql database: %w", err)
		}
		log.Printf("[database] using remote libSQL backend")
	} else {
		// Local SQLite file — ensure parent directory exists. 0750 keeps
		// the DB file's parent directory closed to "other" on the host so
		// a sibling user account can't enumerate or copy mqvi.db without
		// privilege escalation. (The DB file itself is created by SQLite
		// with its own restrictive perms.)
		dir := filepath.Dir(dbPath)
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("failed to create database directory: %w", err)
		}

		// SQLite tuning for Discord-class workloads:
		//   - foreign_keys=on: SQLite ships with FKs disabled; we always want them on.
		//   - journal_mode=WAL: concurrent readers + single writer; massively better
		//     than default rollback journal for chat workloads.
		//   - busy_timeout=5000: writers retry for up to 5s before SQLITE_BUSY surfaces,
		//     so brief lock contention during heartbeat broadcasts doesn't fail requests.
		//   - synchronous=NORMAL: with WAL, NORMAL is the SQLite-recommended balance
		//     between durability and throughput. The full FULL mode fsyncs on every
		//     commit (slow); NORMAL fsyncs on checkpoint and keeps power-loss safety.
		//   - cache_size=-65536: 64 MiB page cache. Hot rows (recent messages, active
		//     sessions, channel index) live in memory instead of bouncing to disk.
		//     Negative value = KiB; ~5x default.
		//   - temp_store=MEMORY: spill temp tables to RAM not disk. Helps FTS5 queries.
		conn, err = sql.Open("sqlite", dbPath+
			"?_pragma=foreign_keys(1)"+
			"&_pragma=journal_mode(WAL)"+
			"&_pragma=busy_timeout(5000)"+
			"&_pragma=synchronous(NORMAL)"+
			"&_pragma=cache_size(-65536)"+
			"&_pragma=temp_store(MEMORY)")
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

		if err := db.applyMigrationFile(file, string(content)); err != nil {
			return err
		}

		log.Printf("[database] migration applied: %s", file)
	}

	return nil
}

// applyMigrationFile runs all statements in a single transaction so a
// half-applied migration can never persist. Either every statement +
// the schema_migrations row commits together, or the file is rolled back
// and the next boot retries from scratch. Previously each statement ran
// individually and the schema_migrations record was a separate Exec —
// a failure in statement N left statements 1..N-1 visible without ever
// marking the file applied, so subsequent boots re-ran the prefix and
// either tripped "duplicate column name" forever or, worse, double-
// applied non-idempotent INSERTs.
//
// PRAGMA statements are skipped (set via DSN / managed by libSQL),
// matching the prior behaviour. Comment-only chunks emitted by the
// splitter are also skipped.
func (db *DB) applyMigrationFile(filename, content string) error {
	tx, err := db.Conn.Begin()
	if err != nil {
		return fmt.Errorf("failed to begin transaction for migration %s: %w", filename, err)
	}
	// Defensive rollback — Commit nils tx, so this is a no-op on success.
	// On any early return below, the tx is cleaned up here.
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	if err := execStatementsTx(tx, filename, content); err != nil {
		return err
	}

	if _, err := tx.Exec(
		"INSERT INTO schema_migrations (filename) VALUES (?)", filename,
	); err != nil {
		return fmt.Errorf("failed to record migration %s: %w", filename, err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit migration %s: %w", filename, err)
	}
	committed = true
	return nil
}

// execStatementsTx runs each SQL statement inside the provided transaction.
// Recoverable errors (e.g. "duplicate column name" from a partially applied
// migration on a pre-transactional install) are still tolerated as a
// defensive fallback for upgrade paths — but with full transactional
// commits going forward, partial application shouldn't recur.
//
// PRAGMA statements are skipped: connection-level settings (foreign_keys,
// journal_mode, busy_timeout) are already passed via the SQLite DSN, and
// remote libSQL/Turso rejects PRAGMAs with HTTP 400 because the server
// manages those settings itself.
func execStatementsTx(tx *sql.Tx, filename, content string) error {
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

		if _, err := tx.Exec(stmt); err != nil {
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
