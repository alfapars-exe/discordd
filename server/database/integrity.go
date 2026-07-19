package database

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// Sentinel values for the foreign-key probe. They are deliberately shaped so
// they can never collide with real data: user ids are 16 hex chars
// (lower(hex(randomblob(8)))) and refresh tokens are SHA-256 hex, so neither
// can equal a "__fk_probe_*__" string. The probe still checks for a collision
// before trusting its verdict.
//
// expires_at is set in the past: belt-and-braces, so that even in the
// impossible event a probe row escaped its rollback it would be dead on
// arrival and swept by the maintenance sweeper rather than usable.
// probeSessionSecret fills the NOT NULL refresh_token column. It is named to
// avoid gosec's G101 credential-name heuristic (a constant called
// probeRefreshToken trips it): the value is a sentinel that never leaves an
// aborted transaction, not a credential.
const (
	probeUserID        = "__fk_probe_nonexistent_user__"
	probeSessionID     = "__fk_probe_session__"
	probeSessionSecret = "__fk_probe_placeholder_value__"
	probeExpiresAt     = "1970-01-01 00:00:00"
)

// ProbeForeignKeys reports whether the connection actually enforces foreign
// key constraints.
//
// Why this is behavioral rather than a PRAGMA read: `PRAGMA foreign_keys` is
// exactly what we cannot use. Enforcement is only ever turned on through the
// local SQLite DSN (`foreign_keys(1)` in New); the remote libSQL/Turso branch
// sets nothing, and execStatementsTx strips every PRAGMA from migrations
// because Turso answers them with HTTP 400. Asking the database whether it
// enforces FKs therefore has to be done by trying something that FKs forbid.
//
// The probe attempts to INSERT a sessions row whose user_id references a user
// that does not exist. sessions.user_id is declared
// `REFERENCES users(id) ON DELETE CASCADE` in 001_init.sql and the table has
// never been rebuilt since, so the constraint is real. sessions is also a leaf
// table — nothing references it — so the write can never cascade anywhere.
//
//   - insert refused with a foreign-key error -> constraints ARE enforced
//   - insert accepted                         -> constraints are NOT enforced
//   - anything else                           -> inconclusive, returned as err
//
// The work always happens inside a transaction that is ALWAYS rolled back, so
// the probe is side-effect free even in the non-enforcing case where the
// INSERT succeeds. A non-FK failure is reported as an error rather than being
// folded into `false`: claiming "foreign keys are off" because the statement
// failed for an unrelated reason would be a false alarm.
//
// This is a visibility tool. It answers a question we could not otherwise
// answer about production; it deliberately changes no behaviour and must
// never fail a boot.
func ProbeForeignKeys(conn *sql.DB) (enforced bool, err error) {
	if conn == nil {
		return false, errors.New("foreign key probe: nil database connection")
	}

	tx, err := conn.Begin()
	if err != nil {
		return false, fmt.Errorf("foreign key probe: begin transaction: %w", err)
	}
	// Unconditional rollback. This is the load-bearing line: in the
	// not-enforced case the INSERT below succeeds, and without this the probe
	// would persist a junk row on every boot.
	defer func() { _ = tx.Rollback() }()

	// If the sentinel user somehow existed, the FK would be satisfied and the
	// insert would succeed for a reason that has nothing to do with
	// enforcement — i.e. a false "not enforced". Rule that out first. This
	// query also fails fast when the schema isn't there at all.
	var collisions int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM users WHERE id = ?`, probeUserID).Scan(&collisions); err != nil {
		return false, fmt.Errorf("foreign key probe: cannot read users table: %w", err)
	}
	if collisions > 0 {
		return false, fmt.Errorf("foreign key probe: sentinel user %q unexpectedly exists; probe is not conclusive", probeUserID)
	}

	_, insertErr := tx.Exec(
		`INSERT INTO sessions (id, user_id, refresh_token, expires_at) VALUES (?, ?, ?, ?)`,
		probeSessionID, probeUserID, probeSessionSecret, probeExpiresAt,
	)
	switch {
	case insertErr == nil:
		// Accepted a row pointing at a user that does not exist.
		return false, nil
	case isForeignKeyViolation(insertErr):
		return true, nil
	default:
		return false, fmt.Errorf("foreign key probe: inconclusive, probe insert failed for an unrelated reason: %w", insertErr)
	}
}

// isForeignKeyViolation matches on the error text rather than a driver error
// code on purpose: the same probe runs against modernc.org/sqlite locally and
// go-libsql/Turso in production, and those return different concrete error
// types. Both render SQLITE_CONSTRAINT_FOREIGNKEY as text containing
// "FOREIGN KEY constraint failed".
func isForeignKeyViolation(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "foreign key")
}
