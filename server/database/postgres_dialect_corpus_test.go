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

// UPDATE RETURNING is used by role PATCH; DELETE IN (SELECT ...) is used by
// server cascade cleanup. Exercise matching and non-matching tenant predicates.
func checkRepositoryMutationFamilies(t *testing.T, tx *sql.Tx) {
	t.Helper()
	for _, target := range []string{"b", "missing"} {
		var got string
		err := tx.QueryRow(`UPDATE dialect_grant SET note=? WHERE owner=? AND target=? RETURNING target`, "patched ? literal", "owner", target).Scan(&got)
		if target == "missing" {
			if err != sql.ErrNoRows {
				t.Fatalf("missing RETURNING: %q, %v", got, err)
			}
		} else if err != nil || got != target {
			t.Fatalf("matched RETURNING: %q, %v", got, err)
		}
	}
	var note string
	if err := tx.QueryRow(`SELECT note FROM dialect_grant WHERE owner=? AND target=?`, "owner", "b").Scan(&note); err != nil || note != "patched ? literal" {
		t.Fatalf("bound update value: %q, %v", note, err)
	}
	for _, owner := range []string{"other-owner", "owner"} {
		result, err := tx.Exec(`DELETE FROM dialect_grant WHERE owner=? AND target IN (
   SELECT target FROM dialect_grant WHERE owner=? AND target=?)`, owner, "owner", "b")
		if err != nil {
			t.Fatal(err)
		}
		want := int64(0)
		if owner == "owner" {
			want = 1
		}
		if got, err := result.RowsAffected(); err != nil || got != want {
			t.Fatalf("cascade owner %q: affected %d, want %d: %v", owner, got, want, err)
		}
	}
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM dialect_grant WHERE owner=?`, "owner").Scan(&count); err != nil || count != 2 {
		t.Fatalf("remaining tenant rows: %d, %v", count, err)
	}
}
