package repository

import (
	"context"
	"testing"
)

// TestHardDeleteUser_ClearsEmojiCreator — bob created an emoji in alice's
// server B; deleting bob keeps the emoji but clears created_by to NULL (not
// reassigned to the admin, Karar D-14).
func TestHardDeleteUser_ClearsEmojiCreator(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	emojis := NewSQLiteEmojiRepo(wrapForRepo(db))
	mustCreateEmoji(t, emojis, newEmoji("aaaaaaaaaaaaaaa1", emojiSrvB, "bobun", false, dmBob))
	mustCreateEmoji(t, emojis, newEmoji("aaaaaaaaaaaaaaa2", emojiSrvB, "alicein", false, dmAlice))

	if err := NewSQLiteUserRepo(db.Conn).HardDeleteUser(context.Background(), dmBob, dmCarol); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}

	got, err := emojis.GetByID(context.Background(), "aaaaaaaaaaaaaaa1")
	if err != nil {
		t.Fatalf("emoji gone after its creator was deleted: %v", err)
	}
	if got.CreatedBy != nil {
		t.Errorf("created_by = %q, want NULL (not reassigned)", *got.CreatedBy)
	}
	other, _ := emojis.GetByID(context.Background(), "aaaaaaaaaaaaaaa2")
	if other == nil || other.CreatedBy == nil || *other.CreatedBy != dmAlice {
		t.Errorf("another creator's emoji was touched: %+v", other)
	}
}
