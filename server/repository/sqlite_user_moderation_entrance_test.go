package repository

import (
	"context"
	"slices"
	"testing"

	"github.com/argeinfina/hichat/models"
)

// TestHardDeleteUser_RemovesEntranceRows — deleting bob removes his clips,
// selections and the mutes naming him (all three tables are unenforced
// cascades on Turso); alice's rows are untouched. GetOwnedServerFileURLs,
// called before the delete, includes bob's clip URLs so the service can
// remove the files after the commit.
func TestHardDeleteUser_RemovesEntranceRows(t *testing.T) {
	db := newTestDB(t)
	seedEntranceWorld(t, db)
	entrance := NewSQLiteEntranceRepo(wrapForRepo(db))
	users := NewSQLiteUserRepo(db.Conn)
	ctx := context.Background()

	bobClip := newEntranceSound("b000000000000001", dmBob)
	aliceClip := newEntranceSound("a000000000000001", dmAlice)
	mustCreateEntranceSound(t, entrance, bobClip)
	mustCreateEntranceSound(t, entrance, aliceClip)
	for _, sel := range []models.EntranceSelectionRow{
		{UserID: dmBob, Kind: models.EntranceKindClip, SoundID: &bobClip.ID},
		{UserID: dmAlice, Kind: models.EntranceKindClip, SoundID: &aliceClip.ID},
	} {
		if err := entrance.UpsertSelection(ctx, &sel); err != nil {
			t.Fatalf("UpsertSelection: %v", err)
		}
	}
	if err := entrance.SetMute(ctx, emojiSrvB, dmBob, true); err != nil {
		t.Fatalf("SetMute bob: %v", err)
	}
	if err := entrance.SetMute(ctx, emojiSrvB, dmAlice, true); err != nil {
		t.Fatalf("SetMute alice: %v", err)
	}

	urls, err := users.GetOwnedServerFileURLs(ctx, dmBob)
	if err != nil {
		t.Fatalf("GetOwnedServerFileURLs: %v", err)
	}
	if !slices.Contains(urls, bobClip.URL) || slices.Contains(urls, aliceClip.URL) {
		t.Errorf("GetOwnedServerFileURLs(bob) = %v, want bob's clip and not alice's", urls)
	}

	if err := users.HardDeleteUser(ctx, dmBob, dmCarol); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}
	for _, q := range []string{
		`SELECT COUNT(*) FROM user_entrance_sounds WHERE user_id = ?`,
		`SELECT COUNT(*) FROM user_entrance_selection WHERE user_id = ?`,
		`SELECT COUNT(*) FROM server_entrance_mutes WHERE user_id = ?`,
	} {
		if n := countRows(t, db, q, dmBob); n != 0 {
			t.Errorf("%q = %d after hard delete, want 0", q, n)
		}
		if n := countRows(t, db, q, dmAlice); n != 1 {
			t.Errorf("%q for alice = %d, want 1 (untouched)", q, n)
		}
	}
}
