package database

import (
	"context"
	"database/sql"
	"reflect"
	"strings"
	"testing"
)

// Representative portable query families used by repository history cursors,
// dynamic bulk lists and nullable joins. This is not a complete SQL inventory.
func checkRepositoryCursorAndListFamilies(t *testing.T, tx *sql.Tx, first, next string) {
	t.Helper()
	keys := []string{"a", "' OR 1=1 --"}
	markers := strings.TrimSuffix(strings.Repeat("?,", len(keys)), ",")
	for _, tc := range []struct {
		name, query string
		args        []any
		want        []string
	}{
		{"forward_tuple_cursor", `SELECT target FROM dialect_grant WHERE (updated_at,target)>(?,?) ORDER BY updated_at,target LIMIT ?`, []any{first, "b", 1}, []string{"c"}},
		{"backward_tuple_cursor", `SELECT target FROM dialect_grant WHERE (updated_at,target)<(?,?) ORDER BY updated_at DESC,target DESC LIMIT ?`, []any{next, "a", 1}, []string{"c"}},
		{"bound_dynamic_list", "SELECT target FROM dialect_grant WHERE target IN (" + markers + ") ORDER BY target", []any{keys[0], keys[1]}, []string{"a"}},
		{"nullable_left_join", `SELECT source.target FROM dialect_grant source LEFT JOIN dialect_grant missing ON missing.target=? WHERE missing.target IS NULL AND source.note IS NULL ORDER BY source.target`, []any{"absent"}, []string{"a"}},
		{"empty_cursor_result", `SELECT target FROM dialect_grant WHERE (updated_at,target)>(?,?) ORDER BY updated_at,target`, []any{next, "z"}, []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows, err := tx.QueryContext(context.Background(), tc.query, tc.args...)
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			got := []string{}
			for rows.Next() {
				var value string
				if err := rows.Scan(&value); err != nil {
					t.Fatal(err)
				}
				got = append(got, value)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("rows %q, want %q", got, tc.want)
			}
		})
	}
}
