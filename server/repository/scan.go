package repository

import (
	"database/sql"
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
