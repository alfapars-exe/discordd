package repository

import (
	"context"
	"testing"
)

// TestRemoveReaction_DeleteOnly — RemoveReaction deletes only the caller's
// own matching row, reports whether one matched, and never inserts.
func TestRemoveReaction_DeleteOnly(t *testing.T) {
	db, path := newTestDBWithPath(t)
	ctx := context.Background()
	// Planted with FKs off: the message rows themselves are irrelevant here.
	execWithoutFKs(t, path,
		`INSERT INTO reactions (id, message_id, user_id, emoji) VALUES ('r1', 'm1', 'u1', '<:fedcba9876543210>')`,
		`INSERT INTO reactions (id, message_id, user_id, emoji) VALUES ('r2', 'm1', 'u2', '<:fedcba9876543210>')`,
		`INSERT INTO dm_reactions (id, dm_message_id, user_id, emoji) VALUES ('d1', 'dm1', 'u1', '<:fedcba9876543210>')`,
	)

	channel := NewSQLiteReactionRepo(wrapForRepo(db))
	dm := NewSQLiteDMRepo(wrapForRepo(db))

	for _, tc := range []struct {
		name   string
		remove func(user string) (bool, error)
		count  func(user string) int
	}{
		{"channel",
			func(u string) (bool, error) { return channel.RemoveReaction(ctx, "m1", u, "<:fedcba9876543210>") },
			func(u string) int {
				return countRows(t, db, `SELECT COUNT(*) FROM reactions WHERE message_id = 'm1' AND user_id = ?`, u)
			}},
		{"dm",
			func(u string) (bool, error) { return dm.RemoveReaction(ctx, "dm1", u, "<:fedcba9876543210>") },
			func(u string) int {
				return countRows(t, db, `SELECT COUNT(*) FROM dm_reactions WHERE dm_message_id = 'dm1' AND user_id = ?`, u)
			}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if removed, err := tc.remove("u3"); err != nil || removed {
				t.Errorf("remove(never reacted) = (%v, %v), want (false, nil)", removed, err)
			}
			if tc.count("u3") != 0 {
				t.Error("RemoveReaction inserted a row")
			}
			if removed, err := tc.remove("u1"); err != nil || !removed {
				t.Errorf("remove(own) = (%v, %v), want (true, nil)", removed, err)
			}
			if tc.count("u1") != 0 {
				t.Error("own reaction still present")
			}
			if removed, _ := tc.remove("u1"); removed {
				t.Error("second remove reported a removal")
			}
		})
	}
	if n := countRows(t, db, `SELECT COUNT(*) FROM reactions WHERE user_id = 'u2'`); n != 1 {
		t.Error("another user's reaction was removed")
	}
}
