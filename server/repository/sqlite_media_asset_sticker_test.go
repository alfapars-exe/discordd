package repository

import (
	"context"
	"testing"
)

// TestIsPublicAsset_ServerStickers — both sticker file columns are public
// while the row exists and stop being public the moment it is deleted (no
// "stickers/" prefix rule); emoji rows stay public (regression).
func TestIsPublicAsset_ServerStickers(t *testing.T) {
	db := newTestDB(t)
	seedEmojiWorld(t, db)
	stickers := NewSQLiteStickerRepo(wrapForRepo(db))
	emojis := NewSQLiteEmojiRepo(wrapForRepo(db))
	assets := NewSQLiteMediaAssetRepo(wrapForRepo(db))
	ctx := context.Background()

	s := newSticker("aaaaaaaaaaaaaaaa", emojiSrvA, "kedi", true, dmAlice)
	mustCreateSticker(t, stickers, s)
	e := newEmoji("bbbbbbbbbbbbbbbb", emojiSrvA, "kedi", true, dmAlice)
	mustCreateEmoji(t, emojis, e)

	check := func(url string, want bool) {
		t.Helper()
		got, err := assets.IsPublicAsset(ctx, url)
		if err != nil {
			t.Fatalf("IsPublicAsset(%q): %v", url, err)
		}
		if got != want {
			t.Errorf("IsPublicAsset(%q) = %v, want %v", url, got, want)
		}
	}
	check(s.URL, true)
	check(*s.AnimatedURL, true)
	check("/api/uploads/stickers/cccccccccccccccc.png", false)
	check(e.URL, true)
	check(*e.AnimatedURL, true)

	if err := stickers.Delete(ctx, emojiSrvA, s.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	check(s.URL, false)
	check(*s.AnimatedURL, false)
	check(e.URL, true)
}
