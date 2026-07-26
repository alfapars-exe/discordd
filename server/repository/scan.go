package repository

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
)

// scanRows iterates every row through scan, collecting the results into a
// slice. It centralizes the rows.Next() / Scan() / rows.Close() / rows.Err()
// loop that was duplicated across the sqlite_*.go repositories.
//
// The caller supplies only the per-row scan closure; `entity` shapes the
// error messages to match the hand-written originals verbatim
// ("failed to scan <entity> row" / "error iterating <entity> rows"). Like the
// originals, no rows yields a nil slice (not an error).
func scanRows[T any](rows *sql.Rows, entity string, scan func(*sql.Rows) (T, error)) ([]T, error) {
	defer rows.Close()
	var out []T
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, fmt.Errorf("failed to scan %s row: %w", entity, err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("error iterating %s rows: %w", entity, err)
	}
	return out, nil
}

// generateID returns a random lowercase-hex identifier in the same shape
// SQLite's `lower(hex(randomblob(8)))` produces (8 random bytes -> 16 hex
// chars). Generating it in Go lets Create() use ExecContext instead of
// QueryRowContext+Scan on a RETURNING clause, which is the fragile part
// against Turso/libSQL's Hrana stream. Mirrors the pattern already used for
// invite codes in services/invite_service.go.
func generateID() (string, error) { return generateIDN(8) }

// generateIDN is generateID for a caller that needs a different width — e.g. a
// 16-byte (32-char) id matching lower(hex(randomblob(16))). Same Turso/Hrana
// rationale as generateID.
func generateIDN(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate id: %w", err)
	}
	return hex.EncodeToString(b), nil
}
