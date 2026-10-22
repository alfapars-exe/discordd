package repository

import (
	"context"
	"testing"
)

// TestHardDeleteUser_ClearsStickerCreator — bob created a sticker in
// alice's server B; deleting bob keeps the sticker but clears created_by to
// NULL (not reassigned, Karar D2-11).
func TestHardDeleteUser_ClearsStickerCreator(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	stickers := NewSQLiteStickerRepo(wrapForRepo(db))
	mustCreateSticker(t, stickers, newSticker("aaaaaaaaaaaaaaa1", emojiSrvB, "bobun", false, dmBob))
	mustCreateSticker(t, stickers, newSticker("aaaaaaaaaaaaaaa2", emojiSrvB, "alicein", false, dmAlice))

	if err := NewSQLiteUserRepo(db.Conn).HardDeleteUser(context.Background(), dmBob, dmCarol); err != nil {
		t.Fatalf("HardDeleteUser: %v", err)
	}

	got, err := stickers.GetByID(context.Background(), "aaaaaaaaaaaaaaa1")
	if err != nil {
		t.Fatalf("sticker gone after its creator was deleted: %v", err)
	}
	if got.CreatedBy != nil {
		t.Errorf("created_by = %q, want NULL (not reassigned)", *got.CreatedBy)
	}
	other, _ := stickers.GetByID(context.Background(), "aaaaaaaaaaaaaaa2")
	if other == nil || other.CreatedBy == nil || *other.CreatedBy != dmAlice {
		t.Errorf("another creator's sticker was touched: %+v", other)
	}
}
